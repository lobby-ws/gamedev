import { css } from '@firebolt-dev/css'
import { useState } from 'react'
import { editorTheme as theme } from './editorTheme'
import { PanelTabs } from './PanelTabs'
import { App } from '../sidebar/App'
import { Nodes } from '../sidebar/Nodes'
import { Meta } from '../sidebar/Meta'
import { exportApp } from '../../../core/extras/appTools'
import { downloadFile } from '../../../core/extras/downloadFile'

const tabs = [
  { id: 'app', label: 'Object' },
  { id: 'nodes', label: 'Nodes' },
  { id: 'meta', label: 'Meta' },
]

export function BottomPanel({ world }) {
  const app = world.ui.state.app
  const [activeTab, setActiveTab] = useState('app')
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
      className='bottom-panel'
      css={css`
        height: ${theme.bottomPanelHeight};
        background: ${theme.panelBg};
        border-top: 1px solid ${theme.panelBorder};
        display: flex;
        flex-direction: column;
        overflow: hidden;
        pointer-events: auto;
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
      </div>
    </div>
  )
}
