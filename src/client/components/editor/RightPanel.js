import { css } from '@firebolt-dev/css'
import { useEffect, useRef } from 'react'
import { editorTheme as theme } from './editorTheme'
import { Script } from '../sidebar/Script'
import { storage } from '../../../core/storage'

export function RightPanel({ world }) {
  const panelRef = useRef()
  const resizerRef = useRef()
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
      `}
    >
      <div className='right-panel-resizer' ref={resizerRef} />
      <div className='right-panel-content'>
        <Script world={world} hidden={false} />
      </div>
    </div>
  )
}
