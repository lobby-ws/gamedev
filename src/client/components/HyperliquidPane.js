import { css } from '@firebolt-dev/css'
import { useEffect, useMemo, useRef, useState } from 'react'
import { XIcon, RefreshCw } from 'lucide-react'
import { formatPrice, formatSize } from '@nktkas/hyperliquid/utils'
import { cls } from './cls'

const DEFAULT_TIF = 'Gtc'

const formatUsd = value => {
  const num = Number(value)
  if (!Number.isFinite(num)) return '0.00'
  return num.toFixed(2)
}

const formatAddress = address => {
  if (!address) return ''
  return `${address.slice(0, 6)}...`
}

const getPerpSymbols = meta => {
  if (!meta?.universe) return []
  return meta.universe.map(u => u.name).filter(Boolean)
}

const getSpotPairs = meta => {
  if (!meta?.universe || !meta?.tokens) return []
  const tokenByIndex = new Map(meta.tokens.map(t => [t.index, t.name]))
  return meta.universe
    .map(u => {
      const base = tokenByIndex.get(u.tokens[0])
      const quote = tokenByIndex.get(u.tokens[1])
      if (!base || !quote) return null
      return `${base}/${quote}`
    })
    .filter(Boolean)
    .filter(pair => pair.endsWith('/USDC'))
}

const getSpotCtxMap = ctxs => {
  if (!Array.isArray(ctxs)) return {}
  return ctxs.reduce((acc, ctx) => {
    if (ctx?.coin) acc[ctx.coin] = ctx
    return acc
  }, {})
}

