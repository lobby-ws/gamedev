import { createPublicClient, createWalletClient, erc20Abi, getContract, http } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import * as utils from 'viem/utils'
import * as chains from 'viem/chains'
import * as hl from '@nktkas/hyperliquid'
import { uuid } from '../utils'
import { System } from './System'

export class EVM extends System {
  constructor(world) {
    super(world)
    this.callbacks = {}
    this.evm = null
    this.hlClient = null
    this.hlPublicClient = null

    const chainName = process.env.PUBLIC_EVM ?? 'mainnet'
    const chain = chains[chainName]

    if (!chain) throw new Error('invalid chain string')

    if (world.network.isServer) {
      const account = mnemonicToAccount(process.env.EVM_SEED_PHRASE)

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

      // Initialize Hyperliquid clients
      try {
        const hlTransport = new hl.HttpTransport()
        
        // Public client for querying data
        this.hlPublicClient = new hl.PublicClient({ transport: hlTransport })
        
        // Wallet client for transactions, using the same account as EVM
        this.hlClient = new hl.WalletClient({ 
          wallet: account,
          transport: hlTransport 
        })
        
        console.log('[evm] Hyperliquid clients initialized on server')
      } catch (err) {
        console.error('[evm] Failed to initialize Hyperliquid clients:', err)
      }
    }
  }

  start() {
    this.world.network.on('depositResponse', this.onDepositResponse.bind(this))
  }

  stop() {
    this.world.network.off('depositResponse', this.onDepositResponse.bind(this))
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

  /**
   * Deposits funds from player to the server/world account
   * @param {Object} entity - The entity initiating the deposit
   * @param {Object} player - The player making the deposit
   * @param {Number} amount - The amount to deposit
   * @returns {Promise<Object>} - Transaction result
   */
  deposit(entity, player, amount) {
    return new Promise(async (resolve, reject) => {
      const hook = entity.getDeadHook()
      try {
        const playerAddress = player.data.evm
        if (!playerAddress) return reject('not_connected')
        if (typeof amount !== 'number' || amount <= 0) return reject('amount_invalid')
        if (!this.hlClient) return reject('hyperliquid_not_initialized')

        // Create transaction data for client to sign
        const txData = {
          destination: process.env.HL_WORLD_ADDRESS || this.wallet.account.address,
          amount: amount.toString()
        }

        // Serialize the transaction data
        const serializedTx = JSON.stringify(txData)

        // Stop if entity is dead
        if (hook.dead) return

        // Setup callback to handle response
        const depositId = uuid()
        this.callbacks[depositId] = async (data) => {
          delete this.callbacks[depositId]
          if (hook.dead) return

          if (data.success) {
            resolve({
              txId: data.txId,
              result: JSON.parse(data.result)
            })
          } else {
            reject(data.error || 'transaction_failed')
          }
        }

        // Send to player to sign and execute
        this.world.network.sendTo(player.data.id, 'depositRequest', { depositId, serializedTx })
      } catch (err) {
        if (hook.dead) return
        console.error('[hl] Deposit preparation failed:', err)
        reject('failed')
      }
    })
  }

  onDepositResponse(data) {
    this.callbacks[data.depositId]?.(data)
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
    
    if (typeof amount !== 'number' || amount <= 0) {
      throw new Error('Amount must be a positive number')
    }
    
    if (!this.hlClient) {
      throw new Error('Hyperliquid client not initialized')
    }
    
    try {
      console.log(`[hl] Transferring ${amount} USDC to player ${player.data.id} (${playerAddress})`)
      
      // Execute transfer from server wallet to player
      const result = await this.hlClient.usdSend({
        destination: playerAddress,
        amount: amount.toString()
      })
      
      console.log(`[hl] Transfer successful: ${result?.txId}`)
      return {
        txId: result?.txId,
        result
      }
    } catch (err) {
      console.error('[hl] Transfer failed:', err)
      throw err
    }
  }
}
