import { css } from '@firebolt-dev/css'
import { useEffect, useRef, useState } from 'react'
import { cls } from '../cls'

const levelColors = {
  log: 'rgba(255, 255, 255, 0.7)',
  warn: '#e5c07b',
  error: '#e06c75',
}

const sourceColors = {
  client: '#61afef',
  server: '#c678dd',
}

export function Console({ world }) {
  const [entries, setEntries] = useState(() => world.logs?.entries.slice() || [])
  const [filter, setFilter] = useState('all')
  const bottomRef = useRef()
  const containerRef = useRef()
  const autoScrollRef = useRef(true)

  useEffect(() => {
    const onEntry = () => {
      setEntries(world.logs.entries.slice())
    }
    const onClear = () => {
      setEntries([])
    }
    world.logs?.on('entry', onEntry)
    world.logs?.on('clear', onClear)
    return () => {
      world.logs?.off('entry', onEntry)
      world.logs?.off('clear', onClear)
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

  const filtered = filter === 'all' ? entries : entries.filter(e => e.source === filter)

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
          gap: 0.25rem;
          padding: 0.25rem 0.5rem;
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
          flex-shrink: 0;
        }
        .console-filter {
          font-size: 0.6875rem;
          padding: 0.125rem 0.375rem;
          border-radius: 2px;
          cursor: pointer;
          color: rgba(255, 255, 255, 0.4);
          background: transparent;
          border: 1px solid transparent;
          &:hover {
            color: rgba(255, 255, 255, 0.6);
          }
          &.active {
            color: rgba(255, 255, 255, 0.8);
            border-color: rgba(255, 255, 255, 0.12);
          }
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
          display: flex;
          align-items: flex-start;
          padding: 0.125rem 0.5rem;
          border-bottom: 1px solid rgba(255, 255, 255, 0.02);
          &:hover {
            background: rgba(255, 255, 255, 0.02);
          }
        }
        .console-source {
          font-size: 0.625rem;
          padding: 0 0.25rem;
          border-radius: 2px;
          margin-right: 0.375rem;
          flex-shrink: 0;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.02em;
          margin-top: 0.0625rem;
        }
        .console-message {
          white-space: pre-wrap;
          word-break: break-word;
          flex: 1;
          min-width: 0;
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
        <button className={cls('console-filter', { active: filter === 'all' })} onClick={() => setFilter('all')}>
          All
        </button>
        <button className={cls('console-filter', { active: filter === 'client' })} onClick={() => setFilter('client')}>
          Client
        </button>
        <button className={cls('console-filter', { active: filter === 'server' })} onClick={() => setFilter('server')}>
          Server
        </button>
        <button className='console-clear' onClick={() => world.logs?.clear()}>
          Clear
        </button>
      </div>
      <div className='console-entries noscrollbar' ref={containerRef} onScroll={onScroll}>
        {filtered.length === 0 && <div className='console-empty'>No logs</div>}
        {filtered.map(entry => (
          <div key={entry.id} className='console-entry'>
            <span className='console-source' style={{ color: sourceColors[entry.source] }}>
              {entry.source === 'server' ? 'SVR' : 'CLI'}
            </span>
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
