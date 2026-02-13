import { css } from '@firebolt-dev/css'
import { useEffect, useRef, useState } from 'react'
import { editorTheme as theme } from './editorTheme'
import { Script } from '../sidebar/Script'
import { storage } from '../../../core/storage'

export function RightPanel({ world }) {
  const panelRef = useRef()
  const resizerRef = useRef()
  const [mode, setMode] = useState(() => {
    const saved = storage.get('right-panel-mode', 'chat')
    return saved === 'code' ? 'code' : 'chat'
  })
  useEffect(() => {
    const resizer = resizerRef.current
    const panel = panelRef.current
    panel.style.width = `${storage.get('right-panel-width', 640)}px`
    function onPointerDown(e) {
      resizer.addEventListener('pointermove', onPointerMove)
      resizer.addEventListener('pointerup', onPointerUp)
      e.currentTarget.setPointerCapture(e.pointerId)
    }
    function onPointerMove(e) {
      let newWidth = panel.offsetWidth - e.movementX
      if (newWidth < 300) newWidth = 300
      if (newWidth > 900) newWidth = 900
      panel.style.width = `${newWidth}px`
      storage.set('right-panel-width', newWidth)
    }
    function onPointerUp(e) {
      e.currentTarget.releasePointerCapture(e.pointerId)
      resizer.removeEventListener('pointermove', onPointerMove)
      resizer.removeEventListener('pointerup', onPointerUp)
    }
    resizer.addEventListener('pointerdown', onPointerDown)
    return () => {
      resizer.removeEventListener('pointerdown', onPointerDown)
    }
  }, [])
  const setPanelMode = nextMode => {
    setMode(nextMode)
    storage.set('right-panel-mode', nextMode)
  }
  return (
    <div
      ref={panelRef}
      className='right-panel'
      css={css`
        background: ${theme.panelBg};
        border-left: 1px solid ${theme.panelBorder};
        display: flex;
        flex-direction: column;
        overflow: hidden;
        pointer-events: auto;
        position: relative;
        .right-panel-resizer {
          position: absolute;
          top: 0;
          bottom: 0;
          left: -5px;
          width: 10px;
          cursor: ew-resize;
          z-index: 10;
        }
        .right-panel-content {
          flex: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          > .script {
            flex: 1;
            min-height: 0;
          }
        }
        .right-panel-modes {
          height: 2.4rem;
          display: flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0 0.75rem;
          border-bottom: 1px solid ${theme.panelBorder};
        }
        .right-panel-mode {
          height: 1.7rem;
          border-radius: 0.4rem;
          border: 1px solid rgba(255, 255, 255, 0.16);
          background: transparent;
          color: rgba(255, 255, 255, 0.72);
          font-size: 0.72rem;
          padding: 0 0.6rem;
          &:hover {
            cursor: pointer;
            color: white;
            border-color: rgba(255, 255, 255, 0.3);
          }
        }
        .right-panel-mode.active {
          color: white;
          background: rgba(255, 255, 255, 0.08);
          border-color: rgba(255, 255, 255, 0.32);
        }
      `}
    >
      <div className='right-panel-resizer' ref={resizerRef} />
      <div className='right-panel-modes'>
        <button className={`right-panel-mode ${mode === 'chat' ? 'active' : ''}`} onClick={() => setPanelMode('chat')}>
          Chat
        </button>
        <button className={`right-panel-mode ${mode === 'code' ? 'active' : ''}`} onClick={() => setPanelMode('code')}>
          Code
        </button>
      </div>
      <div className='right-panel-content'>
        <Script world={world} hidden={false} viewMode={mode} />
      </div>
    </div>
  )
}
