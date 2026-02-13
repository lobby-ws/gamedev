import { css } from '@firebolt-dev/css'
import { useEffect, useRef, useState } from 'react'

const levelColors = {
  log: 'rgba(255, 255, 255, 0.7)',
  warn: '#e5c07b',
  error: '#e06c75',
}

export function Console({ world }) {
  const [entries, setEntries] = useState(() => world.logs?.entries.slice() || [])
  const bottomRef = useRef()
  const containerRef = useRef()
  const autoScrollRef = useRef(true)

  useEffect(() => {
    try {
      world.network?.send('subscribeLogs')
    } catch {}
    const onUpdate = () => {
      setEntries(world.logs.entries.slice())
    }
    const onClear = () => {
      setEntries([])
    }
    world.logs?.on('entry', onUpdate)
    world.logs?.on('batch', onUpdate)
    world.logs?.on('clear', onClear)
    return () => {
      world.logs?.off('entry', onUpdate)
      world.logs?.off('batch', onUpdate)
      world.logs?.off('clear', onClear)
      try {
        world.network?.send('unsubscribeLogs')
      } catch {}
    }
  }, [world])

  useEffect(() => {
    if (autoScrollRef.current && bottomRef.current) {
      bottomRef.current.scrollIntoView({ block: 'end' })
    }
  }, [entries])

  const onScroll = () => {
    const el = containerRef.current
    if (!el) return
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  return (
    <div
      className='console-panel'
      css={css`
        display: flex;
        flex-direction: column;
        height: 100%;
        .console-toolbar {
          display: flex;
          align-items: center;
          padding: 0.25rem 0.5rem;
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
          flex-shrink: 0;
        }
        .console-clear {
          margin-left: auto;
          font-size: 0.6875rem;
          padding: 0.125rem 0.375rem;
          border-radius: 2px;
          cursor: pointer;
          color: rgba(255, 255, 255, 0.4);
          background: transparent;
          border: none;
          &:hover {
            color: rgba(255, 255, 255, 0.7);
          }
        }
        .console-entries {
          flex: 1;
          overflow-y: auto;
          font-family: monospace;
          font-size: 0.75rem;
          line-height: 1.4;
        }
        .console-entry {
          padding: 0.125rem 0.5rem;
          border-bottom: 1px solid rgba(255, 255, 255, 0.02);
          &:hover {
            background: rgba(255, 255, 255, 0.02);
          }
        }
        .console-message {
          white-space: pre-wrap;
          word-break: break-word;
        }
        .console-empty {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100%;
          color: rgba(255, 255, 255, 0.2);
          font-size: 0.75rem;
        }
      `}
    >
      <div className='console-toolbar'>
        <button className='console-clear' onClick={() => world.logs?.clear()}>
          Clear
        </button>
      </div>
      <div className='console-entries noscrollbar' ref={containerRef} onScroll={onScroll}>
        {entries.length === 0 && <div className='console-empty'>No server logs yet. Use DevTools for client logs.</div>}
        {entries.map(entry => (
          <div key={entry.id} className='console-entry'>
            <span className='console-message' style={{ color: levelColors[entry.level] }}>
              {entry.args.join(' ')}
            </span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
