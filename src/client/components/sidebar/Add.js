import { css } from '@firebolt-dev/css'
import { useCallback, useEffect, useRef, useState } from 'react'
import { CirclePlusIcon, SquareCheckBigIcon, SquareIcon, Trash2Icon } from 'lucide-react'
import { cls } from '../cls'
import { theme } from '../theme'
import { sortBy } from 'lodash-es'
import { uuid } from '../../../core/utils'
import { buildScriptGroups } from '../../../core/extras/blueprintGroups'
import { BUILTIN_APP_TEMPLATES } from '../../builtinApps'
import { Pane } from './Pane'

const CLIENT_BUILTIN_TEMPLATES = BUILTIN_APP_TEMPLATES.map(template => ({
  ...template,
  id: template.name,
  __builtinTemplate: true,
  __templateKey: `$builtin:${template.name}`,
  keep: true,
  unique: false,
  scene: false,
}))
const LEGACY_BUILTIN_TEMPLATE_IDS = new Set(CLIENT_BUILTIN_TEMPLATES.map(template => template.id))

function normalizeBlueprintName(value) {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase()
}

export function Add({ world, hidden }) {
  const span = 4
  const gap = '0.5rem'
  const [trashMode, setTrashMode] = useState(false)
  const [tab, setTab] = useState('templates')
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createError, setCreateError] = useState(null)
  const [creating, setCreating] = useState(false)
  const createNameRef = useRef(null)
  const isBuiltinTemplate = blueprint => blueprint?.__builtinTemplate === true
  const buildTemplates = () => {
    return sortBy([...CLIENT_BUILTIN_TEMPLATES], bp => (bp.name || bp.id || '').toLowerCase())
  }
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
  const [templates, setTemplates] = useState(() => buildTemplates())
  const [orphans, setOrphans] = useState(() => buildOrphans())
  const [cleaning, setCleaning] = useState(false)

  useEffect(() => {
    const refresh = () => {
      setTemplates(buildTemplates())
      setOrphans(buildOrphans())
    }
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

  useEffect(() => {
    if (hidden) {
      setCreateOpen(false)
      setCreating(false)
      setCreateError(null)
      setCreateName('')
    }
  }, [hidden])

  useEffect(() => {
    if (!createOpen) return
    const handle = setTimeout(() => {
      createNameRef.current?.focus()
    }, 0)
    return () => clearTimeout(handle)
  }, [createOpen])

  useEffect(() => {
    if (createOpen) return
    setCreateError(null)
    setCreateName('')
  }, [createOpen])

  const createDraft = useCallback(async () => {
    const trimmed = createName.trim()
    if (!trimmed) {
      setCreateError('Enter a name for the app.')
      return
    }
    const normalized = normalizeBlueprintName(trimmed)
    const hasCollision = Array.from(world.blueprints.items.values()).some(blueprint => {
      const existing = normalizeBlueprintName(blueprint?.name || blueprint?.id || '')
      return existing && existing === normalized
    })
    if (hasCollision) {
      setCreateError('That name is already in use.')
      return
    }
    if (!world.drafts?.createDraftApp) {
      setCreateError('Create is not available in this session.')
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      await world.drafts.createDraftApp({ name: trimmed })
      world.emit('toast', 'Draft created')
      setCreateOpen(false)
      setCreateName('')
    } catch (err) {
      const code = err?.code || err?.message
      if (code === 'builder_required') {
        setCreateError('Builder access required.')
      } else if (code === 'admin_required' || code === 'admin_code_missing' || code === 'deploy_required') {
        setCreateError('Admin code required.')
      } else if (code === 'locked' || code === 'deploy_locked' || code === 'deploy_lock_required') {
        const owner = err?.lock?.owner
        setCreateError(owner ? `Deploy locked by ${owner}.` : 'Deploy locked by another session.')
      } else if (code === 'upload_failed') {
        setCreateError('Upload failed.')
      } else {
        console.error(err)
        setCreateError('Create failed.')
      }
    } finally {
      setCreating(false)
    }
  }, [createName, world])

  const handleCreateNameKeyDown = useCallback(
    e => {
      if (e.key === 'Enter') {
        e.preventDefault()
        createDraft()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        setCreateOpen(false)
      }
    },
    [createDraft]
  )

  const add = async blueprint => {
    const transform = world.builder.getSpawnTransform(true)
    world.builder.toggle(true)
    world.builder.control.pointer.lock()
    let spawnBlueprint = blueprint
    if (isBuiltinTemplate(blueprint) || blueprint.unique) {
      const overrides = isBuiltinTemplate(blueprint) ? { unique: false } : {}
      spawnBlueprint = await world.builder.forkTemplateFromBlueprint(blueprint, 'Add', null, overrides)
      if (!spawnBlueprint) return
    }
    setTimeout(() => {
      const data = {
        id: uuid(),
        type: 'app',
        blueprint: spawnBlueprint.id,
        position: transform.position,
        quaternion: transform.quaternion,
        scale: [1, 1, 1],
        mover: world.network.id,
        uploader: null,
        pinned: false,
        props: {},
        state: {},
      }
      const app = world.entities.add(data)
      world.admin.entityAdd(data, { ignoreNetworkId: world.network.id })
      world.builder.select(app)
    }, 100)
  }

  const remove = blueprint => {
    world.ui
      .confirm({
        title: 'Delete blueprint',
        message: `Delete blueprint \"${blueprint.name || blueprint.id}\"? This cannot be undone.`,
        confirmText: 'Delete',
        cancelText: 'Cancel',
      })
      .then(async ok => {
        if (!ok) return
        try {
          await world.admin.blueprintRemove(blueprint.id)
          world.emit('toast', 'Blueprint deleted')
        } catch (err) {
          const code = err?.message || ''
          if (code === 'in_use') {
            world.emit('toast', 'Cannot delete blueprint: there are spawned entities using it.')
          } else {
            world.emit('toast', 'Blueprint delete failed')
          }
        }
      })
  }

  const handleClick = blueprint => {
    if (trashMode && !isBuiltinTemplate(blueprint)) {
      remove(blueprint)
    } else {
      void add(blueprint)
    }
  }

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

  const openCreate = () => {
    if (tab !== 'templates') return
    if (creating) return
    if (createOpen) {
      setCreateOpen(false)
      return
    }
    setCreateError(null)
    setCreateName('')
    setCreateOpen(true)
  }

  const switchTab = next => {
    setTab(next)
    if (next !== 'templates') {
      setTrashMode(false)
      setCreateOpen(false)
      setCreateError(null)
      setCreateName('')
    }
  }

  return (
    <Pane hidden={hidden}>
      <div
        className='add'
        css={css`
          background: ${theme.bgSection};
          border: 1px solid ${theme.borderLight};
          border-radius: ${theme.radius};
          display: flex;
          flex-direction: column;
          min-height: 22rem;
          max-height: 22rem;
          position: relative;
          .add-head {
            height: 3.125rem;
            padding: 0 1rem;
            border-bottom: 1px solid ${theme.borderLight};
            display: flex;
            align-items: center;
            gap: 0.5rem;
          }
          .add-tabs {
            display: inline-flex;
            gap: 0.35rem;
            flex: 1;
          }
          .add-tab {
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
          .add-action,
          .add-toggle {
            width: 1.5rem;
            height: 1.5rem;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #5d6077;
            &:hover {
              cursor: pointer;
              color: white;
            }
            &.hidden {
              visibility: hidden;
              pointer-events: none;
            }
          }
          .add-action.active {
            color: #4ce0a1;
          }
          .add-toggle {
            &.active {
              color: #ff6b6b;
            }
          }
          .add-content {
            flex: 1;
            overflow-y: auto;
            padding: 1rem;
          }
          .add-items {
            display: flex;
            align-items: stretch;
            flex-wrap: wrap;
            gap: ${gap};
          }
          .add-item {
            flex-basis: calc((100% / ${span}) - (${gap} * (${span} - 1) / ${span}));
            cursor: pointer;
          }
          .add-item.trash .add-item-image {
            border-color: rgba(255, 107, 107, 0.6);
          }
          .add-item-image {
            width: 100%;
            aspect-ratio: 1;
            background-color: #1c1d22;
            background-size: cover;
            border: 1px solid ${theme.borderLight};
            border-radius: ${theme.radius};
            margin: 0 0 0.4rem;
          }
          .add-item-name {
            text-align: center;
            font-size: 0.875rem;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .add-orphans {
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
          }
          .add-orphans-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 0.75rem;
          }
          .add-orphans-title {
            font-weight: 500;
            font-size: 0.9rem;
          }
          .add-orphans-clean {
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
          .add-orphans-list {
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
          }
          .add-orphan-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 0.75rem;
            padding: 0.5rem 0.75rem;
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: ${theme.radius};
            background: rgba(255, 255, 255, 0.03);
          }
          .add-orphan-name {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-size: 0.85rem;
          }
          .add-orphan-toggle {
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
          .add-orphans-empty {
            font-size: 0.8rem;
            color: rgba(255, 255, 255, 0.5);
            padding: 0.5rem 0.25rem;
          }
          .add-create-overlay {
            position: absolute;
            inset: 0;
            padding: 1rem;
            display: flex;
            align-items: center;
            justify-content: center;
            background: ${theme.bgSection};
            backdrop-filter: blur(6px);
          }
          .add-create-panel {
            width: 100%;
            border-radius: ${theme.radius};
            border: 1px solid rgba(255, 255, 255, 0.08);
            background: ${theme.bgPanel};
            padding: 1rem;
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
          }
          .add-create-title {
            font-weight: 600;
            font-size: 1rem;
          }
          .add-create-input {
            position: relative;
          }
          .add-create-input textarea,
          .add-create-input input {
            width: 100%;
            border-radius: ${theme.radius};
            border: 1px solid rgba(255, 255, 255, 0.08);
            background: rgba(10, 11, 18, 0.9);
            color: white;
            padding: 0.6rem 0.7rem;
            font-size: 0.9rem;
            font-family: inherit;
          }
          .add-create-input textarea {
            min-height: 7rem;
            resize: vertical;
          }
          .add-create-input input {
            height: 2.6rem;
          }
          .add-create-mentions {
            position: absolute;
            left: 0;
            right: 0;
            top: calc(100% + 0.35rem);
            background: rgba(8, 9, 14, 0.98);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: ${theme.radius};
            max-height: 12rem;
            overflow-y: auto;
            z-index: 5;
            padding: 0.35rem;
            box-shadow: 0 10px 25px rgba(0, 0, 0, 0.35);
          }
          .add-create-mention-item {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.35rem 0.5rem;
            border-radius: ${theme.radiusSmall};
            font-size: 0.75rem;
            color: rgba(255, 255, 255, 0.8);
            cursor: pointer;
          }
          .add-create-mention-item.active {
            background: rgba(76, 224, 161, 0.15);
            color: #4ce0a1;
          }
          .add-create-mention-item.disabled {
            opacity: 0.45;
            cursor: default;
          }
          .add-create-mention-icon {
            display: flex;
            align-items: center;
            color: rgba(255, 255, 255, 0.65);
          }
          .add-create-mention-path {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .add-create-mention-tag {
            font-size: 0.65rem;
            border-radius: ${theme.radiusSmall};
            border: 1px solid rgba(255, 255, 255, 0.15);
            padding: 0.1rem 0.4rem;
            color: rgba(255, 255, 255, 0.6);
            text-transform: uppercase;
            letter-spacing: 0.04em;
          }
          .add-create-mention-empty {
            padding: 0.45rem 0.6rem;
            font-size: 0.75rem;
            color: rgba(255, 255, 255, 0.5);
          }
          .add-create-attachments {
            display: flex;
            flex-direction: column;
            gap: 0.35rem;
          }
          .add-create-attachment {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.3rem 0.5rem;
            border-radius: ${theme.radiusSmall};
            border: 1px solid rgba(255, 255, 255, 0.08);
            background: rgba(8, 9, 14, 0.5);
            font-size: 0.75rem;
            color: rgba(255, 255, 255, 0.8);
          }
          .add-create-attachment-icon {
            display: flex;
            align-items: center;
            color: rgba(255, 255, 255, 0.6);
          }
          .add-create-attachment-path {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .add-create-attachment-remove {
            border: 0;
            background: transparent;
            color: rgba(255, 255, 255, 0.6);
            font-size: 0.75rem;
            &:hover {
              cursor: pointer;
              color: white;
            }
          }
          .add-create-footer {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 0.75rem;
            flex-wrap: wrap;
          }
          .add-create-hint {
            font-size: 0.7rem;
            color: rgba(255, 255, 255, 0.45);
          }
          .add-create-actions {
            display: flex;
            gap: 0.5rem;
          }
          .add-create-btn {
            border-radius: ${theme.radiusSmall};
            border: 1px solid rgba(255, 255, 255, 0.12);
            padding: 0.45rem 0.9rem;
            font-size: 0.85rem;
            cursor: pointer;
            background: rgba(255, 255, 255, 0.04);
          }
          .add-create-btn.primary {
            background: rgba(76, 224, 161, 0.2);
            border-color: rgba(76, 224, 161, 0.5);
            color: #bff6df;
          }
          .add-create-btn:disabled {
            opacity: 0.5;
            cursor: default;
          }
          .add-create-error {
            color: #ff8b8b;
            font-size: 0.85rem;
          }
        `}
      >
        <div className='add-head'>
          <div className='add-tabs'>
            <button
              type='button'
              className={cls('add-tab', { active: tab === 'templates' })}
              onClick={() => switchTab('templates')}
            >
              Templates
            </button>
            <button
              type='button'
              className={cls('add-tab', { active: tab === 'orphans' })}
              onClick={() => switchTab('orphans')}
            >
              Recycle Bin
            </button>
          </div>
          <div
            className={cls('add-action', { active: createOpen, hidden: tab !== 'templates' })}
            onClick={openCreate}
            title='Create'
          >
            <CirclePlusIcon size='1.125rem' />
          </div>
          <div
            className={cls('add-toggle', { active: trashMode, hidden: tab !== 'templates' })}
            onClick={() => tab === 'templates' && setTrashMode(!trashMode)}
          >
            <Trash2Icon size='1.125rem' />
          </div>
        </div>
        <div className='add-content noscrollbar'>
          {tab === 'templates' ? (
            <div className='add-items'>
              {templates.map(blueprint => {
                const imageUrl = blueprint.image?.url || (typeof blueprint.image === 'string' ? blueprint.image : null)
                return (
                  <div
                    className={cls('add-item', { trash: trashMode && !isBuiltinTemplate(blueprint) })}
                    key={blueprint.__templateKey || blueprint.id}
                    onClick={() => handleClick(blueprint)}
                  >
                    <div
                      className='add-item-image'
                      css={css`
                        ${imageUrl ? `background-image: url(${world.resolveURL(imageUrl)});` : ''}
                      `}
                    ></div>
                    <div className='add-item-name' title={blueprint.name || blueprint.id}>
                      {blueprint.name || blueprint.id}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className='add-orphans'>
              <div className='add-orphans-head'>
                <div className='add-orphans-title'>Recycle Bin ({orphans.length})</div>
                <button
                  type='button'
                  className='add-orphans-clean'
                  onClick={runClean}
                  disabled={!orphans.length || cleaning}
                >
                  {cleaning ? 'Cleaning...' : 'Clean now'}
                </button>
              </div>
              {orphans.length ? (
                <div className='add-orphans-list'>
                  {orphans.map(blueprint => (
                    <div className='add-orphan-row' key={blueprint.id}>
                      <div className='add-orphan-name'>{blueprint.name || blueprint.id}</div>
                      <button
                        type='button'
                        className={cls('add-orphan-toggle', { active: blueprint.keep })}
                        onClick={() => toggleKeep(blueprint)}
                      >
                        {blueprint.keep ? <SquareCheckBigIcon size='0.85rem' /> : <SquareIcon size='0.85rem' />}
                        <span>Keep</span>
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className='add-orphans-empty'>Recycle bin is empty.</div>
              )}
            </div>
          )}
        </div>
        {createOpen && (
          <div className='add-create-overlay' onMouseDown={e => e.stopPropagation()}>
            <div className='add-create-panel'>
              <div className='add-create-title'>Create App</div>
              <div className='add-create-input'>
                <input
                  ref={createNameRef}
                  placeholder='My App'
                  value={createName}
                  disabled={creating}
                  onChange={event => {
                    setCreateName(event.target.value)
                    if (createError) setCreateError(null)
                  }}
                  onKeyDown={handleCreateNameKeyDown}
                />
              </div>
              {createError && <div className='add-create-error'>{createError}</div>}
              <div className='add-create-footer'>
                <div className='add-create-hint'>Give it a unique name.</div>
                <div className='add-create-actions'>
                  <button
                    type='button'
                    className='add-create-btn'
                    onClick={() => setCreateOpen(false)}
                    disabled={creating}
                  >
                    Cancel
                  </button>
                  <button
                    type='button'
                    className='add-create-btn primary'
                    onClick={createDraft}
                    disabled={creating || !createName.trim()}
                  >
                    {creating ? 'Creating...' : 'Create'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </Pane>
  )
}
