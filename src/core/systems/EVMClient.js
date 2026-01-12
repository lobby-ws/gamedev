import { System } from './System'
import { storage } from '../storage'
import { uuid } from '../utils'
import * as hl from '@nktkas/hyperliquid'
import { signUserSignedAction, getWalletChainId } from '@nktkas/hyperliquid/signing'
import { UsdSendTypes } from '@nktkas/hyperliquid/api/exchange'
import { SymbolConverter } from '@nktkas/hyperliquid/utils'

const key = 'hyp:solana:auths'
const template = 'Connect to world:\n{address}'

export class EVM extends System {
  constructor(world) {
    super(world)
    this.auths = storage.get(key, []) // [...{ address, signature }]
    this.connected = false
    this.address = null
    this.actions = null
    this.abis = null
    this.connection = null
    this.config = null

    this.hlIsTestnet = true
    this.infoClient = null
    this.exchangeClient = null
    this.subscriptionClient = null
    this.httpTransport = null
    this.wsTransport = null
    this.symbolConverter = null

    this.subscriptions = []
    this.pendingDeposits = new Map()
    this.refreshIntervalId = null
    this.refreshing = false

    this.perpsState = null
    this.spotState = null
    this.perpMeta = null
    this.perpCtxs = null
    this.spotMeta = null
    this.spotCtxs = null
    this.openOrders = []
    this.fills = []
    this.twapHistory = []
    this.fundingHistory = []
  }

  async bind({ connectors, connect, config, actions, abis, address, isConnected, isConnecting, disconnect }) {
    this.actions = actions
    this.abis = abis
    this.connection = { connect, disconnect, connectors }
    this.config = config

    if (!this.infoClient) {
      await this.initializeHyperliquid()
    }

    const previousAddress = this.address
    this.address = address

    if (isConnected && !this.connected) {
      this.connected = true
      if (address) {
        this.world.network.send('evmConnect', address)
      }
      await this.ensureExchangeClient()
      await this.subscribeAll()
      this.resetRefreshLoop()
    }

    if (!isConnected && this.connected) {
      this.connected = false
      this.world.network.send('evmDisconnect')
      this.resetAccountState()
      this.clearRefreshLoop()
      await this.teardownSubscriptions()
    }

    if (previousAddress && address && previousAddress.toLowerCase() !== address.toLowerCase()) {
      this.resetAccountState()
      if (this.connected) {
        this.world.network.send('evmConnect', address)
        await this.ensureExchangeClient(true)
        await this.subscribeAll()
        this.resetRefreshLoop()
      }
    }

    if (!previousAddress && address && this.connected) {
      this.resetAccountState()
      await this.ensureExchangeClient(true)
      await this.subscribeAll()
      this.resetRefreshLoop()
    }
  }

  connect(player) {
    if (player && player.data.id !== this.world.network.id) {
      throw new Error('[solana] cannot connect a remote player from client')
    }
    if (this.connected) return
    this.connection.connect({ connector: this.connection.connectors[0] })
    this.connected = true
  }

  disconnect(player) {
    if (player && player.data.id !== this.world.network.id) {
      throw new Error('[solana] cannot disconnect a remote player from client')
    }
    if (!this.connected) return
    this.connection.disconnect()
    this.connected = false
  }

  onSnapshot(data) {
    const isTestnet = data?.hl?.isTestnet
    if (typeof isTestnet === 'boolean') {
      this.applyHlConfig(isTestnet)
    }
  }

  onHlConfig({ isTestnet }) {
    if (typeof isTestnet === 'boolean') {
      this.applyHlConfig(isTestnet)
    }
  }

  async applyHlConfig(isTestnet) {
    if (this.hlIsTestnet === isTestnet && this.infoClient) return
    this.hlIsTestnet = isTestnet
    await this.initializeHyperliquid()
  }

  async initializeHyperliquid() {
    await this.teardownSubscriptions({ closeTransport: true })

    this.httpTransport = new hl.HttpTransport({ isTestnet: this.hlIsTestnet })
    this.infoClient = new hl.InfoClient({ transport: this.httpTransport })

    try {
      this.symbolConverter = await SymbolConverter.create({ transport: this.httpTransport, dexs: false })
    } catch (err) {
      console.error('[evm] Failed to initialize SymbolConverter:', err)
    }

    this.wsTransport = new hl.WebSocketTransport({ isTestnet: this.hlIsTestnet })
    this.subscriptionClient = new hl.SubscriptionClient({ transport: this.wsTransport })

    await this.ensureExchangeClient(true)
    await this.subscribeAll()
    this.resetRefreshLoop()
  }

  async ensureExchangeClient(force = false) {
    if (!this.connected || !this.address || !this.config || !this.actions?.getWalletClient) return
    if (this.exchangeClient && !force) return

    try {
      const wallet = await this.actions.getWalletClient(this.config)
      if (!wallet) throw new Error('wallet_client_unavailable')

      if (!this.httpTransport) {
        this.httpTransport = new hl.HttpTransport({ isTestnet: this.hlIsTestnet })
        this.infoClient = new hl.InfoClient({ transport: this.httpTransport })
      }

      this.exchangeClient = new hl.ExchangeClient({
        wallet,
        transport: this.httpTransport,
        nonceManager: addr => this.getNextNonce(addr),
      })
    } catch (err) {
      console.error('[evm] Failed to initialize Hyperliquid ExchangeClient:', err)
    }
  }

