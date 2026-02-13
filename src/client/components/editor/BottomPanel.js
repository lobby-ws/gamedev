import { css } from '@firebolt-dev/css'
import { useEffect, useRef, useState } from 'react'
import { editorTheme as theme } from './editorTheme'
import { PanelTabs } from './PanelTabs'
import { App } from '../sidebar/App'
import { Nodes } from '../sidebar/Nodes'
import { Meta } from '../sidebar/Meta'
import { Console } from '../sidebar/Console'
import { exportApp } from '../../../core/extras/appTools'
import { downloadFile } from '../../../core/extras/downloadFile'
import { storage } from '../../../core/storage'

const tabs = [
  { id: 'app', label: 'Object' },
  { id: 'nodes', label: 'Nodes' },
  { id: 'meta', label: 'Meta' },
  { id: 'console', label: 'Console' },
]

export function BottomPanel({ world }) {
  const app = world.ui.state.app
  const [activeTab, setActiveTab] = useState('app')
  const panelRef = useRef()
  const resizerRef = useRef()
  useEffect(() => {
    const resizer = resizerRef.current
    const panel = panelRef.current
    panel.style.height = `${storage.get('bottom-panel-height', 288)}px`
    function onPointerDown(e) {
      resizer.addEventListener('pointermove', onPointerMove)
      resizer.addEventListener('pointerup', onPointerUp)
      e.currentTarget.setPointerCapture(e.pointerId)
    }
    function onPointerMove(e) {
      let newHeight = panel.offsetHeight - e.movementY
      if (newHeight < 120) newHeight = 120
      if (newHeight > 600) newHeight = 600
      panel.style.height = `${newHeight}px`
      storage.set('bottom-panel-height', newHeight)
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
  const downloadApp = async () => {
    if (!app?.blueprint) return
    try {
      const file = await exportApp(app.blueprint, world.loader.loadFile, id => world.blueprints.get(id))
      downloadFile(file)
    } catch (err) {
      console.error(err)
      world.emit('toast', 'Export failed')
    }
  }
  return (
    <div
      ref={panelRef}
      className='bottom-panel'
      css={css`
        background: ${theme.panelBg};
        border-top: 1px solid ${theme.panelBorder};
        display: flex;
        flex-direction: column;
        overflow: hidden;
        pointer-events: auto;
        position: relative;
        .bottom-panel-resizer {
          position: absolute;
          left: 0;
          right: 0;
          top: -5px;
          height: 10px;
          cursor: ns-resize;
          z-index: 10;
        }
        .bottom-panel-header {
          display: flex;
          align-items: stretch;
          flex-shrink: 0;
        }
        .bottom-panel-tabs {
          flex: 1;
        }
        .bottom-panel-export {
          display: flex;
          align-items: center;
          padding: 0 0.75rem;
          font-size: 0.8125rem;
          color: rgba(255, 255, 255, 0.5);
          cursor: pointer;
          border-bottom: 1px solid ${theme.panelBorder};
          &:hover {
            color: white;
          }
        }
        .bottom-panel-content {
          flex: 1;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          > * {
            flex: 1;
            min-height: 0;
          }
          .sidebarpane {
            width: 100%;
            flex: 1;
          }
        }
      `}
    >
      <div className='bottom-panel-resizer' ref={resizerRef} />
      <div className='bottom-panel-header'>
        <div className='bottom-panel-tabs'>
          <PanelTabs tabs={tabs} activeTab={activeTab} onSelect={setActiveTab} />
        </div>
        <div className='bottom-panel-export' onClick={downloadApp}>
          Export
        </div>
      </div>
      <div className='bottom-panel-content noscrollbar'>
        {activeTab === 'app' && <App key={app.data.id} world={world} hidden={false} />}
        {activeTab === 'nodes' && <Nodes key={app.data.id} world={world} hidden={false} />}
        {activeTab === 'meta' && <Meta key={app.data.id} world={world} hidden={false} />}
        {activeTab === 'console' && <Console world={world} />}
      </div>
    </div>
  )
}
