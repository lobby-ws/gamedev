import { css } from '@firebolt-dev/css'
import { cls } from '../cls'
import { editorTheme as theme } from './editorTheme'

export function PanelTabs({ tabs, activeTab, onSelect }) {
  return (
    <div
      className='panel-tabs'
      css={css`
        display: flex;
        align-items: stretch;
        height: 2.25rem;
        border-bottom: 1px solid ${theme.panelBorder};
        .panel-tab {
          padding: 0 0.875rem;
          display: flex;
          align-items: center;
          font-size: 0.8125rem;
          color: rgba(255, 255, 255, 0.5);
          cursor: pointer;
          border-bottom: 2px solid transparent;
          &:hover {
            color: rgba(255, 255, 255, 0.8);
          }
          &.active {
            color: white;
            border-bottom-color: rgba(255, 255, 255, 0.6);
          }
        }
      `}
    >
      {tabs.map(tab => (
        <div
          key={tab.id}
          className={cls('panel-tab', { active: activeTab === tab.id })}
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
        </div>
      ))}
    </div>
  )
}
