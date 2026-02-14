import { css } from '@firebolt-dev/css'
import { useState } from 'react'
import { ChevronRightIcon } from 'lucide-react'
import { cls } from '../cls'
import { editorTheme as theme } from './editorTheme'

export function CollapsibleSection({ label, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div
      className={cls('collapsible', { open })}
      css={css`
        border-bottom: 1px solid ${theme.panelBorder};
        .collapsible-header {
          height: 2.25rem;
          padding: 0 0.75rem;
          display: flex;
          align-items: center;
          gap: 0.375rem;
          cursor: pointer;
          color: rgba(255, 255, 255, 0.7);
          &:hover {
            color: white;
            background: ${theme.bgHover};
          }
        }
        .collapsible-icon {
          display: flex;
          align-items: center;
          transition: transform 0.15s ease;
        }
        &.open .collapsible-icon {
          transform: rotate(90deg);
        }
        .collapsible-label {
          font-size: 0.8125rem;
          font-weight: 500;
          line-height: 1;
        }
        .collapsible-body {
          display: none;
        }
        &.open .collapsible-body {
          display: block;
        }
      `}
    >
      <div className='collapsible-header' onClick={() => setOpen(!open)}>
        <div className='collapsible-icon'>
          <ChevronRightIcon size='0.875rem' />
        </div>
        <div className='collapsible-label'>{label}</div>
      </div>
      <div className='collapsible-body'>{children}</div>
    </div>
  )
}
