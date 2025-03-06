import { css } from '@firebolt-dev/css'
import { useEffect, useState, useRef } from 'react'
import { XIcon } from 'lucide-react'
import { cls } from './cls'

export function HyperliquidPane({ world, close }) {
  const containerRef = useRef()
  const resizeRef = useRef()
  const [balance, setBalance] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [amount, setAmount] = useState('')
  const [transferStatus, setTransferStatus] = useState(null)
  const [isConnected, setIsConnected] = useState(false)

  useEffect(() => {
    const fetchBalance = async () => {
      try {
        setLoading(true)
        setError(null)
        if (!world.evm.address) {
          setIsConnected(false)
          setError('Wallet not connected')
          setLoading(false)
          return
        }
        
        setIsConnected(true)
        // Fetch real balance data from Hyperliquid
        const balanceData = await world.evm.getBalance()
        setBalance(balanceData)
        setLoading(false)
      } catch (err) {
        console.error('Failed to fetch Hyperliquid balance:', err)
        setError('Failed to fetch balance. Please try again.')
        setLoading(false)
      }
    }

    fetchBalance()
    
    // Set up polling for balance updates (every 10 seconds)
    const intervalId = setInterval(fetchBalance, 10000)
    
    return () => clearInterval(intervalId)
  }, [world.evm.address])

  const handleTransfer = async (e) => {
    e.preventDefault()
    
    if (!amount) {
      setTransferStatus({ success: false, message: 'Amount is required' })
      return
    }
    
    if (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      setTransferStatus({ success: false, message: 'Amount must be a positive number' })
      return
    }
    
    try {
      setTransferStatus({ loading: true, message: `Processing deposit...` })
      
      // Get the player entity
      const player = world.entities.player
      if (!player) {
        throw new Error("Player entity not found")
      }
      
      // Execute deposit or withdraw through game API
      const amountNum = parseFloat(amount)
      const result = await world.evm.deposit(player.data.id, amountNum)
      
      setTransferStatus({ 
        success: true, 
        message: `Deposit successful!`
      })
      setAmount('')
      
    } catch (err) {
      console.error(`Deposit failed:`, err)
      setTransferStatus({ 
        success: false, 
        message: `Deposit failed: ${err.message || err || 'Unknown error'}`
      })
    }
  }

  useEffect(() => {
    const elem = resizeRef.current
    const container = containerRef.current
    container.style.width = `400px`
    let active
    
    function onPointerDown(e) {
      active = true
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
    
    return () => {
      elem.removeEventListener('pointerdown', onPointerDown)
    }
  }, [])

  // Format USDC balance to 2 decimal places
  const formatBalance = (balance) => {
    if (!balance || !balance.cash) return '0.00'
    return parseFloat(balance.cash).toFixed(2)
  }

  // Format margin statistics
  const formatMarginValue = (value) => {
    if (!value) return '0.00'
    return typeof value === 'string' ? parseFloat(value).toFixed(2) : value.toFixed(2)
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
        background-color: rgba(15, 16, 24, 0.8);
        pointer-events: auto;
        display: flex;
        flex-direction: column;
        .hyperliquid-pane-head {
          height: 50px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          display: flex;
          align-items: center;
          padding: 0 10px 0 20px;
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
            &:hover {
              cursor: pointer;
              color: white;
            }
          }
        }
        .hyperliquid-pane-content {
          flex: 1;
          padding: 20px;
          overflow-y: auto;
        }
        .hyperliquid-pane-section {
          margin-bottom: 30px;
        }
        .hyperliquid-pane-section-title {
          font-size: 16px;
          font-weight: 500;
          margin-bottom: 10px;
          color: #fff;
        }
        .hyperliquid-pane-card {
          background-color: rgba(0, 0, 0, 0.2);
          border-radius: 6px;
          padding: 15px;
          margin-bottom: 15px;
        }
        .hyperliquid-pane-balance {
          display: flex;
          align-items: center;
          justify-content: space-between;
          &-label {
            font-size: 14px;
            color: rgba(255, 255, 255, 0.7);
          }
          &-value {
            font-size: 24px;
            font-weight: 600;
          }
        }
        .hyperliquid-pane-address {
          font-family: monospace;
          font-size: 12px;
          background: rgba(0, 0, 0, 0.2);
          padding: 10px;
          border-radius: 4px;
          overflow: hidden;
          text-overflow: ellipsis;
          margin-top: 10px;
          word-break: break-all;
        }
        .hyperliquid-pane-form {
          &-group {
            margin-bottom: 15px;
          }
          &-label {
            display: block;
            margin-bottom: 6px;
            font-size: 14px;
            color: rgba(255, 255, 255, 0.7);
          }
          &-input {
            width: 100%;
            background-color: rgba(0, 0, 0, 0.3);
            border: 1px solid rgba(255, 255, 255, 0.1);
            color: white;
            padding: 8px 12px;
            border-radius: 4px;
            &:focus {
              border-color: rgba(0, 167, 255, 0.5);
              outline: none;
            }
          }
          &-button {
            background-color: #00a7ff;
            color: white;
            border: none;
            border-radius: 4px;
            padding: 10px 16px;
            cursor: pointer;
            font-weight: 500;
            width: 100%;
            &:hover {
              background-color: #0095e6;
            }
            &:disabled {
              background-color: #333;
              cursor: not-allowed;
            }
          }
        }
        .hyperliquid-pane-message {
          margin-top: 10px;
          padding: 10px;
          border-radius: 4px;
          font-size: 14px;
          
          &.success {
            background-color: rgba(0, 128, 0, 0.2);
            color: #4caf50;
          }
          
          &.error {
            background-color: rgba(255, 0, 0, 0.2);
            color: #f44336;
          }
          
          &.loading {
            background-color: rgba(0, 0, 255, 0.1);
            color: #2196f3;
          }
        }
        .hyperliquid-pane-loading {
          display: flex;
          justify-content: center;
          align-items: center;
          padding: 20px;
          color: rgba(255, 255, 255, 0.7);
        }
        .hyperliquid-pane-connect {
          background-color: #00a7ff;
          color: white;
          border: none;
          border-radius: 4px;
          padding: 10px 16px;
          cursor: pointer;
          font-weight: 500;
          width: 100%;
          margin-top: 20px;
          &:hover {
            background-color: #0095e6;
          }
        }
        .hyperliquid-pane-resizer {
          position: absolute;
          top: 0;
          bottom: 0;
          left: -5px;
          width: 10px;
          cursor: ew-resize;
        }
        .hyperliquid-pane-stats {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
          margin-top: 10px;
          
          &-item {
            background-color: rgba(0, 0, 0, 0.2);
            padding: 10px;
            border-radius: 4px;
            
            &-label {
              font-size: 12px;
              color: rgba(255, 255, 255, 0.7);
              margin-bottom: 5px;
            }
            
            &-value {
              font-weight: 500;
            }
          }
        }
      `}
    >
      <div className="hyperliquid-pane-head">
        <div className="hyperliquid-pane-head-title">Hyperliquid</div>
        <div className="hyperliquid-pane-head-close" onClick={close}>
          <XIcon size={24} />
        </div>
      </div>
      
      <div className="hyperliquid-pane-content">
        {loading ? (
          <div className="hyperliquid-pane-loading">Loading wallet info...</div>
        ) : error ? (
          <div>
            <div className="hyperliquid-pane-message error">{error}</div>
            {!isConnected && (
              <button 
                className="hyperliquid-pane-connect" 
                onClick={() => world.evm.connect()}
              >
                Connect Wallet
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="hyperliquid-pane-section">
              <div className="hyperliquid-pane-section-title">Account Balance</div>
              <div className="hyperliquid-pane-card">
                <div className="hyperliquid-pane-balance">
                  <div className="hyperliquid-pane-balance-label">USDC</div>
                  <div className="hyperliquid-pane-balance-value">${formatBalance(balance)}</div>
                </div>
                <div className="hyperliquid-pane-address">
                  {world.evm.address}
                </div>
              </div>
            </div>
            
            {balance && (
              <div className="hyperliquid-pane-stats">
                <div className="hyperliquid-pane-stats-item">
                  <div className="hyperliquid-pane-stats-item-label">Cross Margin</div>
                  <div className="hyperliquid-pane-stats-item-value">
                    {balance.crossMarginSumUsd ? formatMarginValue(balance.crossMarginSumUsd) : '0.00'}
                  </div>
                </div>
                <div className="hyperliquid-pane-stats-item">
                  <div className="hyperliquid-pane-stats-item-label">Margin Used</div>
                  <div className="hyperliquid-pane-stats-item-value">
                    {balance.marginSummary ? formatMarginValue(balance.marginSummary.accountValue) : '0.00'}
                  </div>
                </div>
              </div>
            )}
            
            {balance && balance.positions && balance.positions.length > 0 && (
              <div className="hyperliquid-pane-section-title" style={{ marginTop: '15px' }}>
                Active Positions
              </div>
            )}
            
            <div className="hyperliquid-pane-section">
              <div className="hyperliquid-pane-section-title">Deposit USDC</div>
              
              <form className="hyperliquid-pane-form" onSubmit={handleTransfer}>
                <div className="hyperliquid-pane-form-group">
                  <label className="hyperliquid-pane-form-label">Amount (USDC)</label>
                  <input
                    type="text"
                    className="hyperliquid-pane-form-input"
                    placeholder="0.00"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    required
                  />
                </div>
                
                <button
                  type="submit"
                  className="hyperliquid-pane-form-button"
                  disabled={transferStatus?.loading}
                >
                  {transferStatus?.loading ? 'Processing...' : 'Deposit'}
                </button>
                
                {transferStatus && (
                  <div className={cls('hyperliquid-pane-message', {
                    success: transferStatus.success,
                    error: transferStatus.success === false,
                    loading: transferStatus.loading
                  })}>
                    {transferStatus.message}
                  </div>
                )}
              </form>
            </div>
          </>
        )}
      </div>
      
      <div className="hyperliquid-pane-resizer" ref={resizeRef} />
    </div>
  )
} 