  async teardownSubscriptions({ closeTransport = false } = {}) {
    const subs = this.subscriptions.slice()
    this.subscriptions = []
    await Promise.all(
      subs.map(async sub => {
        try {
          await sub.unsubscribe()
        } catch (err) {
          console.warn('[evm] Failed to unsubscribe:', err)
        }
      })
    )

    if (this.wsTransport && closeTransport) {
      try {
        await this.wsTransport.close()
      } catch (err) {
        console.warn('[evm] Failed to close HL websocket:', err)
      }
      this.wsTransport = null
      this.subscriptionClient = null
    }
  }

  async subscribeAll() {
    if (!this.subscriptionClient) return

    await this.teardownSubscriptions()

    const subs = []
    try {
      const midsSub = await this.subscriptionClient.allMids(data => {
        const mids = data?.mids || data
        this.emit('hl:mids', mids)
      })
      subs.push(midsSub)

      if (this.address) {
        const perpsSub = await this.subscriptionClient.clearinghouseState({ user: this.address }, data => {
          const state = data?.clearinghouseState || data
          this.perpsState = state
          this.emit('hl:perps', state)
        })
        subs.push(perpsSub)

        const spotSub = await this.subscriptionClient.spotState({ user: this.address }, data => {
          const state = data?.spotState || data
          this.spotState = state
          this.emit('hl:spot', state)
        })
        subs.push(spotSub)
      }
    } catch (err) {
      console.error('[evm] Failed to subscribe to Hyperliquid:', err)
    }

    this.subscriptions = subs
  }

  resetAccountState() {
    this.perpsState = null
    this.spotState = null
    this.perpMeta = null
    this.perpCtxs = null
    this.spotMeta = null
    this.spotCtxs = null
    this.openOrders = []
    this.fills = []
    this.twapHistory = []
    this.emit('hl:reset')
  }