export function HyperliquidPane({ world, close }) {
  const containerRef = useRef()
  const resizeRef = useRef()

  const [activeTab, setActiveTab] = useState('trade')
  const [isInitialLoading, setIsInitialLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const [address, setAddress] = useState(world.evm.address)
  const [mids, setMids] = useState({})
  const [perpsState, setPerpsState] = useState(null)
  const [spotState, setSpotState] = useState(null)
  const [meta, setMeta] = useState({ perps: null, perpsCtxs: null, spot: null, spotCtxs: null })
  const [openOrders, setOpenOrders] = useState([])
  const [fills, setFills] = useState([])
  const [twaps, setTwaps] = useState([])
  const [funding, setFunding] = useState([])

  const [marketType, setMarketType] = useState('perp')
  const [selectedSymbol, setSelectedSymbol] = useState('')
  const [side, setSide] = useState('buy')
  const [orderType, setOrderType] = useState('limit')
  const [tif, setTif] = useState(DEFAULT_TIF)
  const [reduceOnly, setReduceOnly] = useState(false)
  const [orderSize, setOrderSize] = useState('')
  const [orderPrice, setOrderPrice] = useState('')
  const [triggerPrice, setTriggerPrice] = useState('')
  const [triggerType, setTriggerType] = useState('tp')
  const [triggerMarket, setTriggerMarket] = useState(true)
  const [tradeStatus, setTradeStatus] = useState(null)

  const [twapSize, setTwapSize] = useState('')
  const [twapMinutes, setTwapMinutes] = useState('30')
  const [twapRandomize, setTwapRandomize] = useState(true)
  const [twapReduceOnly, setTwapReduceOnly] = useState(false)
  const [twapStatus, setTwapStatus] = useState(null)

  const [depositAmount, setDepositAmount] = useState('')
  const [depositStatus, setDepositStatus] = useState(null)

  const [leverageEdits, setLeverageEdits] = useState({})
  const [marginEdits, setMarginEdits] = useState({})
  const [orderEdits, setOrderEdits] = useState({})

  const isConnected = !!address
  const spotCtxMap = useMemo(() => getSpotCtxMap(meta.spotCtxs), [meta.spotCtxs])
  const perpSymbols = useMemo(() => getPerpSymbols(meta.perps), [meta.perps])
  const spotPairs = useMemo(() => getSpotPairs(meta.spot), [meta.spot])

  useEffect(() => {
    const evm = world.evm
    if (!evm) return

    const handleReset = () => {
      setAddress(evm.address)
      setIsInitialLoading(true)
      setPerpsState(null)
      setSpotState(null)
      setOpenOrders([])
      setFills([])
      setTwaps([])
      setFunding([])
      setTradeStatus(null)
      setTwapStatus(null)
      setDepositStatus(null)
    }

    const handleMids = data => setMids(data || {})
    const handlePerps = data => {
      setPerpsState(data)
      setIsInitialLoading(false)
    }
    const handleSpot = data => {
      setSpotState(data)
      setIsInitialLoading(false)
    }
    const handleMeta = data => {
      setMeta(data)
      setIsInitialLoading(false)
    }
    const handleOpenOrders = data => setOpenOrders(Array.isArray(data) ? data : [])
    const handleFills = data => setFills(Array.isArray(data) ? data : [])
    const handleTwaps = data => setTwaps(Array.isArray(data) ? data : [])
    const handleFunding = data => setFunding(Array.isArray(data) ? data : [])
    const handleRefreshing = value => setIsRefreshing(!!value)

    evm.on('hl:reset', handleReset)
    evm.on('hl:mids', handleMids)
    evm.on('hl:perps', handlePerps)
    evm.on('hl:spot', handleSpot)
    evm.on('hl:meta', handleMeta)
    evm.on('hl:openOrders', handleOpenOrders)
    evm.on('hl:fills', handleFills)
    evm.on('hl:twaps', handleTwaps)
    evm.on('hl:funding', handleFunding)
    evm.on('hl:refresh', handleRefreshing)

    return () => {
      evm.off('hl:reset', handleReset)
      evm.off('hl:mids', handleMids)
      evm.off('hl:perps', handlePerps)
      evm.off('hl:spot', handleSpot)
      evm.off('hl:meta', handleMeta)
      evm.off('hl:openOrders', handleOpenOrders)
      evm.off('hl:fills', handleFills)
      evm.off('hl:twaps', handleTwaps)
      evm.off('hl:funding', handleFunding)
      evm.off('hl:refresh', handleRefreshing)
    }
  }, [world])

  useEffect(() => {
    if (!isConnected) {
      setIsInitialLoading(false)
      setError('Wallet not connected')
    } else {
      setError(null)
    }
  }, [isConnected])

  useEffect(() => {
    const list = marketType === 'perp' ? perpSymbols : spotPairs
    if (!list.length) return
    if (!selectedSymbol || !list.includes(selectedSymbol)) {
      setSelectedSymbol(list[0])
    }
  }, [marketType, perpSymbols, spotPairs, selectedSymbol])

  useEffect(() => {
    setOrderType('limit')
    setTif(DEFAULT_TIF)
    setOrderPrice('')
    setOrderSize('')
    setTriggerPrice('')
  }, [marketType, selectedSymbol])

  useEffect(() => {
    const elem = resizeRef.current
    const container = containerRef.current
    container.style.width = '400px'

    function onPointerDown(e) {
      elem.addEventListener('pointermove', onPointerMove)
      elem.addEventListener('pointerup', onPointerUp)
      e.currentTarget.setPointerCapture(e.pointerId)
    }

    function onPointerMove(e) {
      const newWidth = container.offsetWidth - e.movementX
      container.style.width = `${newWidth}px`
    }

    function onPointerUp(e) {
      e.currentTarget.releasePointerCapture(e.pointerId)
      elem.removeEventListener('pointermove', onPointerMove)
      elem.removeEventListener('pointerup', onPointerUp)
    }

    elem.addEventListener('pointerdown', onPointerDown)
    return () => elem.removeEventListener('pointerdown', onPointerDown)
  }, [])

  const perpsAccountValue = parseFloat(perpsState?.marginSummary?.accountValue || 0)
  const spotBalances = spotState?.balances || []
  const spotValue = spotBalances.reduce((sum, bal) => {
    const coin = bal.coin
    const total = parseFloat(bal.total || 0)
    if (!total) return sum
    const ctx = spotCtxMap[coin]
    let price = parseFloat(ctx?.markPx || ctx?.midPx || 0)
    if (!price && coin === 'USDC') price = 1
    if (!price) return sum
    return sum + total * price
  }, 0)
  const totalAccountValue = perpsAccountValue + spotValue

  const handleManualRefresh = () => {
    if (!world.evm?.refreshData) return
    world.evm.refreshData({ isBackground: true })
  }

  const getAssetId = symbol => world.evm.symbolConverter?.getAssetId(symbol)
  const getSzDecimals = symbol => world.evm.symbolConverter?.getSzDecimals(symbol) ?? 2

  const getMidPrice = symbol => {
    if (!symbol) return null
    if (marketType === 'spot') {
      const base = symbol.split('/')[0]
      const ctx = spotCtxMap[base]
      return ctx?.midPx || ctx?.markPx || null
    }
    return mids?.[symbol] || null
  }

  const handleSubmitOrder = async e => {
    e.preventDefault()

    try {
      setTradeStatus({ loading: true, message: 'Submitting order...' })

      if (!selectedSymbol) throw new Error('Select a market')
      const assetId = getAssetId(selectedSymbol)
      if (assetId === undefined) throw new Error('Unknown asset')

      const szDecimals = getSzDecimals(selectedSymbol)
      const sizeFormatted = formatSize(orderSize, szDecimals)

      let priceFormatted = orderPrice
      let effectiveTif = tif
      let orderKind = 'limit'
      let triggerPxFormatted = triggerPrice

      if (orderType === 'post') {
        effectiveTif = 'Alo'
      }

      if (orderType === 'market') {
        const mid = getMidPrice(selectedSymbol)
        if (!mid) throw new Error('No market price available')
        priceFormatted = formatPrice(mid, szDecimals, marketType === 'spot' ? 'spot' : 'perp')
        effectiveTif = 'FrontendMarket'
      }

      if (orderType === 'trigger') {
        triggerPxFormatted = formatPrice(triggerPrice, szDecimals, marketType === 'spot' ? 'spot' : 'perp')
        const triggerPriceValue = triggerMarket ? triggerPxFormatted : orderPrice
        priceFormatted = formatPrice(triggerPriceValue, szDecimals, marketType === 'spot' ? 'spot' : 'perp')
        orderKind = 'trigger'
      } else {
        priceFormatted = formatPrice(orderPrice, szDecimals, marketType === 'spot' ? 'spot' : 'perp')
      }

      await world.evm.placeOrder({
        assetId,
        isBuy: side === 'buy',
        price: priceFormatted,
        size: sizeFormatted,
        reduceOnly,
        orderType: orderKind,
        tif: effectiveTif,
        triggerPx: triggerPxFormatted,
        tpsl: triggerType,
        isMarket: triggerMarket,
      })

      setTradeStatus({ success: true, message: 'Order submitted.' })
      setOrderSize('')
      setOrderPrice('')
      setTriggerPrice('')
    } catch (err) {
      setTradeStatus({ success: false, message: err?.message || 'Order failed' })
    }
  }

  const handleTwapOrder = async e => {
    e.preventDefault()

    try {
      setTwapStatus({ loading: true, message: 'Submitting TWAP...' })
      if (!selectedSymbol) throw new Error('Select a market')
      const assetId = getAssetId(selectedSymbol)
      if (assetId === undefined) throw new Error('Unknown asset')

      const szDecimals = getSzDecimals(selectedSymbol)
      const sizeFormatted = formatSize(twapSize, szDecimals)

      await world.evm.twapOrder({
        assetId,
        isBuy: side === 'buy',
        size: sizeFormatted,
        reduceOnly: twapReduceOnly,
        minutes: Number(twapMinutes),
        randomize: twapRandomize,
      })

      setTwapStatus({ success: true, message: 'TWAP submitted.' })
      setTwapSize('')
    } catch (err) {
      setTwapStatus({ success: false, message: err?.message || 'TWAP failed' })
    }
  }

  const handleDeposit = async e => {
    e.preventDefault()

    const amount = parseFloat(depositAmount)
    if (!Number.isFinite(amount) || amount <= 0) {
      setDepositStatus({ success: false, message: 'Invalid amount' })
      return
    }

    try {
      setDepositStatus({ loading: true, message: 'Sending deposit...' })
      await world.evm.deposit(amount)
      setDepositStatus({ success: true, message: 'Deposit submitted.' })
      setDepositAmount('')
    } catch (err) {
      setDepositStatus({ success: false, message: err?.message || 'Deposit failed' })
    }
  }

  const handleCancelOrder = async order => {
    try {
      const assetId = getAssetId(order.coin)
      if (assetId === undefined) throw new Error('Unknown asset')
      await world.evm.cancelOrder({ assetId, orderId: order.oid })
    } catch (err) {
      console.error(err)
    }
  }

  const handleModifyOrder = async order => {
    try {
      const assetId = getAssetId(order.coin)
      if (assetId === undefined) throw new Error('Unknown asset')
      const edit = orderEdits[order.oid] || {}
      const price = edit.price || order.limitPx
      const size = edit.size || order.sz
      const szDecimals = getSzDecimals(order.coin)
      const priceFormatted = formatPrice(price, szDecimals, order.coin.includes('/') ? 'spot' : 'perp')
      const sizeFormatted = formatSize(size, szDecimals)

      await world.evm.modifyOrder({
        orderId: order.oid,
        assetId,
        isBuy: order.side === 'B',
        price: priceFormatted,
        size: sizeFormatted,
        reduceOnly: order.reduceOnly,
        tif: DEFAULT_TIF,
      })
    } catch (err) {
      console.error(err)
    }
  }

  const handleUpdateLeverage = async position => {
    try {
      const assetId = getAssetId(position.coin)
      if (assetId === undefined) throw new Error('Unknown asset')
      const edit = leverageEdits[position.coin] || {}
      const leverageValue = Number(edit.leverage || position.leverage?.value || 1)
      const isCross = edit.isCross ?? position.leverage?.type === 'cross'
      await world.evm.updateLeverage({ assetId, isCross, leverage: leverageValue })
    } catch (err) {
      console.error(err)
    }
  }

  const handleUpdateMargin = async position => {
    try {
      const assetId = getAssetId(position.coin)
      if (assetId === undefined) throw new Error('Unknown asset')
      const edit = marginEdits[position.coin] || {}
      const amountUsd = edit.amount || 0
      await world.evm.updateIsolatedMargin({
        assetId,
        isBuy: parseFloat(position.szi) > 0,
        amountUsd,
      })
    } catch (err) {
      console.error(err)
    }
  }

  const handleCancelTwap = async twap => {
    try {
      const assetId = getAssetId(twap.state.coin)
      if (assetId === undefined) throw new Error('Unknown asset')
      if (twap.twapId === undefined || twap.twapId === null) throw new Error('Missing TWAP id')
      await world.evm.twapCancel({ assetId, twapId: twap.twapId })
    } catch (err) {
      console.error(err)
    }
  }

  return (
    <div
      ref={containerRef}
      className="hyperliquid-pane"
      css={css`
        position: absolute;
        top: 0;
        right: 0;
        bottom: 0;
        width: 400px;
        background-color: rgba(15, 16, 24, 0.95);
        pointer-events: auto;
        display: flex;
        flex-direction: column;

        .hl-head {
          height: 50px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          display: flex;
          align-items: center;
          padding: 0 10px 0 20px;
          flex-shrink: 0;

          &-title {
            font-weight: 500;
            font-size: 20px;
            flex: 1;
          }

          &-close {
            width: 40px;
            height: 40px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #7d7d7d;
            cursor: pointer;

            &:hover {
              color: white;
            }
          }
        }

        .hl-tabs {
          display: flex;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          flex-shrink: 0;

          &-tab {
            flex: 1;
            padding: 12px;
            text-align: center;
            color: rgba(255, 255, 255, 0.5);
            cursor: pointer;
            font-size: 14px;
            transition: all 0.2s;

            &:hover {
              color: rgba(255, 255, 255, 0.8);
              background: rgba(255, 255, 255, 0.02);
            }

            &.active {
              color: #00a7ff;
              border-bottom: 2px solid #00a7ff;
            }
          }
        }

        .hl-content {
          flex: 1;
          padding: 20px;
          overflow-y: auto;
        }

        .hl-section {
          margin-bottom: 20px;

          &-title {
            font-size: 14px;
            font-weight: 500;
            margin-bottom: 10px;
            color: rgba(255, 255, 255, 0.7);
          }
        }

        .hl-card {
          background-color: rgba(0, 0, 0, 0.3);
          border-radius: 8px;
          padding: 15px;
          margin-bottom: 15px;
        }

        .hl-summary {
          display: flex;
          flex-direction: column;
          gap: 6px;

          &-value {
            font-size: 28px;
            font-weight: 600;
          }

          &-label {
            font-size: 13px;
            color: rgba(255, 255, 255, 0.6);
          }
        }

        .hl-address {
          font-family: monospace;
          font-size: 12px;
          background: rgba(0, 0, 0, 0.3);
          padding: 8px 10px;
          border-radius: 4px;
          margin-top: 8px;
          word-break: break-all;
          color: rgba(255, 255, 255, 0.7);
        }

        .hl-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 8px 0;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);

          &:last-child {
            border-bottom: none;
          }
        }

        .hl-row-title {
          font-size: 13px;
          color: rgba(255, 255, 255, 0.65);
        }

        .hl-row-value {
          font-size: 13px;
          color: rgba(255, 255, 255, 0.9);
        }

        .hl-pill {
          padding: 4px 8px;
          border-radius: 999px;
          font-size: 11px;
          background: rgba(255, 255, 255, 0.08);
          color: rgba(255, 255, 255, 0.7);
        }

        .hl-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .hl-form {
          display: flex;
          flex-direction: column;
          gap: 12px;

          &-group {
            display: flex;
            flex-direction: column;
            gap: 6px;
          }

          &-label {
            font-size: 12px;
            color: rgba(255, 255, 255, 0.6);
          }

          &-input,
          &-select {
            width: 100%;
            height: 34px;
            border-radius: 6px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            background: rgba(0, 0, 0, 0.4);
            color: white;
            padding: 0 10px;
            font-size: 13px;
            outline: none;
          }
        }

        .hl-btn {
          height: 36px;
          padding: 0 14px;
          border-radius: 6px;
          border: none;
          cursor: pointer;
          font-size: 13px;
          color: white;
          background: #00a7ff;
          transition: all 0.2s;

          &:disabled {
            opacity: 0.6;
            cursor: not-allowed;
          }

          &-secondary {
            background: rgba(255, 255, 255, 0.08);
          }

          &-danger {
            background: #c0392b;
          }
        }

        .hl-actions {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }

        .hl-message {
          font-size: 12px;
          margin-top: 8px;

          &.success {
            color: #2ecc71;
          }

          &.error {
            color: #e74c3c;
          }
        }

        .hl-loading {
          font-size: 14px;
          color: rgba(255, 255, 255, 0.6);
        }

        .hl-connect {
          display: flex;
          flex-direction: column;
          gap: 12px;
          align-items: flex-start;
        }

        .hl-refresh {
          width: 30px;
          height: 30px;
          display: flex;
          align-items: center;
          justify-content: center;
          color: #7d7d7d;
          cursor: pointer;
          transition: all 0.2s;

          &:hover {
            color: white;
          }
        }

        .hl-resizer {
          position: absolute;
          left: -6px;
          top: 0;
          bottom: 0;
          width: 6px;
          cursor: ew-resize;
          z-index: 2;
        }
      `}
    >
      <div className="hl-head">
        <div className="hl-head-title">Hyperliquid</div>
        <div className="hl-refresh" onClick={handleManualRefresh} title="Refresh">
          <RefreshCw size={16} />
        </div>
        <div className="hl-head-close" onClick={close}>
          <XIcon size={18} />
        </div>
      </div>

      <div className="hl-tabs">
        {['trade', 'positions', 'orders', 'history'].map(tab => (
          <div
            key={tab}
            className={cls('hl-tabs-tab', { active: activeTab === tab })}
            onClick={() => setActiveTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </div>
        ))}
      </div>

      <div className="hl-content">
        {isInitialLoading && isConnected && <div className="hl-loading">Loading wallet info...</div>}

        {!isConnected && (
          <div className="hl-connect">
            <div className="hl-message error">{error}</div>
            <button className="hl-btn" onClick={() => world.evm.connect()}>
              Connect Wallet
            </button>
          </div>
        )}

        {isConnected && !isInitialLoading && (
          <>
            <div className="hl-section">
              <div className="hl-section-title">Summary</div>
              <div className="hl-card">
                <div className="hl-summary">
                  <div className="hl-summary-label">Total Account Value</div>
                  <div className="hl-summary-value">${formatUsd(totalAccountValue)}</div>
                </div>
                <div className="hl-row" style={{ borderBottom: 'none', paddingBottom: 0 }}>
                  <div className="hl-row-title">Perps Account Value</div>
                  <div className="hl-row-value">${formatUsd(perpsAccountValue)}</div>
                </div>
                <div className="hl-row" style={{ borderBottom: 'none' }}>
                  <div className="hl-row-title">Spot Holdings Value</div>
                  <div className="hl-row-value">${formatUsd(spotValue)}</div>
                </div>
                <div className="hl-address">{formatAddress(address)}</div>
                {isRefreshing && <div className="hl-pill">Syncing...</div>}
              </div>
            </div>

            {activeTab === 'trade' && (
              <>
                <div className="hl-section">
                  <div className="hl-section-title">Market</div>
                  <div className="hl-card">
                    <div className="hl-form">
                      <div className="hl-form-group">
                        <label className="hl-form-label">Market Type</label>
                        <select
                          className="hl-form-select"
                          value={marketType}
                          onChange={e => setMarketType(e.target.value)}
                        >
                          <option value="perp">Perp</option>
                          <option value="spot">Spot</option>
                        </select>
                      </div>
                      <div className="hl-form-group">
                        <label className="hl-form-label">Symbol</label>
                        <select
                          className="hl-form-select"
                          value={selectedSymbol}
                          onChange={e => setSelectedSymbol(e.target.value)}
                        >
                          {(marketType === 'perp' ? perpSymbols : spotPairs).map(symbol => (
                            <option key={symbol} value={symbol}>
                              {symbol}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="hl-section">
                  <div className="hl-section-title">Order Ticket</div>
                  <div className="hl-card">
                    <form className="hl-form" onSubmit={handleSubmitOrder}>
                      <div className="hl-form-group">
                        <label className="hl-form-label">Side</label>
                        <select className="hl-form-select" value={side} onChange={e => setSide(e.target.value)}>
                          <option value="buy">Buy</option>
                          <option value="sell">Sell</option>
                        </select>
                      </div>
                      <div className="hl-form-group">
                        <label className="hl-form-label">Order Type</label>
                        <select className="hl-form-select" value={orderType} onChange={e => setOrderType(e.target.value)}>
                          <option value="limit">Limit</option>
                          <option value="market">Market</option>
                          <option value="post">Post Only</option>
                          <option value="trigger">Trigger (TP/SL)</option>
                        </select>
                      </div>
                      {orderType === 'limit' && (
                        <div className="hl-form-group">
                          <label className="hl-form-label">Time in Force</label>
                          <select className="hl-form-select" value={tif} onChange={e => setTif(e.target.value)}>
                            <option value="Gtc">GTC</option>
                            <option value="Ioc">IOC</option>
                          </select>
                        </div>
                      )}
                      {orderType === 'post' && (
                        <div className="hl-form-group">
                          <label className="hl-form-label">Post Only</label>
                          <div className="hl-pill">Alo</div>
                        </div>
                      )}
                      {orderType === 'trigger' && (
                        <>
                          <div className="hl-form-group">
                            <label className="hl-form-label">Trigger Type</label>
                            <select
                              className="hl-form-select"
                              value={triggerType}
                              onChange={e => setTriggerType(e.target.value)}
                            >
                              <option value="tp">Take Profit</option>
                              <option value="sl">Stop Loss</option>
                            </select>
                          </div>
                          <div className="hl-form-group">
                            <label className="hl-form-label">Trigger Price</label>
                            <input
                              className="hl-form-input"
                              value={triggerPrice}
                              onChange={e => setTriggerPrice(e.target.value)}
                              placeholder="0.00"
                            />
                          </div>
                          <div className="hl-form-group">
                            <label className="hl-form-label">Trigger as Market</label>
                            <select
                              className="hl-form-select"
                              value={triggerMarket ? 'market' : 'limit'}
                              onChange={e => setTriggerMarket(e.target.value === 'market')}
                            >
                              <option value="market">Market</option>
                              <option value="limit">Limit</option>
                            </select>
                          </div>
                        </>
                      )}
                      <div className="hl-form-group">
                        <label className="hl-form-label">Size</label>
                        <input
                          className="hl-form-input"
                          value={orderSize}
                          onChange={e => setOrderSize(e.target.value)}
                          placeholder="0.00"
                        />
                      </div>
                      {orderType !== 'market' && (
                        <div className="hl-form-group">
                          <label className="hl-form-label">Price</label>
                          <input
                            className="hl-form-input"
                            value={orderPrice}
                            onChange={e => setOrderPrice(e.target.value)}
                            placeholder="0.00"
                          />
                        </div>
                      )}
                      <div className="hl-form-group">
                        <label className="hl-form-label">Reduce Only</label>
                        <select
                          className="hl-form-select"
                          value={reduceOnly ? 'yes' : 'no'}
                          onChange={e => setReduceOnly(e.target.value === 'yes')}
                        >
                          <option value="no">No</option>
                          <option value="yes">Yes</option>
                        </select>
                      </div>
                      <button className="hl-btn" type="submit" disabled={tradeStatus?.loading}>
                        Submit Order
                      </button>
                      {tradeStatus && (
                        <div className={cls('hl-message', { success: tradeStatus.success, error: tradeStatus.success === false })}>
                          {tradeStatus.message}
                        </div>
                      )}
                    </form>
                  </div>
                </div>

                <div className="hl-section">
                  <div className="hl-section-title">TWAP</div>
                  <div className="hl-card">
                    {marketType === 'spot' ? (
                      <div className="hl-message error">TWAP is available for perpetuals only.</div>
                    ) : (
                      <form className="hl-form" onSubmit={handleTwapOrder}>
                        <div className="hl-form-group">
                          <label className="hl-form-label">TWAP Size</label>
                          <input
                            className="hl-form-input"
                            value={twapSize}
                            onChange={e => setTwapSize(e.target.value)}
                            placeholder="0.00"
                          />
                        </div>
                        <div className="hl-form-group">
                          <label className="hl-form-label">Duration (minutes)</label>
                          <input
                            className="hl-form-input"
                            value={twapMinutes}
                            onChange={e => setTwapMinutes(e.target.value)}
                          />
                        </div>
                        <div className="hl-form-group">
                          <label className="hl-form-label">Randomize</label>
                          <select
                            className="hl-form-select"
                            value={twapRandomize ? 'yes' : 'no'}
                            onChange={e => setTwapRandomize(e.target.value === 'yes')}
                          >
                            <option value="yes">Yes</option>
                            <option value="no">No</option>
                          </select>
                        </div>
                        <div className="hl-form-group">
                          <label className="hl-form-label">Reduce Only</label>
                          <select
                            className="hl-form-select"
                            value={twapReduceOnly ? 'yes' : 'no'}
                            onChange={e => setTwapReduceOnly(e.target.value === 'yes')}
                          >
                            <option value="no">No</option>
                            <option value="yes">Yes</option>
                          </select>
                        </div>
                        <button className="hl-btn" type="submit" disabled={twapStatus?.loading}>
                          Submit TWAP
                        </button>
                        {twapStatus && (
                          <div className={cls('hl-message', { success: twapStatus.success, error: twapStatus.success === false })}>
                            {twapStatus.message}
                          </div>
                        )}
                      </form>
                    )}
                  </div>
                </div>

                <div className="hl-section">
                  <div className="hl-section-title">Send USDC to World</div>
                  <div className="hl-card">
                    <form className="hl-form" onSubmit={handleDeposit}>
                      <div className="hl-form-group">
                        <label className="hl-form-label">Amount (USDC)</label>
                        <input
                          className="hl-form-input"
                          value={depositAmount}
                          onChange={e => setDepositAmount(e.target.value)}
                          placeholder="0.00"
                        />
                      </div>
                      <button className="hl-btn" type="submit" disabled={depositStatus?.loading}>
                        Deposit
                      </button>
                      {depositStatus && (
                        <div
                          className={cls('hl-message', {
                            success: depositStatus.success,
                            error: depositStatus.success === false,
                          })}
                        >
                          {depositStatus.message}
                        </div>
                      )}
                    </form>
                  </div>
                </div>
              </>
            )}

            {activeTab === 'positions' && (
              <>
                <div className="hl-section">
                  <div className="hl-section-title">Perp Positions</div>
                  <div className="hl-card">
                    <div className="hl-list">
                      {perpsState?.assetPositions?.length ? (
                        perpsState.assetPositions.map(pos => (
                          <div key={pos.position.coin} className="hl-card" style={{ marginBottom: 0 }}>
                            <div className="hl-row">
                              <div className="hl-row-title">{pos.position.coin}</div>
                              <div className="hl-row-value">{pos.position.szi}</div>
                            </div>
                            <div className="hl-row">
                              <div className="hl-row-title">Entry</div>
                              <div className="hl-row-value">{pos.position.entryPx}</div>
                            </div>
                            <div className="hl-row">
                              <div className="hl-row-title">PnL</div>
                              <div className="hl-row-value">{pos.position.unrealizedPnl}</div>
                            </div>
                            <div className="hl-row">
                              <div className="hl-row-title">Leverage</div>
                              <div className="hl-row-value">
                                {pos.position.leverage?.value}x ({pos.position.leverage?.type})
                              </div>
                            </div>
                            <div className="hl-form">
                              <div className="hl-form-group">
                                <label className="hl-form-label">New Leverage</label>
                                <input
                                  className="hl-form-input"
                                  value={leverageEdits[pos.position.coin]?.leverage || ''}
                                  onChange={e =>
                                    setLeverageEdits(prev => ({
                                      ...prev,
                                      [pos.position.coin]: {
                                        ...prev[pos.position.coin],
                                        leverage: e.target.value,
                                      },
                                    }))
                                  }
                                  placeholder={pos.position.leverage?.value || '1'}
                                />
                              </div>
                              <div className="hl-form-group">
                                <label className="hl-form-label">Cross Margin</label>
                                <select
                                  className="hl-form-select"
                                  value={
                                    (leverageEdits[pos.position.coin]?.isCross ??
                                      pos.position.leverage?.type === 'cross')
                                      ? 'yes'
                                      : 'no'
                                  }
                                  onChange={e =>
                                    setLeverageEdits(prev => ({
                                      ...prev,
                                      [pos.position.coin]: {
                                        ...prev[pos.position.coin],
                                        isCross: e.target.value === 'yes',
                                      },
                                    }))
                                  }
                                >
                                  <option value="yes">Yes</option>
                                  <option value="no">No</option>
                                </select>
                              </div>
                              <button className="hl-btn" type="button" onClick={() => handleUpdateLeverage(pos.position)}>
                                Update Leverage
                              </button>
                            </div>
                            <div className="hl-form" style={{ marginTop: 10 }}>
                              <div className="hl-form-group">
                                <label className="hl-form-label">Adjust Isolated Margin (USDC)</label>
                                <input
                                  className="hl-form-input"
                                  value={marginEdits[pos.position.coin]?.amount || ''}
                                  onChange={e =>
                                    setMarginEdits(prev => ({
                                      ...prev,
                                      [pos.position.coin]: {
                                        ...prev[pos.position.coin],
                                        amount: e.target.value,
                                      },
                                    }))
                                  }
                                  placeholder="0.00"
                                />
                              </div>
                              <button className="hl-btn" type="button" onClick={() => handleUpdateMargin(pos.position)}>
                                Update Margin
                              </button>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="hl-message">No perp positions.</div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="hl-section">
                  <div className="hl-section-title">Spot Holdings</div>
                  <div className="hl-card">
                    <div className="hl-list">
                      {spotBalances.length ? (
                        spotBalances.map(bal => ( bal.total !== '0.0' &&
                          <div key={bal.coin} className="hl-row">
                            <div className="hl-row-title">{bal.coin}</div>
                            <div className="hl-row-value">{bal.total}</div>
                          </div>
                        ))
                      ) : (
                        <div className="hl-message">No spot balances.</div>
                      )}
                    </div>
                  </div>
                </div>
              </>
            )}

            {activeTab === 'orders' && (
              <>
                <div className="hl-section">
                  <div className="hl-section-title">Open Orders</div>
                  <div className="hl-card">
                    <div className="hl-list">
                      {openOrders.length ? (
                        openOrders.map(order => (
                          <div key={order.oid} className="hl-card" style={{ marginBottom: 0 }}>
                            <div className="hl-row">
                              <div className="hl-row-title">
                                {order.coin} ({order.side === 'B' ? 'Buy' : 'Sell'})
                              </div>
                              <div className="hl-row-value">{order.sz} @ {order.limitPx}</div>
                            </div>
                            <div className="hl-form">
                              <div className="hl-form-group">
                                <label className="hl-form-label">New Price</label>
                                <input
                                  className="hl-form-input"
                                  value={orderEdits[order.oid]?.price || ''}
                                  onChange={e =>
                                    setOrderEdits(prev => ({
                                      ...prev,
                                      [order.oid]: { ...prev[order.oid], price: e.target.value },
                                    }))
                                  }
                                  placeholder={order.limitPx}
                                />
                              </div>
                              <div className="hl-form-group">
                                <label className="hl-form-label">New Size</label>
                                <input
                                  className="hl-form-input"
                                  value={orderEdits[order.oid]?.size || ''}
                                  onChange={e =>
                                    setOrderEdits(prev => ({
                                      ...prev,
                                      [order.oid]: { ...prev[order.oid], size: e.target.value },
                                    }))
                                  }
                                  placeholder={order.sz}
                                />
                              </div>
                              <div className="hl-actions">
                                <button className="hl-btn" type="button" onClick={() => handleModifyOrder(order)}>
                                  Modify
                                </button>
                                <button className="hl-btn hl-btn-danger" type="button" onClick={() => handleCancelOrder(order)}>
                                  Cancel
                                </button>
                              </div>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="hl-message">No open orders.</div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="hl-section">
                  <div className="hl-section-title">TWAP History</div>
                  <div className="hl-card">
                    <div className="hl-list">
                      {twaps.length ? (
                        twaps.map(twap => (
                          <div key={`${twap.state.coin}-${twap.time}`} className="hl-row">
                            <div className="hl-row-title">
                              {twap.state.coin} ({twap.status.status})
                            </div>
                            <div className="hl-actions">
                              {twap.status.status === 'activated' && (
                                <button className="hl-btn hl-btn-danger" onClick={() => handleCancelTwap(twap)}>
                                  Cancel
                                </button>
                              )}
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="hl-message">No TWAP history.</div>
                      )}
                    </div>
                  </div>
                </div>
              </>
            )}

            {activeTab === 'history' && (
              <>
                <div className="hl-section">
                  <div className="hl-section-title">Fills</div>
                  <div className="hl-card">
                    <div className="hl-list">
                      {fills.length ? (
                        fills.slice(0, 50).map(fill => (
                          <div key={`${fill.hash}-${fill.tid}`} className="hl-row">
                            <div className="hl-row-title">
                              {fill.coin} {fill.side === 'B' ? 'Buy' : 'Sell'}
                            </div>
                            <div className="hl-row-value">{fill.sz} @ {fill.px}</div>
                          </div>
                        ))
                      ) : (
                        <div className="hl-message">No fills yet.</div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="hl-section">
                  <div className="hl-section-title">Funding</div>
                  <div className="hl-card">
                    <div className="hl-list">
                      {funding.length ? (
                        funding.slice(0, 50).map(entry => (
                          <div key={entry.hash} className="hl-row">
                            <div className="hl-row-title">{entry.delta.coin}</div>
                            <div className="hl-row-value">{entry.delta.usdc}</div>
                          </div>
                        ))
                      ) : (
                        <div className="hl-message">No funding history.</div>
                      )}
                    </div>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>

      <div className="hl-resizer" ref={resizeRef} />
    </div>
  )
}
