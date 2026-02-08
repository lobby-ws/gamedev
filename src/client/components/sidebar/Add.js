import { css } from '@firebolt-dev/css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BookTextIcon,
  CirclePlusIcon,
  CodeIcon,
  SquareCheckBigIcon,
  SquareIcon,
  Trash2Icon,
} from 'lucide-react'
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

function getMentionState(value, caret) {
  if (typeof value !== 'string' || !Number.isFinite(caret)) return null
  const upto = value.slice(0, caret)
  const at = upto.lastIndexOf('@')
  if (at === -1) return null
  if (at > 0 && !/\s/.test(upto[at - 1])) return null
  const query = upto.slice(at + 1)
  if (/\s/.test(query)) return null
  return { start: at, query }
}

function fuzzyScore(query, text) {
  if (!text) return 0
  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  if (!lowerQuery) return 1
  let score = 0
  let index = 0
  for (let i = 0; i < lowerQuery.length; i += 1) {
    const ch = lowerQuery[i]
    const found = lowerText.indexOf(ch, index)
    if (found === -1) return 0
    score += found === index ? 3 : 1
    index = found + 1
  }
  if (lowerText.startsWith(lowerQuery)) score += 4
  return score + lowerQuery.length / Math.max(lowerText.length, 1)
}

function fuzzyMatchList(query, entries) {
  const scored = []
  for (const entry of entries) {
    const score = fuzzyScore(query, entry.path)
    if (!score) continue
    scored.push({ entry, score })
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.entry.path.localeCompare(b.entry.path)
  })
  return scored.map(item => item.entry)
}

function resolveScriptRootBlueprint(blueprint, world) {
  if (!blueprint) return null
  const scriptRef = typeof blueprint.scriptRef === 'string' ? blueprint.scriptRef.trim() : ''
  if (scriptRef) {
    const scriptRoot = world.blueprints.get(scriptRef)
    if (!scriptRoot) return null
    return scriptRoot
  }
  if (hasScriptFiles(blueprint)) return blueprint
  const appName = getBlueprintAppName(blueprint.id)
  if (appName && appName !== blueprint.id) {
    const baseBlueprint = world.blueprints.get(appName)
    if (hasScriptFiles(baseBlueprint)) return baseBlueprint
  }
  const { getScriptGroupMain } = require('../../../core/extras/blueprintGroups')
  const groupMain = getScriptGroupMain(buildScriptGroups(world.blueprints.items), blueprint)
  if (groupMain && hasScriptFiles(groupMain)) return groupMain
  return null
}

function hasScriptFiles(blueprint) {
  const { isArray } = require('lodash-es')
  return blueprint?.scriptFiles && typeof blueprint.scriptFiles === 'object' && !isArray(blueprint.scriptFiles)
}

function getBlueprintAppName(id) {
  if (typeof id !== 'string' || !id) return ''
  if (id === '$scene') return '$scene'
  const idx = id.indexOf('__')
  return idx === -1 ? id : id.slice(0, idx)
}

