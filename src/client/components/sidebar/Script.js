import { css } from '@firebolt-dev/css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BookTextIcon,
  ChevronDownIcon,
  CodeIcon,
  LoaderPinwheelIcon,
  SparkleIcon,
} from 'lucide-react'
import { cls } from '../cls'
import { theme } from '../theme'
import { isArray } from 'lodash-es'
import { ScriptFilesEditor } from '../ScriptFilesEditor'
import { buildScriptGroups, getScriptGroupMain } from '../../../core/extras/blueprintGroups'
import { storage } from '../../../core/storage'

function hasScriptFiles(blueprint) {
  return blueprint?.scriptFiles && typeof blueprint.scriptFiles === 'object' && !isArray(blueprint.scriptFiles)
}

function getBlueprintAppName(id) {
  if (typeof id !== 'string' || !id) return ''
  if (id === '$scene') return '$scene'
  const idx = id.indexOf('__')
  return idx === -1 ? id : id.slice(0, idx)
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
  const groupMain = getScriptGroupMain(buildScriptGroups(world.blueprints.items), blueprint)
  if (groupMain && hasScriptFiles(groupMain)) return groupMain
  return null
}

function formatScriptError(error) {
  if (!error) {
    return { title: 'No script error detected.', detail: '' }
  }
  const name = error.name || 'Error'
  const message = error.message || ''
  const title = message ? `${name}: ${message}` : name
  const locationParts = []
  if (error.fileName) {
    locationParts.push(error.fileName)
  }
  if (error.lineNumber) {
    locationParts.push(error.lineNumber)
  }
  if (error.columnNumber) {
    locationParts.push(error.columnNumber)
  }
  const location = locationParts.length ? `at ${locationParts.join(':')}` : ''
  let detail = ''
  if (location) {
    detail = location
  }
  if (error.stack) {
    const lines = String(error.stack).split('\n').slice(0, 6).join('\n')
    detail = detail ? `${detail}\n${lines}` : lines
  }
  return { title, detail }
}

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

