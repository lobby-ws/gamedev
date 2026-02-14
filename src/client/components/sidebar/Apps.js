import { css } from '@firebolt-dev/css'
import { useEffect, useRef, useState } from 'react'
import { RocketIcon, SearchIcon, SquareCheckBigIcon, SquareIcon } from 'lucide-react'
import { cls } from '../cls'
import { theme } from '../theme'
import { sortBy } from 'lodash-es'
import { AppsList } from '../AppsList'
import { Pane } from './Pane'

const appsState = {
  query: '',
  perf: false,
  scrollTop: 0,
}

export function Apps({ world, hidden }) {
  const contentRef = useRef()
  const [query, setQuery] = useState(appsState.query)
  const [perf, setPerf] = useState(appsState.perf)
  const [refresh, setRefresh] = useState(0)
  const [tab, setTab] = useState('objects')
  const buildOrphans = () => {
    const used = new Set()
    for (const entity of world.entities.items.values()) {
      if (entity?.isApp) {
        used.add(entity.data.blueprint)
      }
    }
    const items = Array.from(world.blueprints.items.values()).filter(
      bp => !bp.scene && !used.has(bp.id) && bp.keep !== true
    )
    return sortBy(items, bp => (bp.name || bp.id || '').toLowerCase())
  }
  const [orphans, setOrphans] = useState(() => buildOrphans())
  const [cleaning, setCleaning] = useState(false)
  useEffect(() => {
    contentRef.current.scrollTop = appsState.scrollTop
  }, [])
  useEffect(() => {
    appsState.query = query
    appsState.perf = perf
  }, [query, perf])
  useEffect(() => {
    const refresh = () => setOrphans(buildOrphans())
    world.blueprints.on('add', refresh)
    world.blueprints.on('modify', refresh)
    world.blueprints.on('remove', refresh)
    world.entities.on('added', refresh)
    world.entities.on('removed', refresh)
    return () => {
      world.blueprints.off('add', refresh)
      world.blueprints.off('modify', refresh)
      world.blueprints.off('remove', refresh)
      world.entities.off('added', refresh)
      world.entities.off('removed', refresh)
    }
  }, [])
  const toggleKeep = blueprint => {
    const nextKeep = !blueprint.keep
    const version = blueprint.version + 1
    world.blueprints.modify({ id: blueprint.id, version, keep: nextKeep })
    world.admin.blueprintModify({ id: blueprint.id, version, keep: nextKeep }, { ignoreNetworkId: world.network.id })
  }
  const runClean = async () => {
    if (cleaning) return
    if (world.builder?.ensureAdminReady && !world.builder.ensureAdminReady('Clean now')) return
    if (!world.admin?.runClean) {
      world.emit('toast', 'Clean endpoint unavailable')
      return
    }
    setCleaning(true)
    try {
      await world.admin.runClean()
      world.emit('toast', 'Cleanup complete')
    } catch (err) {
      console.error(err)
      world.emit('toast', 'Cleanup failed')
    } finally {
      setCleaning(false)
    }
  }
  return (
    <Pane width={perf && tab === 'objects' ? '40rem' : '20rem'} hidden={hidden}>
      <div
        className='apps'
        css={css`
          background: ${theme.bgSection};
          border: 1px solid ${theme.borderLight};
          border-radius: ${theme.radius};
          flex: 1;
          display: flex;
          flex-direction: column;
          min-height: 17rem;
          position: relative;
          .apps-head {
            padding: 0.6rem 1rem;
            border-bottom: 1px solid ${theme.borderLight};
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
          }
          .apps-head-row {
            display: flex;
            align-items: center;
          }
          .apps-tabs {
            display: inline-flex;
            gap: 0.35rem;
            flex: 1;
          }
          .apps-tab {
            border: 1px solid rgba(255, 255, 255, 0.12);
            background: transparent;
            color: rgba(255, 255, 255, 0.6);
            font-size: 0.75rem;
            padding: 0.25rem 0.65rem;
            border-radius: ${theme.radiusSmall};
            &:hover {
              cursor: pointer;
              color: white;
              border-color: rgba(255, 255, 255, 0.35);
            }
            &.active {
              color: white;
              border-color: rgba(76, 224, 161, 0.65);
              background: rgba(76, 224, 161, 0.12);
            }
          }
          .apps-search {
            display: flex;
            align-items: center;
            input {
              margin-left: 0.5rem;
              width: 5rem;
              font-size: 0.9375rem;
              &::placeholder {
                color: #5d6077;
              }
              &::selection {
                background-color: white;
                color: rgba(0, 0, 0, 0.8);
              }
            }
          }
          .apps-toggle {
            width: 2rem;
            height: 2rem;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 0 0 1rem;
            color: #5d6077;
            &:hover {
              cursor: pointer;
            }
            &.active {
              color: white;
            }
          }
          .apps-content {
            flex: 1;
            overflow-y: auto;
          }
          .apps-orphans {
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
            padding: 1rem;
          }
          .apps-orphans-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 0.75rem;
          }
          .apps-orphans-title {
            font-weight: 500;
            font-size: 0.9rem;
          }
          .apps-orphans-clean {
            border-radius: ${theme.radiusSmall};
            border: 1px solid rgba(255, 255, 255, 0.12);
            padding: 0.35rem 0.85rem;
            font-size: 0.75rem;
            background: rgba(255, 255, 255, 0.06);
            color: rgba(255, 255, 255, 0.75);
            &:hover:not(:disabled) {
              cursor: pointer;
              color: white;
              border-color: rgba(255, 255, 255, 0.35);
            }
            &:disabled {
              opacity: 0.5;
              cursor: default;
            }
          }
          .apps-orphans-list {
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
          }
          .apps-orphan-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 0.75rem;
            padding: 0.5rem 0.75rem;
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: ${theme.radius};
            background: rgba(255, 255, 255, 0.03);
          }
          .apps-orphan-name {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-size: 0.85rem;
          }
          .apps-orphan-toggle {
            display: inline-flex;
            align-items: center;
            gap: 0.35rem;
            border: 1px solid rgba(255, 255, 255, 0.12);
            background: transparent;
            color: rgba(255, 255, 255, 0.65);
            padding: 0.25rem 0.5rem;
            border-radius: ${theme.radiusSmall};
            font-size: 0.75rem;
            &:hover {
              cursor: pointer;
              color: white;
              border-color: rgba(255, 255, 255, 0.35);
            }
            &.active {
              color: white;
              border-color: rgba(76, 224, 161, 0.65);
              background: rgba(76, 224, 161, 0.12);
            }
          }
          .apps-orphans-empty {
            font-size: 0.8rem;
            color: rgba(255, 255, 255, 0.5);
            padding: 0.5rem 0.25rem;
          }
        `}
      >
        <div className='apps-head'>
          <div className='apps-head-row'>
            <div className='apps-tabs'>
              <button
                type='button'
                className={cls('apps-tab', { active: tab === 'objects' })}
                onClick={() => setTab('objects')}
              >
                Objects
              </button>
              <button
                type='button'
                className={cls('apps-tab', { active: tab === 'orphans' })}
                onClick={() => setTab('orphans')}
              >
                Recycle Bin
              </button>
            </div>
          </div>
          {tab === 'objects' && (
            <div className='apps-head-row'>
              <label className='apps-search'>
                <SearchIcon size='1.125rem' />
                <input type='text' placeholder='Search' value={query} onChange={e => setQuery(e.target.value)} />
              </label>
              <div className={cls('apps-toggle', { active: perf })} onClick={() => setPerf(!perf)}>
                <RocketIcon size='1.125rem' />
              </div>
            </div>
          )}
        </div>
        <div
          ref={contentRef}
          className='apps-content noscrollbar'
          onScroll={e => {
            appsState.scrollTop = contentRef.current.scrollTop
          }}
        >
          {tab === 'objects' ? (
            <AppsList world={world} query={query} perf={perf} refresh={refresh} setRefresh={setRefresh} />
          ) : (
            <div className='apps-orphans'>
              <div className='apps-orphans-head'>
                <div className='apps-orphans-title'>Recycle Bin ({orphans.length})</div>
                <button
                  type='button'
                  className='apps-orphans-clean'
                  onClick={runClean}
                  disabled={!orphans.length || cleaning}
                >
                  {cleaning ? 'Cleaning...' : 'Clean now'}
                </button>
              </div>
              {orphans.length ? (
                <div className='apps-orphans-list'>
                  {orphans.map(blueprint => (
                    <div className='apps-orphan-row' key={blueprint.id}>
                      <div className='apps-orphan-name'>{blueprint.name || blueprint.id}</div>
                      <button
                        type='button'
                        className={cls('apps-orphan-toggle', { active: blueprint.keep })}
                        onClick={() => toggleKeep(blueprint)}
                      >
                        {blueprint.keep ? <SquareCheckBigIcon size='0.85rem' /> : <SquareIcon size='0.85rem' />}
                        <span>Keep</span>
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className='apps-orphans-empty'>Recycle bin is empty.</div>
              )}
            </div>
          )}
        </div>
      </div>
    </Pane>
  )
}