  resetRefreshLoop() {
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId)
      this.refreshIntervalId = null
    }

    if (!this.address || !this.infoClient) return

    this.refreshIntervalId = setInterval(() => {
      this.refreshData({ isBackground: true })
    }, 45000)

    this.refreshData({ isBackground: false })
  }

  clearRefreshLoop() {
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId)
      this.refreshIntervalId = null
    }
  }
  setRefreshing(next) {
    if (this.refreshing === next) return
    this.refreshing = next
    this.emit('hl:refresh', next)
  }

  async refreshData({ isBackground }) {
    if (!this.infoClient || !this.address) return

    if (isBackground) {
      this.setRefreshing(true)
    }

    try {
      const [
        perpsState,
        spotState,
        perpMetaAndCtxs,
        spotMetaAndCtxs,
        openOrders,
        fills,
        twapHistory,
        fundingHistory,
      ] = await Promise.all([
        this.infoClient.clearinghouseState({ user: this.address }),
        this.infoClient.spotClearinghouseState({ user: this.address }),
        this.infoClient.metaAndAssetCtxs(),
        this.infoClient.spotMetaAndAssetCtxs(),
        this.infoClient.openOrders({ user: this.address }),
        this.infoClient.userFills({ user: this.address }),
        this.infoClient.twapHistory({ user: this.address }),
        this.infoClient.userFunding({ user: this.address }),
      ])

      this.perpsState = perpsState || null
      this.spotState = spotState || null
      this.perpMeta = perpMetaAndCtxs?.[0] || null
      this.perpCtxs = perpMetaAndCtxs?.[1] || null
      this.spotMeta = spotMetaAndCtxs?.[0] || null
      this.spotCtxs = spotMetaAndCtxs?.[1] || null
      this.openOrders = Array.isArray(openOrders) ? openOrders : []
      this.fills = Array.isArray(fills) ? fills : []
      this.twapHistory = Array.isArray(twapHistory) ? twapHistory : []
      this.fundingHistory = Array.isArray(fundingHistory) ? fundingHistory : []

      this.emit('hl:meta', {
        perps: this.perpMeta,
        perpsCtxs: this.perpCtxs,
        spot: this.spotMeta,
        spotCtxs: this.spotCtxs,
      })
      this.emit('hl:perps', this.perpsState)
      this.emit('hl:spot', this.spotState)
      this.emit('hl:openOrders', this.openOrders)
      this.emit('hl:fills', this.fills)
      this.emit('hl:twaps', this.twapHistory)
      this.emit('hl:funding', this.fundingHistory)
    } catch (err) {
      console.error('[evm] Failed to refresh Hyperliquid data:', err)
    } finally {
      if (isBackground) {
        this.setRefreshing(false)
      }
    }
  }

  getNonceKey(address) {
    const safeAddress = address ? address.toLowerCase() : 'unknown'
    return `hl:nonce:${this.hlIsTestnet ? 'testnet' : 'mainnet'}:${safeAddress}`
  }

  getNextNonce(address = this.address) {
    const key = this.getNonceKey(address)
    const last = storage.get(key, 0)
    const now = Date.now()
    const next = now > last ? now : last + 1
    storage.set(key, next)
    return next
  }

  async deposit(amount) {
    if (!this.address) throw new Error('[evm] No wallet connected')
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('[evm] Invalid amount')
    const depositId = uuid()
    return new Promise((resolve, reject) => {
      this.pendingDeposits.set(depositId, { resolve, reject })
      this.world.network.send('evmDeposit', { depositId, amount })
    })
  }

  async onDepositRequest({ depositId, destination, amount, isTestnet }) {
    try {
      if (!this.address) throw new Error('wallet_not_connected')
      const wallet = await this.actions.getWalletClient(this.config)
      if (!wallet) throw new Error('wallet_client_unavailable')

      const signatureChainId = await getWalletChainId(wallet)
      const nonce = this.getNextNonce(this.address)
      const action = {
        type: 'usdSend',
        signatureChainId,
        hyperliquidChain: isTestnet ? 'Testnet' : 'Mainnet',
        destination,
        amount: amount.toString(),
        time: nonce,
      }

      const signature = await signUserSignedAction({
        wallet,
        action,
        types: UsdSendTypes,
      })

      this.world.network.send('depositResponse', {
        depositId,
        action,
        signature,
        nonce,
      })
    } catch (error) {
      console.error('[evm] Failed to process deposit request:', error)
      this.world.network.send('depositResponse', {
        depositId,
        error: error?.message || 'deposit_sign_failed',
      })
    }
  }

  onDepositResult({ depositId, success, response, error }) {
    const pending = this.pendingDeposits.get(depositId)
    if (!pending) return
    this.pendingDeposits.delete(depositId)
    if (success) {
      pending.resolve(response)
    } else {
      pending.reject(new Error(error || 'deposit_failed'))
    }
  }

  async spotSend({ destination, token, amount }) {
    if (!this.exchangeClient) {
      throw new Error('[evm] Hyperliquid client not initialized')
    }

    return this.exchangeClient.spotSend({ destination, token, amount })
  }

  async placeOrder({ assetId, isBuy, price, size, reduceOnly, orderType, tif, triggerPx, tpsl, isMarket }) {
    if (!this.exchangeClient) {
      throw new Error('[evm] Hyperliquid client not initialized')
    }

    const t = orderType === 'trigger'
      ? { trigger: { isMarket: !!isMarket, triggerPx, tpsl } }
      : { limit: { tif } }

    const orderParams = {
      orders: [
        {
          a: assetId,
          b: isBuy,
          p: price,
          s: size,
          r: !!reduceOnly,
          t,
        },
      ],
      grouping: 'na',
    }

    return this.exchangeClient.order(orderParams)
  }

  async modifyOrder({ orderId, assetId, isBuy, price, size, reduceOnly, tif }) {
    if (!this.exchangeClient) {
      throw new Error('[evm] Hyperliquid client not initialized')
    }

    return this.exchangeClient.modify({
      oid: orderId,
      order: {
        a: assetId,
        b: isBuy,
        p: price,
        s: size,
        r: !!reduceOnly,
        t: { limit: { tif } },
      },
    })
  }

  async cancelOrder({ assetId, orderId }) {
    if (!this.exchangeClient) {
      throw new Error('[evm] Hyperliquid client not initialized')
    }

    return this.exchangeClient.cancel({
      cancels: [{ a: assetId, o: orderId }],
    })
  }

  async updateLeverage({ assetId, isCross, leverage }) {
    if (!this.exchangeClient) {
      throw new Error('[evm] Hyperliquid client not initialized')
    }

    return this.exchangeClient.updateLeverage({
      asset: assetId,
      isCross: !!isCross,
      leverage,
    })
  }

  async updateIsolatedMargin({ assetId, isBuy, amountUsd }) {
    if (!this.exchangeClient) {
      throw new Error('[evm] Hyperliquid client not initialized')
    }

    const ntli = Math.round(Number(amountUsd) * 1_000_000)
    return this.exchangeClient.updateIsolatedMargin({
      asset: assetId,
      isBuy: !!isBuy,
      ntli,
    })
  }

  async twapOrder({ assetId, isBuy, size, reduceOnly, minutes, randomize }) {
    if (!this.exchangeClient) {
      throw new Error('[evm] Hyperliquid client not initialized')
    }

    return this.exchangeClient.twapOrder({
      twap: {
        a: assetId,
        b: isBuy,
        s: size,
        r: !!reduceOnly,
        m: minutes,
        t: !!randomize,
      },
    })
  }

  async twapCancel({ assetId, twapId }) {
    if (!this.exchangeClient) {
      throw new Error('[evm] Hyperliquid client not initialized')
    }

    return this.exchangeClient.twapCancel({ a: assetId, t: twapId })
  }
}