export function Add({ world, hidden }) {
  const span = 4
  const gap = '0.5rem'
  const [trashMode, setTrashMode] = useState(false)
  const [tab, setTab] = useState('templates')
  const [createOpen, setCreateOpen] = useState(false)
  const [createPrompt, setCreatePrompt] = useState('')
  const [createError, setCreateError] = useState(null)
  const [creating, setCreating] = useState(false)
  const [createAttachments, setCreateAttachments] = useState([])
  const [createDocsIndex, setCreateDocsIndex] = useState([])
  const [createMention, setCreateMention] = useState(null)
  const [createScriptRoot, setCreateScriptRoot] = useState(null)
  const createPromptRef = useRef(null)
  const isBuiltinTemplate = blueprint => blueprint?.__builtinTemplate === true
  const buildTemplates = () => {
    const items = Array.from(world.blueprints.items.values()).filter(
      bp => !bp.scene && !LEGACY_BUILTIN_TEMPLATE_IDS.has(bp.id)
    )
    const groups = buildScriptGroups(world.blueprints.items)
    const mainIds = new Set()
    for (const group of groups.groups.values()) {
      if (group?.main?.id) mainIds.add(group.main.id)
    }
    const mainsOnly = items.filter(bp => {
      const scriptKey = typeof bp.script === 'string' ? bp.script.trim() : ''
      if (!scriptKey) return true
      return mainIds.has(bp.id)
    })
    return sortBy([...CLIENT_BUILTIN_TEMPLATES, ...mainsOnly], bp => (bp.name || bp.id || '').toLowerCase())
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
      setCreatePrompt('')
      setCreateAttachments([])
      setCreateMention(null)
      setCreateScriptRoot(null)
    }
  }, [hidden])

  useEffect(() => {
    if (!createOpen) return
    const handle = setTimeout(() => {
      createPromptRef.current?.focus()
    }, 0)
    return () => clearTimeout(handle)
  }, [createOpen])

  useEffect(() => {
    if (createOpen) return
    setCreateError(null)
    setCreatePrompt('')
    setCreateAttachments([])
    setCreateMention(null)
    setCreateScriptRoot(null)
  }, [createOpen])

  useEffect(() => {
    if (!createOpen) return
    const refresh = () => {
      const app = world.ui?.state?.app
      const blueprint = app?.blueprint || world.blueprints.get(app?.data?.blueprint)
      setCreateScriptRoot(resolveScriptRootBlueprint(blueprint, world))
    }
    refresh()
    world.on('ui', refresh)
    world.blueprints.on('modify', refresh)
    world.blueprints.on('add', refresh)
    world.blueprints.on('remove', refresh)
    return () => {
      world.off('ui', refresh)
      world.blueprints.off('modify', refresh)
      world.blueprints.off('add', refresh)
      world.blueprints.off('remove', refresh)
    }
  }, [createOpen, world])

  useEffect(() => {
    if (!createOpen) return
    let active = true
    const apiUrl = world.network?.apiUrl
    if (!apiUrl) {
      setCreateDocsIndex([])
      return () => {}
    }
    const loadDocs = async () => {
      try {
        const response = await fetch(`${apiUrl}/ai-docs-index`)
        if (!response.ok) throw new Error('docs_index_failed')
        const data = await response.json()
        if (!active) return
        const files = Array.isArray(data?.files) ? data.files.filter(Boolean) : []
        setCreateDocsIndex(files)
      } catch {
        if (!active) return
        setCreateDocsIndex([])
      }
    }
    loadDocs()
    return () => {
      active = false
    }
  }, [createOpen, world.network?.apiUrl])

  const createAttachmentSet = useMemo(() => {
    const set = new Set()
    for (const item of createAttachments) {
      if (!item?.type || !item?.path) continue
      set.add(`${item.type}:${item.path}`)
    }
    return set
  }, [createAttachments])
  const createFileIndex = useMemo(() => {
    const entries = []
    const scripts = createScriptRoot?.scriptFiles ? Object.keys(createScriptRoot.scriptFiles) : []
    for (const scriptPath of scripts) {
      entries.push({ type: 'script', path: scriptPath, id: `script:${scriptPath}` })
    }
    for (const docPath of createDocsIndex) {
      entries.push({ type: 'doc', path: docPath, id: `doc:${docPath}` })
    }
    entries.sort((a, b) => a.path.localeCompare(b.path))
    return entries
  }, [createDocsIndex, createScriptRoot?.scriptFiles])
  const createAttachmentPayload = useMemo(
    () => createAttachments.map(item => ({ type: item.type, path: item.path })),
    [createAttachments]
  )
  const sendCreate = useCallback(async () => {
    const trimmed = createPrompt.trim()
    if (!trimmed) {
      setCreateError('Enter a prompt to create an app.')
      return
    }
    if (!world.ai?.createFromPrompt) {
      setCreateError('AI create is not available in this session.')
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      await world.ai.createFromPrompt({
        prompt: trimmed,
        attachments: createAttachmentPayload,
        scriptRootId: createScriptRoot?.id || null,
      })
      world.emit('toast', 'Creating app...')
      setCreateOpen(false)
      setCreatePrompt('')
      setCreateAttachments([])
      setCreateMention(null)
    } catch (err) {
      const code = err?.code || err?.message
      if (code === 'ai_disabled') {
        setCreateError('AI is not configured on this server.')
      } else if (code === 'builder_required') {
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
  }, [createAttachmentPayload, createPrompt, createScriptRoot?.id, world])
  const updateCreateMention = useCallback(
    (value, caret) => {
      if (!createFileIndex.length) {
        if (createMention) setCreateMention(null)
        return
      }
      const mention = getMentionState(value, caret)
      if (!mention) {
        if (createMention) setCreateMention(null)
        return
      }
      const items = fuzzyMatchList(mention.query, createFileIndex).slice(0, 8)
      setCreateMention(prev => {
        const nextIndex = prev && prev.query === mention.query ? prev.activeIndex : 0
        const bounded = items.length > 0 ? Math.min(nextIndex, items.length - 1) : 0
        return {
          open: true,
          query: mention.query,
          start: mention.start,
          end: caret,
          items,
          activeIndex: bounded,
        }
      })
    },
    [createFileIndex, createMention]
  )
  const addCreateAttachment = useCallback(
    item => {
      if (!item?.type || !item?.path) return
      const key = `${item.type}:${item.path}`
      if (createAttachmentSet.has(key)) {
        setCreateMention(null)
        return
      }
      setCreateAttachments(current => [...current, { type: item.type, path: item.path }])
      setCreateMention(null)
      setCreatePrompt(current => {
        if (!createMention?.open) return current
        const before = current.slice(0, createMention.start)
        const after = current.slice(createMention.end)
        return `${before}${after}`
      })
      if (createMention?.open && Number.isFinite(createMention.start)) {
        const position = createMention.start
        requestAnimationFrame(() => {
          const input = createPromptRef.current
          if (!input) return
          input.focus()
          input.selectionStart = position
          input.selectionEnd = position
        })
      }
    },
    [createAttachmentSet, createMention]
  )
  const removeCreateAttachment = useCallback(item => {
    if (!item?.type || !item?.path) return
    setCreateAttachments(current =>
      current.filter(entry => entry.type !== item.type || entry.path !== item.path)
    )
  }, [])
  const handleCreatePromptChange = useCallback(
    e => {
      const value = e.target.value
      if (createError) setCreateError(null)
      setCreatePrompt(value)
      updateCreateMention(value, e.target.selectionStart)
    },
    [createError, updateCreateMention]
  )
  const handleCreatePromptKeyDown = useCallback(
    e => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'Enter' || e.code === 'Enter')) {
        e.preventDefault()
        sendCreate()
        return
      }
      if (!createMention?.open) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCreateMention(current => {
          if (!current) return current
          const next = current.activeIndex + 1 >= current.items.length ? 0 : current.activeIndex + 1
          return { ...current, activeIndex: next }
        })
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCreateMention(current => {
          if (!current) return current
          const next =
            current.activeIndex - 1 < 0 ? Math.max(current.items.length - 1, 0) : current.activeIndex - 1
          return { ...current, activeIndex: next }
        })
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const selected = createMention.items[createMention.activeIndex]
        if (selected) {
          addCreateAttachment(selected)
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setCreateMention(null)
      }
    },
    [createMention, addCreateAttachment, sendCreate]
  )
  const handleCreatePromptKeyUp = useCallback(
    e => {
      updateCreateMention(e.currentTarget.value, e.currentTarget.selectionStart)
    },
    [updateCreateMention]
  )

  const add = async blueprint => {
    const transform = world.builder.getSpawnTransform(true)
    world.builder.toggle(true)
    world.builder.control.pointer.lock()
    let spawnBlueprint = blueprint
    if (isBuiltinTemplate(blueprint)) {
      spawnBlueprint = await world.builder.forkTemplateFromBlueprint(blueprint, 'Add', null, { unique: false })
      if (!spawnBlueprint) return
    } else if (blueprint.unique) {
      spawnBlueprint = await world.builder.forkTemplateFromBlueprint(blueprint, 'Add')
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
    if (createOpen) {
      setCreateOpen(false)
      return
    }
    setCreateError(null)
    setCreatePrompt('')
    setCreateAttachments([])
    setCreateMention(null)
    setCreateOpen(true)
  }

  const switchTab = next => {
    setTab(next)
    if (next !== 'templates') {
      setTrashMode(false)
      setCreateOpen(false)
      setCreateError(null)
      setCreatePrompt('')
      setCreateAttachments([])
      setCreateMention(null)
      setCreateScriptRoot(null)
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
          }
          .add-title {
            flex: 1;
            font-weight: 500;
            font-size: 1rem;
            line-height: 1;
          }
          .add-tabs {
            display: inline-flex;
            gap: 0.35rem;
            margin-right: 0.5rem;
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
            width: 2rem;
            height: 2rem;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #5d6077;
            &:hover {
              cursor: pointer;
              color: white;
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
          .add-create-input textarea {
            width: 100%;
            min-height: 7rem;
            resize: vertical;
            border-radius: ${theme.radius};
            border: 1px solid rgba(255, 255, 255, 0.08);
            background: rgba(10, 11, 18, 0.9);
            color: white;
            padding: 0.6rem 0.7rem;
            font-size: 0.9rem;
            font-family: inherit;
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
          <div className='add-title'>Add</div>
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
          {tab === 'templates' && (
            <>
              <div className={cls('add-action', { active: createOpen })} onClick={openCreate} title='AI Create'>
                <CirclePlusIcon size='1.125rem' />
              </div>
              <div className={cls('add-toggle', { active: trashMode })} onClick={() => setTrashMode(!trashMode)}>
                <Trash2Icon size='1.125rem' />
              </div>
            </>
          )}
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
                    <div className='add-item-name' title={blueprint.name || blueprint.id}>{blueprint.name || blueprint.id}</div>
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
              <div className='add-create-title'>AI Create</div>
              <div className='add-create-input'>
                <textarea
                  ref={createPromptRef}
                  placeholder='Describe what you want to create. Use @ to attach files.'
                  value={createPrompt}
                  disabled={creating}
                  onChange={handleCreatePromptChange}
                  onKeyDown={handleCreatePromptKeyDown}
                  onKeyUp={handleCreatePromptKeyUp}
                  onBlur={() => setCreateMention(null)}
                />
                {createMention?.open && (
                  <div className='add-create-mentions' onMouseDown={e => e.preventDefault()}>
                    {createMention.items.length ? (
                      createMention.items.map((item, index) => {
                        const attached = createAttachmentSet.has(item.id)
                        return (
                          <div
                            key={item.id}
                            className={cls('add-create-mention-item', {
                              active: index === createMention.activeIndex,
                              disabled: attached,
                            })}
                            onMouseDown={e => e.preventDefault()}
                            onClick={() => {
                              if (!attached) addCreateAttachment(item)
                            }}
                          >
                            <span className='add-create-mention-icon'>
                              {item.type === 'doc' ? (
                                <BookTextIcon size='0.85rem' />
                              ) : (
                                <CodeIcon size='0.85rem' />
                              )}
                            </span>
                            <span className='add-create-mention-path'>{item.path}</span>
                            <span className='add-create-mention-tag'>{attached ? 'attached' : item.type}</span>
                          </div>
                        )
                      })
                    ) : (
                      <div className='add-create-mention-empty'>No matches</div>
                    )}
                  </div>
                )}
              </div>
              {createAttachments.length > 0 && (
                <div className='add-create-attachments'>
                  {createAttachments.map(item => (
                    <div key={`${item.type}:${item.path}`} className='add-create-attachment'>
                      <span className='add-create-attachment-icon'>
                        {item.type === 'doc' ? <BookTextIcon size='0.75rem' /> : <CodeIcon size='0.75rem' />}
                      </span>
                      <span className='add-create-attachment-path'>{item.path}</span>
                      <button
                        className='add-create-attachment-remove'
                        type='button'
                        onClick={() => removeCreateAttachment(item)}
                      >
                        x
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {createError && <div className='add-create-error'>{createError}</div>}
              <div className='add-create-footer'>
                <div className='add-create-hint'>Use @ to attach docs or scripts.</div>
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
                    onClick={sendCreate}
                    disabled={creating || !createPrompt.trim()}
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
