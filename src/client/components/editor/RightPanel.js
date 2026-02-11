import { css } from '@firebolt-dev/css'
import { editorTheme as theme } from './editorTheme'
import { Script } from '../sidebar/Script'

export function RightPanel({ world }) {
  return (
    <div
      className='right-panel'
      css={css`
        width: ${theme.rightPanelWidth};
        background: ${theme.panelBg};
        border-left: 1px solid ${theme.panelBorder};
        display: flex;
        flex-direction: column;
        overflow: hidden;
        pointer-events: auto;
        .right-panel-content {
          flex: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          > .script {
            flex: 1;
            min-height: 0;
            width: auto !important;
          }
        }
      `}
    >
      <div className='right-panel-content'>
        <Script world={world} hidden={false} />
      </div>
    </div>
  )
}