export function Script({ world, hidden }) {
  const app = world.ui.state.app
  const containerRef = useRef()
  const resizeRef = useRef()
  const [handle, setHandle] = useState(null)
  const [scriptRoot, setScriptRoot] = useState(() =>
    resolveScriptRootBlueprint(world.blueprints.get(app.data.blueprint) || app.blueprint, world)
  )
  const moduleRoot = hasScriptFiles(scriptRoot) ? scriptRoot : null
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiMode, setAiMode] = useState('edit')
  const [aiStatus, setAiStatus] = useState(null)
  const [aiExpanded, setAiExpanded] = useState(true)
  const aiRequestRef = useRef(null)
  const aiPromptRef = useRef(null)
  const [aiAttachments, setAiAttachments] = useState([])
  const [aiDocsIndex, setAiDocsIndex] = useState([])
  const [aiMention, setAiMention] = useState(null)
  const scriptError = app?.scriptError || null
  const errorInfo = useMemo(() => formatScriptError(scriptError), [scriptError])
  const fileCount = moduleRoot?.scriptFiles ? Object.keys(moduleRoot.scriptFiles).length : 0
  const entryPath = moduleRoot?.scriptEntry || ''
  const scriptFormat = moduleRoot?.scriptFormat || 'module'
  const aiHasProposal = !!handle?.ai?.active
  const aiPending = aiStatus?.type === 'pending'
  const canBuild = !!world.builder?.canBuild?.()
  const aiAccessIssue = world.isAdminClient
    ? 'AI requests are not available on admin connections.'
    : !canBuild
      ? 'Builder access required.'
      : null
  const aiCanUse = !!moduleRoot && !aiAccessIssue && !!world.aiScripts?.requestEdit
  const aiCanSendEdit = aiCanUse && !aiPending && !aiHasProposal && !!aiPrompt.trim()
  const aiCanSendFix = aiCanUse && !aiPending && !aiHasProposal && !!scriptError
  const aiCanSend = aiMode === 'fix' ? aiCanSendFix : aiCanSendEdit
  const aiMetaClass = cls('script-ai-meta', {
    ready: aiHasProposal,
    pending: aiPending,
    error: aiStatus?.type === 'error',
  })
  const aiMeta = useMemo(() => {
    if (aiHasProposal) return 'Changes ready to review'
    if (aiPending) return 'Generating changes...'
    if (aiStatus?.type === 'error') return 'Last request failed'
    if (aiMode === 'fix') {
      return scriptError ? 'Fix the latest script error' : 'No script error to fix'
    }
    return 'Ask for edits or fixes'
  }, [aiHasProposal, aiPending, aiStatus?.type, aiMode, scriptError])
  const aiAttachmentSet = useMemo(() => {
    const set = new Set()
    for (const item of aiAttachments) {
      if (!item?.type || !item?.path) continue
      set.add(`${item.type}:${item.path}`)
    }
    return set
  }, [aiAttachments])
  const aiFileIndex = useMemo(() => {
    const entries = []
    const scripts = moduleRoot?.scriptFiles ? Object.keys(moduleRoot.scriptFiles) : []
    for (const scriptPath of scripts) {
      entries.push({
        type: 'script',
        path: scriptPath,
        id: `script:${scriptPath}`,
      })
    }
    for (const docPath of aiDocsIndex) {
      entries.push({
        type: 'doc',
        path: docPath,
        id: `doc:${docPath}`,
      })
    }
    entries.sort((a, b) => a.path.localeCompare(b.path))
    return entries
  }, [aiDocsIndex, moduleRoot?.scriptFiles])
  const aiAttachmentPayload = useMemo(
    () => aiAttachments.map(item => ({ type: item.type, path: item.path })),
    [aiAttachments]
  )
  useEffect(() => {
    const refresh = () => {
      const blueprint = world.blueprints.get(app.data.blueprint) || app.blueprint
      setScriptRoot(resolveScriptRootBlueprint(blueprint, world))
    }
    refresh()
    const onModify = bp => {
      if (!bp?.id) return
      const baseId = getBlueprintAppName(app.data.blueprint)
      if (bp.id === app.data.blueprint || bp.id === baseId || bp.id === scriptRoot?.id) {
        refresh()
      }
    }
    world.blueprints.on('modify', onModify)
    world.blueprints.on('add', onModify)
    world.blueprints.on('remove', onModify)
    return () => {
      world.blueprints.off('modify', onModify)
      world.blueprints.off('add', onModify)
      world.blueprints.off('remove', onModify)
    }
  }, [app.data.blueprint, world, scriptRoot?.id])
  useEffect(() => {
    setAiPrompt('')
    setAiMode('edit')
    setAiStatus(null)
    setAiAttachments([])
    setAiMention(null)
    aiRequestRef.current = null
  }, [moduleRoot?.id])
  useEffect(() => {
    let active = true
    const apiUrl = world.network?.apiUrl
    if (!apiUrl) {
      setAiDocsIndex([])
      return () => { }
    }
    const loadDocs = async () => {
      try {
        const response = await fetch(`${apiUrl}/ai-docs-index`)
        if (!response.ok) {
          throw new Error('docs_index_failed')
        }
        const data = await response.json()
        if (!active) return
        const files = Array.isArray(data?.files) ? data.files.filter(Boolean) : []
        setAiDocsIndex(files)
      } catch (err) {
        if (!active) return
        setAiDocsIndex([])
      }
    }
    loadDocs()
    return () => {
      active = false
    }
  }, [world.network?.apiUrl])
  useEffect(() => {
    if (aiMode === 'fix' && !scriptError) {
      setAiMode('edit')
    }
  }, [aiMode, scriptError])
  useEffect(() => {
    if (aiMode !== 'edit') {
      setAiMention(null)
    }
  }, [aiMode])
  useEffect(() => {
    if (aiPending || aiHasProposal || aiStatus?.type === 'error') {
      setAiExpanded(true)
    }
  }, [aiPending, aiHasProposal, aiStatus?.type])
  useEffect(() => {
    if (!aiHasProposal && aiStatus?.type === 'ready') {
      setAiStatus(null)
    }
  }, [aiHasProposal, aiStatus?.type])
  useEffect(() => {
    const onRequest = payload => {
      if (!payload) return
      const rootId = typeof payload.scriptRootId === 'string' ? payload.scriptRootId : null
      if (moduleRoot?.id && rootId && rootId !== moduleRoot.id) return
      aiRequestRef.current = payload.requestId || null
      const mode = payload.mode === 'fix' ? 'fix' : 'edit'
      setAiMode(mode)
      if (typeof payload.prompt === 'string') {
        setAiPrompt(payload.prompt)
      }
      setAiStatus({
        type: 'pending',
        message: mode === 'fix' ? 'Fixing script error...' : 'Generating changes...',
      })
      setAiExpanded(true)
    }
    const onResponse = payload => {
      if (!payload) return
      const rootId = typeof payload.scriptRootId === 'string' ? payload.scriptRootId : null
      if (moduleRoot?.id && rootId && rootId !== moduleRoot.id) return
      if (aiRequestRef.current && payload.requestId && payload.requestId !== aiRequestRef.current) return
      aiRequestRef.current = null
      if (payload.error) {
        setAiStatus({
          type: 'error',
          message: payload.message || 'AI request failed.',
        })
      } else {
        setAiStatus({
          type: 'ready',
          message: 'AI changes ready to review.',
          summary: payload.summary || '',
          source: payload.source || '',
          fileCount: payload.fileCount || 0,
        })
      }
      setAiExpanded(true)
    }
    world.on('script-ai-request', onRequest)
    world.on('script-ai-response', onResponse)
    return () => {
      world.off('script-ai-request', onRequest)
      world.off('script-ai-response', onResponse)
    }
  }, [world, moduleRoot?.id])
  const updateAiMention = useCallback(
    (value, caret) => {
      if (!aiFileIndex.length) {
        if (aiMention) setAiMention(null)
        return
      }
      const mention = getMentionState(value, caret)
      if (!mention) {
        if (aiMention) setAiMention(null)
        return
      }
      const items = fuzzyMatchList(mention.query, aiFileIndex).slice(0, 8)
      setAiMention(prev => {
        const nextIndex =
          prev && prev.query === mention.query ? prev.activeIndex : 0
        const bounded =
          items.length > 0 ? Math.min(nextIndex, items.length - 1) : 0
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
    [aiFileIndex, aiMention]
  )
  const addAiAttachment = useCallback(
    item => {
      if (!item?.type || !item?.path) return
      const key = `${item.type}:${item.path}`
      if (aiAttachmentSet.has(key)) {
        setAiMention(null)
        return
      }
      setAiAttachments(current => [...current, { type: item.type, path: item.path }])
      setAiMention(null)
      setAiPrompt(current => {
        if (!aiMention?.open) return current
        const before = current.slice(0, aiMention.start)
        const after = current.slice(aiMention.end)
        return `${before}${after}`
      })
      if (aiMention?.open && Number.isFinite(aiMention.start)) {
        const position = aiMention.start
        requestAnimationFrame(() => {
          const input = aiPromptRef.current
          if (!input) return
          input.focus()
          input.selectionStart = position
          input.selectionEnd = position
        })
      }
    },
    [aiAttachmentSet, aiMention]
  )
  const removeAiAttachment = useCallback(item => {
    if (!item?.type || !item?.path) return
    setAiAttachments(current =>
      current.filter(entry => entry.type !== item.type || entry.path !== item.path)
    )
  }, [])
  const sendAiEdit = useCallback(() => {
    if (aiAccessIssue) {
      setAiStatus({ type: 'error', message: aiAccessIssue })
      return
    }
    if (!world.aiScripts?.requestEdit) {
      setAiStatus({ type: 'error', message: 'AI scripts are not available in this session.' })
      return
    }
    if (aiPending || aiHasProposal) {
      setAiStatus({
        type: 'error',
        message: 'Apply or discard the current AI changes before requesting new ones.',
      })
      return
    }
    const trimmed = aiPrompt.trim()
    if (!trimmed) {
      setAiStatus({ type: 'error', message: 'Enter a prompt to request edits.' })
      return
    }
    const requestId = world.aiScripts.requestEdit({
      prompt: trimmed,
      app,
      attachments: aiAttachmentPayload,
    })
    if (!requestId) return
    aiRequestRef.current = requestId
    setAiStatus({ type: 'pending', message: 'Generating changes...' })
    setAiExpanded(true)
  }, [aiAccessIssue, aiPending, aiHasProposal, aiPrompt, world, app, aiAttachmentPayload])
  const sendAiFix = useCallback(() => {
    if (aiAccessIssue) {
      setAiStatus({ type: 'error', message: aiAccessIssue })
      return
    }
    if (!world.aiScripts?.requestFix) {
      setAiStatus({ type: 'error', message: 'AI scripts are not available in this session.' })
      return
    }
    if (aiPending || aiHasProposal) {
      setAiStatus({
        type: 'error',
        message: 'Apply or discard the current AI changes before requesting new ones.',
      })
      return
    }
    if (!scriptError) {
      setAiStatus({ type: 'error', message: 'No script error detected.' })
      return
    }
    const requestId = world.aiScripts.requestFix({ app, attachments: aiAttachmentPayload })
    if (!requestId) return
    aiRequestRef.current = requestId
    setAiStatus({ type: 'pending', message: 'Fixing script error...' })
    setAiExpanded(true)
  }, [aiAccessIssue, aiPending, aiHasProposal, scriptError, world, app, aiAttachmentPayload])
  const sendAiRequest = useCallback(() => {
    if (aiMode === 'fix') {
      sendAiFix()
    } else {
      sendAiEdit()
    }
  }, [aiMode, sendAiFix, sendAiEdit])
  const handlePromptChange = useCallback(
    e => {
      const value = e.target.value
      if (aiStatus?.type === 'error') setAiStatus(null)
      setAiPrompt(value)
      updateAiMention(value, e.target.selectionStart)
    },
    [aiStatus?.type, updateAiMention]
  )
  const handlePromptKeyDown = useCallback(
    e => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'Enter' || e.code === 'Enter')) {
        e.preventDefault()
        sendAiEdit()
        return
      }
      if (!aiMention?.open) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAiMention(current => {
          if (!current) return current
          const next =
            current.activeIndex + 1 >= current.items.length
              ? 0
              : current.activeIndex + 1
          return { ...current, activeIndex: next }
        })
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAiMention(current => {
          if (!current) return current
          const next =
            current.activeIndex - 1 < 0
              ? Math.max(current.items.length - 1, 0)
              : current.activeIndex - 1
          return { ...current, activeIndex: next }
        })
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const selected = aiMention.items[aiMention.activeIndex]
        if (selected) {
          addAiAttachment(selected)
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setAiMention(null)
      }
    },
    [aiMention, addAiAttachment, sendAiEdit]
  )
  const handlePromptKeyUp = useCallback(
    e => {
      updateAiMention(e.currentTarget.value, e.currentTarget.selectionStart)
    },
    [updateAiMention]
  )
  useEffect(() => {
    const elem = resizeRef.current
    const container = containerRef.current
    container.style.width = `${storage.get('code-editor-width', 500)}px`
    let active
    function onPointerDown(e) {
      active = true
      elem.addEventListener('pointermove', onPointerMove)
      elem.addEventListener('pointerup', onPointerUp)
      e.currentTarget.setPointerCapture(e.pointerId)
    }
    function onPointerMove(e) {
      let newWidth = container.offsetWidth + e.movementX
      if (newWidth < 250) newWidth = 250
      container.style.width = `${newWidth}px`
      storage.set('code-editor-width', newWidth)
    }
    function onPointerUp(e) {
      e.currentTarget.releasePointerCapture(e.pointerId)
      elem.removeEventListener('pointermove', onPointerMove)
      elem.removeEventListener('pointerup', onPointerUp)
    }
    elem.addEventListener('pointerdown', onPointerDown)
    return () => {
      elem.removeEventListener('pointerdown', onPointerDown)
    }
  }, [])
  return (
    <div
      ref={containerRef}
      className={cls('script', { hidden })}
      css={css`
        pointer-events: auto;
        align-self: stretch;
        background: ${theme.bgSection};
        border: 1px solid ${theme.borderLight};
        border-radius: ${theme.radius};
        display: flex;
        flex-direction: column;
        align-items: stretch;
        min-height: 23.7rem;
        position: relative;
        .script-head {
          height: 3.125rem;
          padding: 0 1rem;
          display: flex;
          align-items: center;
          border-bottom: 1px solid ${theme.borderLight};
          gap: 0.75rem;
        }
        .script-title {
          flex: 1;
          font-weight: 500;
          font-size: 1rem;
          line-height: 1;
        }
        .script-note {
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.45);
          white-space: nowrap;
        }
        .script-actions {
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }
        .script-action {
          height: 2rem;
          padding: 0 0.75rem;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: ${theme.radiusSmall};
          border: 1px solid rgba(255, 255, 255, 0.15);
          background: transparent;
          color: rgba(255, 255, 255, 0.8);
          font-size: 0.8rem;
          &:hover {
            cursor: pointer;
            border-color: rgba(255, 255, 255, 0.3);
            color: white;
          }
          &:disabled {
            opacity: 0.5;
            cursor: default;
          }
        }
        .script-status {
          font-size: 0.75rem;
          padding: 0.5rem 1rem;
          border-bottom: 1px solid ${theme.borderLight};
        }
        .script-status.error {
          color: #ff6b6b;
        }
        .script-status.conflict {
          color: #ffb74d;
        }
        .script-status.ai {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
          color: rgba(255, 255, 255, 0.85);
        }
        .script-ai-actions {
          display: flex;
          gap: 0.5rem;
        }
        .script-ai-action {
          height: 1.8rem;
          padding: 0 0.7rem;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: ${theme.radiusSmall};
          border: 1px solid rgba(255, 255, 255, 0.15);
          background: transparent;
          color: rgba(255, 255, 255, 0.8);
          font-size: 0.75rem;
          &:hover {
            cursor: pointer;
            border-color: rgba(255, 255, 255, 0.3);
            color: white;
          }
          &:disabled {
            opacity: 0.5;
            cursor: default;
          }
        }
        .script-ai-panel {
          padding: 0.75rem 1rem;
          border-bottom: 1px solid ${theme.borderLight};
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
        }
        .script-ai-panel-head {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          background: transparent;
          border: 0;
          padding: 0;
          color: inherit;
          text-align: left;
          &:hover {
            cursor: pointer;
          }
        }
        .script-ai-title {
          display: flex;
          align-items: center;
          gap: 0.35rem;
          font-size: 0.85rem;
          font-weight: 600;
          color: rgba(255, 255, 255, 0.85);
        }
        .script-ai-meta {
          margin-left: auto;
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.5);
        }
        .script-ai-meta.ready {
          color: #00a7ff;
        }
        .script-ai-meta.pending {
          color: rgba(255, 255, 255, 0.75);
        }
        .script-ai-meta.error {
          color: #ff6b6b;
        }
        .script-ai-toggle {
          width: 1.4rem;
          height: 1.4rem;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: ${theme.radiusSmall};
          border: 1px solid rgba(255, 255, 255, 0.15);
          color: rgba(255, 255, 255, 0.75);
        }
        .script-ai-toggle.open svg {
          transform: rotate(180deg);
        }
        .script-ai-panel-body {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
        }
        .script-ai-proposal {
          padding: 0.75rem;
          border-radius: ${theme.radius};
          border: 1px solid rgba(0, 167, 255, 0.28);
          background: rgba(0, 167, 255, 0.08);
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }
        .script-ai-proposal-title {
          font-size: 0.75rem;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: rgba(255, 255, 255, 0.6);
        }
        .script-ai-proposal-summary {
          font-size: 0.85rem;
          color: rgba(255, 255, 255, 0.9);
        }
        .script-ai-proposal-meta {
          font-size: 0.7rem;
          color: rgba(255, 255, 255, 0.55);
        }
        .script-ai-modes {
          display: flex;
          gap: 0.5rem;
          flex-wrap: wrap;
        }
        .script-ai-mode {
          height: 1.8rem;
          padding: 0 0.75rem;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: ${theme.radiusSmall};
          border: 1px solid rgba(255, 255, 255, 0.15);
          background: transparent;
          color: rgba(255, 255, 255, 0.75);
          font-size: 0.75rem;
          &:hover {
            cursor: pointer;
            border-color: rgba(255, 255, 255, 0.3);
            color: white;
          }
          &:disabled {
            opacity: 0.4;
            cursor: default;
          }
        }
        .script-ai-mode.active {
          border-color: rgba(0, 167, 255, 0.5);
          color: #00a7ff;
          background: rgba(0, 167, 255, 0.12);
        }
        .script-ai-input {
          position: relative;
          border-radius: ${theme.radius};
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: ${theme.bgInput};
          padding: 0.5rem 0.75rem;
        }
        .script-ai-input textarea {
          min-height: 4.75rem;
          resize: vertical;
          line-height: 1.45;
          font-size: 0.8rem;
          color: rgba(255, 255, 255, 0.9);
        }
        .script-ai-mentions {
          position: absolute;
          left: 0;
          right: 0;
          top: calc(100% + 0.35rem);
          background: ${theme.bgInputSolid};
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: ${theme.radius};
          max-height: 12rem;
          overflow-y: auto;
          z-index: 5;
          padding: 0.35rem;
          box-shadow: 0 10px 25px rgba(0, 0, 0, 0.35);
        }
        .script-ai-mention-item {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.35rem 0.5rem;
          border-radius: ${theme.radiusSmall};
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.8);
          cursor: pointer;
        }
        .script-ai-mention-item.active {
          background: rgba(0, 167, 255, 0.15);
          color: #00a7ff;
        }
        .script-ai-mention-item.disabled {
          opacity: 0.45;
          cursor: default;
        }
        .script-ai-mention-icon {
          display: flex;
          align-items: center;
          color: rgba(255, 255, 255, 0.65);
        }
        .script-ai-mention-path {
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .script-ai-mention-tag {
          font-size: 0.65rem;
          border-radius: ${theme.radiusSmall};
          border: 1px solid rgba(255, 255, 255, 0.15);
          padding: 0.1rem 0.4rem;
          color: rgba(255, 255, 255, 0.6);
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .script-ai-mention-empty {
          padding: 0.45rem 0.6rem;
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.5);
        }
        .script-ai-attachments {
          display: flex;
          flex-direction: column;
          gap: 0.35rem;
        }
        .script-ai-attachment {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.3rem 0.5rem;
          border-radius: ${theme.radiusSmall};
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: ${theme.bgInput};
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.8);
        }
        .script-ai-attachment-icon {
          display: flex;
          align-items: center;
          color: rgba(255, 255, 255, 0.6);
        }
        .script-ai-attachment-path {
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .script-ai-attachment-remove {
          border: 0;
          background: transparent;
          color: rgba(255, 255, 255, 0.6);
          font-size: 0.75rem;
          &:hover {
            cursor: pointer;
            color: white;
          }
        }
        .script-ai-error {
          border-radius: ${theme.radius};
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: ${theme.bgInput};
          padding: 0.75rem;
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
        }
        .script-ai-error-title {
          font-size: 0.7rem;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: rgba(255, 255, 255, 0.55);
        }
        .script-ai-error-summary {
          font-size: 0.8rem;
          color: rgba(255, 255, 255, 0.85);
        }
        .script-ai-error-text {
          font-size: 0.7rem;
          white-space: pre-wrap;
          color: rgba(255, 255, 255, 0.55);
          max-height: 8rem;
          overflow: auto;
        }
        .script-ai-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.75rem;
          flex-wrap: wrap;
        }
        .script-ai-hint {
          font-size: 0.7rem;
          color: rgba(255, 255, 255, 0.45);
        }
        .script-ai-buttons {
          display: flex;
          gap: 0.5rem;
        }
        .script-ai-btn {
          height: 1.8rem;
          padding: 0 0.75rem;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: ${theme.radiusSmall};
          border: 1px solid rgba(255, 255, 255, 0.15);
          background: transparent;
          color: rgba(255, 255, 255, 0.8);
          font-size: 0.75rem;
          &:hover {
            cursor: pointer;
            border-color: rgba(255, 255, 255, 0.3);
            color: white;
          }
          &:disabled {
            opacity: 0.4;
            cursor: default;
          }
        }
        .script-ai-btn.primary {
          border-color: rgba(0, 167, 255, 0.5);
          color: #00a7ff;
        }
        .script-ai-status {
          font-size: 0.75rem;
          display: flex;
          align-items: center;
          gap: 0.4rem;
          color: rgba(255, 255, 255, 0.65);
        }
        .script-ai-status.pending {
          color: rgba(255, 255, 255, 0.75);
        }
        .script-ai-status.error {
          color: #ff6b6b;
        }
        .script-ai-spinner {
          animation: scriptAiSpin 1.1s linear infinite;
        }
        @keyframes scriptAiSpin {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }
        .script-resizer {
          position: absolute;
          top: 0;
          bottom: 0;
          right: -5px;
          width: 10px;
          cursor: ew-resize;
        }
        &.hidden {
          opacity: 0;
          pointer-events: none;
        }
      `}
    >
      <div className='script-head'>
        <div className='script-title'>Script: {app.blueprint?.name}</div>
        <div className='script-note'>
          {moduleRoot
            ? handle?.dirtyCount
              ? `${handle.dirtyCount} unsaved file${handle.dirtyCount === 1 ? '' : 's'}`
              : 'Module sources'
            : 'Code is managed by dev server'}
        </div>
        <div className='script-actions'>
          {moduleRoot && (
            <>
              <button
                className='script-action'
                type='button'
                disabled={!handle?.dirty || handle?.saving}
                onClick={() => handle?.save?.()}
              >
                {handle?.saving ? 'Saving...' : 'Save'}
              </button>
              <button
                className='script-action'
                type='button'
                disabled={handle?.saving || !handle?.refresh}
                onClick={() => handle?.refresh?.()}
              >
                Refresh
              </button>
              {handle?.conflict && (
                <button
                  className='script-action'
                  type='button'
                  disabled={handle?.saving}
                  onClick={() => handle?.retry?.()}
                >
                  Retry
                </button>
              )}
            </>
          )}
          <button className='script-action' type='button' onClick={() => handle?.copy?.()}>
            Copy
          </button>
        </div>
      </div>
      {moduleRoot && (handle?.error || handle?.conflict) && (
        <div className={cls('script-status', { error: handle?.error, conflict: handle?.conflict })}>
          {handle?.error || handle?.conflict}
        </div>
      )}
      {moduleRoot && (
        <div className='script-ai-panel'>
          <button
            className='script-ai-panel-head'
            type='button'
            onClick={() => setAiExpanded(open => !open)}
          >
            <div className='script-ai-title'>
              <SparkleIcon size='0.9rem' />
              AI Prompts
            </div>
            <div className={aiMetaClass}>{aiMeta}</div>
            <div className={cls('script-ai-toggle', { open: aiExpanded })}>
              <ChevronDownIcon size='1rem' />
            </div>
          </button>
          {aiExpanded && (
            <div className='script-ai-panel-body'>
              {aiHasProposal ? (
                <div className='script-ai-proposal'>
                  <div className='script-ai-proposal-title'>AI proposal ready</div>
                  <div className='script-ai-proposal-summary'>
                    {handle?.ai?.summary ||
                      `${handle?.ai?.fileCount || 0} file${handle?.ai?.fileCount === 1 ? '' : 's'
                      } changed`}
                  </div>
                  <div className='script-ai-proposal-meta'>
                    {handle?.ai?.source ? `Source: ${handle.ai.source}` : 'Review and apply changes'}
                  </div>
                  <div className='script-ai-actions'>
                    <button
                      className='script-ai-action'
                      type='button'
                      onClick={() => handle?.ai?.togglePreview?.()}
                    >
                      {handle?.ai?.previewOpen ? 'Close Review' : 'Review'}
                    </button>
                    <button
                      className='script-ai-action'
                      type='button'
                      disabled={handle?.saving}
                      onClick={() => handle?.ai?.commit?.()}
                    >
                      Apply
                    </button>
                    <button
                      className='script-ai-action'
                      type='button'
                      disabled={handle?.saving}
                      onClick={() => handle?.ai?.discard?.()}
                    >
                      Discard
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className='script-ai-modes'>
                    <button
                      className={cls('script-ai-mode', { active: aiMode === 'edit' })}
                      type='button'
                      onClick={() => {
                        if (aiStatus?.type === 'error') setAiStatus(null)
                        setAiMode('edit')
                      }}
                    >
                      Edit
                    </button>
                    <button
                      className={cls('script-ai-mode', { active: aiMode === 'fix' })}
                      type='button'
                      disabled={!scriptError}
                      title={scriptError ? 'Fix the latest script error' : 'No script error detected'}
                      onClick={() => {
                        if (aiStatus?.type === 'error') setAiStatus(null)
                        setAiMode('fix')
                      }}
                    >
                      Fix Error
                    </button>
                  </div>
                  {aiMode === 'edit' ? (
                    <div className='script-ai-input'>
                      <textarea
                        ref={aiPromptRef}
                        value={aiPrompt}
                        disabled={!aiCanUse || aiPending}
                        placeholder='Describe the change you want the AI to make. Use @ to attach files.'
                        onChange={handlePromptChange}
                        onKeyDown={handlePromptKeyDown}
                        onKeyUp={handlePromptKeyUp}
                        onBlur={() => setAiMention(null)}
                      />
                      {aiMention?.open && (
                        <div className='script-ai-mentions' onMouseDown={e => e.preventDefault()}>
                          {aiMention.items.length ? (
                            aiMention.items.map((item, index) => {
                              const attached = aiAttachmentSet.has(item.id)
                              return (
                                <div
                                  key={item.id}
                                  className={cls('script-ai-mention-item', {
                                    active: index === aiMention.activeIndex,
                                    disabled: attached,
                                  })}
                                  onMouseDown={e => e.preventDefault()}
                                  onClick={() => {
                                    if (!attached) addAiAttachment(item)
                                  }}
                                >
                                  <span className='script-ai-mention-icon'>
                                    {item.type === 'doc' ? (
                                      <BookTextIcon size='0.85rem' />
                                    ) : (
                                      <CodeIcon size='0.85rem' />
                                    )}
                                  </span>
                                  <span className='script-ai-mention-path'>{item.path}</span>
                                  <span className='script-ai-mention-tag'>
                                    {attached ? 'attached' : item.type}
                                  </span>
                                </div>
                              )
                            })
                          ) : (
                            <div className='script-ai-mention-empty'>No matches</div>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className='script-ai-error'>
                      <div className='script-ai-error-title'>Latest script error</div>
                      <div className='script-ai-error-summary'>{errorInfo.title}</div>
                      {errorInfo.detail && (
                        <pre className='script-ai-error-text'>{errorInfo.detail}</pre>
                      )}
                    </div>
                  )}
                  {aiAttachments.length > 0 && (
                    <div className='script-ai-attachments'>
                      {aiAttachments.map(item => (
                        <div key={`${item.type}:${item.path}`} className='script-ai-attachment'>
                          <span className='script-ai-attachment-icon'>
                            {item.type === 'doc' ? (
                              <BookTextIcon size='0.75rem' />
                            ) : (
                              <CodeIcon size='0.75rem' />
                            )}
                          </span>
                          <span className='script-ai-attachment-path'>{item.path}</span>
                          <button
                            className='script-ai-attachment-remove'
                            type='button'
                            onClick={() => removeAiAttachment(item)}
                          >
                            x
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className='script-ai-footer'>
                    <div className='script-ai-hint'>
                      Entry: {entryPath || 'Unknown'} | {fileCount} file{fileCount === 1 ? '' : 's'} |{' '}
                      {scriptFormat}
                    </div>
                    <div className='script-ai-buttons'>
                      <button
                        className='script-ai-btn'
                        type='button'
                        disabled={!aiPrompt || aiPending}
                        onClick={() => {
                          setAiPrompt('')
                          if (aiStatus?.type === 'error') setAiStatus(null)
                          setAiMention(null)
                        }}
                      >
                        Clear
                      </button>
                      <button
                        className='script-ai-btn primary'
                        type='button'
                        disabled={!aiCanSend}
                        onClick={sendAiRequest}
                      >
                        {aiMode === 'fix' ? 'Fix Error' : 'Send Prompt'}
                      </button>
                    </div>
                  </div>
                  {aiAccessIssue && <div className='script-ai-status error'>{aiAccessIssue}</div>}
                  {aiPending && (
                    <div className='script-ai-status pending'>
                      <LoaderPinwheelIcon size='0.9rem' className='script-ai-spinner' />
                      {aiStatus?.message || 'Generating changes...'}
                    </div>
                  )}
                  {aiStatus?.type === 'error' && !aiAccessIssue && (
                    <div className='script-ai-status error'>{aiStatus.message}</div>
                  )}
                  {handle?.dirtyCount ? (
                    <div className='script-ai-status'>
                      You have unsaved edits. AI requests use the last saved code.
                    </div>
                  ) : null}
                </>
              )}
            </div>
          )}
        </div>
      )}
      <ScriptFilesEditor scriptRoot={moduleRoot} world={world} onHandle={setHandle} />
      <div className='script-resizer' ref={resizeRef} />
    </div>
  )
}
