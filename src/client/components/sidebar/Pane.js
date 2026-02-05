import { css } from '@firebolt-dev/css'
import { useContext } from 'react'
import { cls } from '../cls'
import { HintContext } from '../Hint'

export function Pane({ width = '20rem', hidden, children }) {
  return (
    <div
      className={cls('sidebarpane', { hidden })}
      css={css`
        width: ${width};
        max-width: 100%;
        display: flex;
        flex-direction: column;
        .sidebarpane-content {
          pointer-events: auto;
          max-height: 100%;
          display: flex;
          flex-direction: column;
        }
        &.hidden {
          opacity: 0;
          pointer-events: none;
        }
      `}
    >
      <div className='sidebarpane-content'>{children}</div>
      <Hint />
    </div>
  )
}

function Hint() {
  const { hint } = useContext(HintContext)
  if (!hint) return null
  return (
    <div
      className='hint'
      css={css`
        margin-top: 0.25rem;
        background: rgba(11, 10, 21, 0.85);
        border: 0.0625rem solid #2a2b39;
        backdrop-filter: blur(5px);
        border-radius: 1rem;
        min-width: 0;
        padding: 1rem;
        font-size: 0.9375rem;
      `}
    >
      <span>{hint}</span>
    </div>
  )
}
