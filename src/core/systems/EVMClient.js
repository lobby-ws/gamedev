import { System } from './System'
import { storage } from '../storage'
import * as hl from '@nktkas/hyperliquid'

const key = 'hyp:solana:auths'
const template = 'Connect to world:\n{address}'

export class EVM extends System {
  constructor(world) {
    super(world)
    this.auths = storage.get(key, []) // [...{ address, signature }]
    this.connected = false
    // Hyperliquid WalletClient instance
    this.hlClient = null
  }

  async bind({ connectors, connect, config, actions, abis, address, isConnected, isConnecting, disconnect }) {
    // console.log('bind', { isConnected, isConnecting })
    // {connectors, connect, config, actions, abis, address}
    this.actions = actions
    this.abis = abis
    this.connection = { connect, disconnect, connectors }
    // this.connectors = connectors
    // this.connect = connect
    this.config = config
    this.address = address
    // this.disconnect = disconnect
    if (isConnected && !this.connected) {
      this.connected = true
      this.world.network.send('evmConnect', address)
      this.createHyperliquidClient()
    }
    if (!isConnected && this.connected) {
      this.connected = false
      this.world.network.send('evmDisconnect')
    }
  }

  connect(player) {
    // console.log('connect', player.data.id !== this.world.network.id, this.connected)
    if (player && player.data.id !== this.world.network.id) {
      throw new Error('[solana] cannot connect a remote player from client')
    }
    if (this.connected) return
    this.connection.connect({ connector: this.connection.connectors[0] })
    this.connected = true
    // if (!this.wallet) return
    // if (this.wallet.connected) return
    // this.modal.setVisible(true)
  }

  disconnect(player) {
    if (player && player.data.id !== this.world.network.id) {
      throw new Error('[solana] cannot disconnect a remote player from client')
    }
    if (!this.connected) return
    this.connection.disconnect()
    this.connected = false
    // this.world.network.send('evmDisconnect')
  }

  deposit(playerId, amount) {
    throw new Error('[solana] deposit can only be called on the server')
  }

  withdraw(playerId, amount) {
    throw new Error('[solana] withdraw can only be called on the server')
  }

  async onDepositRequest({ depositId, serializedTx }) {
    try {
      if (!this.hlClient) {
        throw new Error('Hyperliquid client not initialized')
      }
      
      // Parse the transaction data
      const txData = JSON.parse(serializedTx)
      
      // Execute the transaction using the Hyperliquid client
      const result = await this.hlClient.usdSend(txData)
      
      // Send response back to server
      this.world.network.send('depositResponse', { 
        depositId, 
        success: true,
        txId: result?.txId || 'unknown',
        result: JSON.stringify(result)
      })
    } catch (error) {
      console.error('Failed to process deposit request:', error)
      this.world.network.send('depositResponse', { 
        depositId, 
        success: false,
        error: error.message
      })
    }
  }

  /**
   * Creates the Hyperliquid WalletClient instance if it does not already exist.
   * Relies on an injected EIP-1193 provider (window.ethereum) which is also
   * required by Wagmi for normal EVM connectivity.
   */
  createHyperliquidClient() {
    if (this.hlClient) return // Already created

    if (typeof window === 'undefined' || !window.ethereum) {
      console.warn('[evm] window.ethereum provider not found; Hyperliquid client not initialised.')
      return
    }

    try {
      const transport = new hl.HttpTransport()
      this.hlClient = new hl.WalletClient({ wallet: window.ethereum, transport })
    } catch (err) {
      console.error('[evm] Failed to initialize Hyperliquid WalletClient:', err)
    }
  }

  /**
   * Gets the clearinghouse state (balance) of the connected wallet
   * @returns {Promise<Object>} The clearinghouse state with USDC balance
   */
  async getBalance() {
    if (!this.address) {
      throw new Error('[evm] No wallet connected')
    }
    
    try {
      // Create a PublicClient to query account info
      const transport = new hl.HttpTransport()
      const publicClient = new hl.PublicClient({ transport })
      
      // Get the clearinghouse state (balance info)
      const state = await publicClient.clearinghouseState({ user: this.address })
      return state
    } catch (err) {
      console.error('[evm] Failed to get balance:', err)
      throw err
    }
  }
}
