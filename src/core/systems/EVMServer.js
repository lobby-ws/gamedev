import { createPublicClient, createWalletClient, erc20Abi, getContract, http } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import * as utils from 'viem/utils'
import * as chains from 'viem/chains'
import * as hl from '@nktkas/hyperliquid'
import { uuid } from '../utils'
import { System } from './System'

const DEPOSIT_TIMEOUT_MS = 2 * 60 * 1000
const resolveHlIsTestnet = () => {
  const envValue = process.env.HL_IS_TESTNET
  if (envValue === undefined) return true
  const normalized = envValue.toString().toLowerCase()
  return !(normalized === 'false' || normalized === '0' || normalized === 'off')
}

export class EVM extends System {
  constructor(world) {
    super(world)
    this.pendingDeposits = new Map()
    this.evm = null
    this.hlClient = null
    this.hlInfoClient = null
    this.hlTransport = null
    this.hlIsTestnet = resolveHlIsTestnet()
    this.hlAccount = null

    const chainName = process.env.PUBLIC_EVM ?? 'mainnet'
    const chain = chains[chainName]

    if (!chain) throw new Error('invalid chain string')

    if (world.network.isServer) {
      const account = mnemonicToAccount(process.env.EVM_SEED_PHRASE)
      this.hlAccount = account

      const wallet = createWalletClient({
        account,
        chain,
        transport: http(),
      })

      const client = createPublicClient({
        chain,
        transport: http(),
      })

      this.utils = utils
      this.actions = client
      this.wallet = wallet
      this.getContract = getContract
      this.abis = {
        erc20: erc20Abi,
        erc721: null,
      }
    }
  }

  async init() {
    if (!this.world.network?.isServer) return
    this.hlIsTestnet = resolveHlIsTestnet()
    this.initHyperliquidClients()
  }

  initHyperliquidClients() {
    if (!this.world.network?.isServer || !this.hlAccount) return
    try {
      const hlTransport = new hl.HttpTransport({ isTestnet: this.hlIsTestnet })
      this.hlTransport = hlTransport
      this.hlInfoClient = new hl.InfoClient({ transport: hlTransport })
      this.hlClient = new hl.ExchangeClient({
        wallet: this.hlAccount,
        transport: hlTransport,
      })
      console.log(`[evm] Hyperliquid clients initialized on server (${this.hlIsTestnet ? 'testnet' : 'mainnet'})`)
    } catch (err) {
      console.error('[evm] Failed to initialize Hyperliquid clients:', err)
    }
  }

  getDepositDestination() {
    const destination = this.hlAccount.address
    if (!destination) return null
    return destination
  }

  onEvmConnect(socket, address) {
    socket.player.data.evm = address
    socket.player.modify({ evm: address })
    this.world.network.send('entityModified', { id: socket.player.data.id, evm: address })
  }

  onEvmDisconnect(socket) {
    socket.player.data.evm = null
    socket.player.modify({ evm: null })
    this.world.network.send('entityModified', { id: socket.player.data.id, evm: null })
  }

  async deposit(player, amount, depositId = uuid()) {
    const playerAddress = player?.data?.evm
    if (!playerAddress) throw new Error('not_connected')
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount_invalid')
    if (!this.hlTransport) throw new Error('hyperliquid_not_initialized')
    if (this.pendingDeposits.has(depositId)) throw new Error('deposit_id_in_use')

    const destination = this.getDepositDestination()
    if (!destination) throw new Error('hl_world_address_missing')

    const amountString = amount.toString()
    const expectedChain = this.hlIsTestnet ? 'Testnet' : 'Mainnet'

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingDeposits.delete(depositId)
        reject(new Error('deposit_timeout'))
      }, DEPOSIT_TIMEOUT_MS)

      this.pendingDeposits.set(depositId, {
        playerId: player.data.id,
        amount: amountString,
        destination,
        expectedChain,
        resolve,
        reject,
        timeoutId,
      })

      this.world.network.sendTo(player.data.id, 'depositRequest', {
        depositId,
        destination,
        amount: amountString,
        isTestnet: this.hlIsTestnet,
      })
    })
  }

  async onDepositResponse(socket, data) {
    const { depositId, action, signature, nonce, error } = data || {}
    if (!depositId) throw new Error('deposit_id_missing')
    const pending = this.pendingDeposits.get(depositId)
    if (!pending) throw new Error('deposit_not_found')

    if (pending.playerId !== socket.player.data.id) {
      clearTimeout(pending.timeoutId)
      this.pendingDeposits.delete(depositId)
      pending.reject(new Error('deposit_owner_mismatch'))
      throw new Error('deposit_owner_mismatch')
    }

    clearTimeout(pending.timeoutId)
    this.pendingDeposits.delete(depositId)

    if (error) {
      pending.reject(new Error(error))
      throw new Error(error)
    }

    try {
      if (!action || action.type !== 'usdSend') {
        throw new Error('deposit_action_invalid')
      }
      if (!signature) {
        throw new Error('deposit_signature_missing')
      }

      const actionDestination = String(action.destination || '').toLowerCase()
      if (actionDestination !== pending.destination.toLowerCase()) {
        throw new Error('deposit_destination_mismatch')
      }

      if (String(action.amount) !== pending.amount) {
        throw new Error('deposit_amount_mismatch')
      }

      if (action.hyperliquidChain !== pending.expectedChain) {
        throw new Error('deposit_network_mismatch')
      }

      if (Number(action.time) !== Number(nonce)) {
        throw new Error('deposit_nonce_mismatch')
      }

      if (!this.hlTransport) {
        throw new Error('hyperliquid_not_initialized')
      }

      const response = await this.hlTransport.request('exchange', {
        action,
        signature,
        nonce,
      })

      pending.resolve(response)
      return response
    } catch (err) {
      pending.reject(err)
      throw err
    }
  }

  /**
   * Transfers USDC directly from the game/server wallet to a player
   * @param {Object} player - The player to send funds to
   * @param {Number} amount - The amount to transfer
   * @returns {Promise<Object>} - Transaction result
   */
  async transfer(player, amount) {
    if (!player) {
      throw new Error('Player is required')
    }

    const playerAddress = player.data.evm
    if (!playerAddress) {
      throw new Error('Player does not have a connected wallet')
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Amount must be a positive number')
    }

    if (!this.hlClient) {
      throw new Error('Hyperliquid client not initialized')
    }

    try {
      console.log(`[hl] Transferring ${amount} USDC to player ${player.data.id} (${playerAddress})`)

      const result = await this.hlClient.usdSend({
        destination: playerAddress,
        amount: amount.toString(),
      })

      console.log(`[hl] Transfer successful: ${result?.txId}`)
      return {
        txId: result?.txId,
        result,
      }
    } catch (err) {
      console.error('[hl] Transfer failed:', err)
      throw err
    }
  }
}
