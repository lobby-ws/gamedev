import { css } from '@firebolt-dev/css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cls } from '../cls'
import { theme } from '../theme'
import { ScriptFilesEditor } from '../ScriptFilesEditor'
import { ScriptAIController, hasScriptFiles, resolveScriptRootBlueprint } from './utils/ScriptAIController'
import { getBlueprintAppName } from '../../../core/blueprintUtils'
import { formatScriptError, fuzzyMatchList, getMentionState } from './utils/script'
import { ScriptChatPanel } from './ScriptChatPanel'
import { ScriptCodePanel } from './ScriptCodePanel'

// `hasScriptFiles`/`resolveScriptRootBlueprint` are shared with ScriptAIController.

export function Script({ world, hidden, viewMode = 'chat' }) {
  const aiController = useMemo(() => new ScriptAIController(world), [world])
  const app = world.ui.state.app
  const targetBlueprintId = app?.data?.blueprint || app?.blueprint?.id || null
  const containerRef = useRef()
  const [handle, setHandle] = useState(null)
  const [scriptRoot, setScriptRoot] = useState(() =>
    resolveScriptRootBlueprint(world.blueprints.get(app.data.blueprint) || app.blueprint, world)
  )
  const moduleRoot = hasScriptFiles(scriptRoot) ? scriptRoot : null
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiMode, setAiMode] = useState('edit')
  const [aiStatus, setAiStatus] = useState(null)
  const aiRequestRef = useRef(null)
  const aiPromptRef = useRef(null)
  const [aiAttachments, setAiAttachments] = useState([])
  const [aiDocsIndex, setAiDocsIndex] = useState(() => aiController.getDocsIndex?.() || [])
  const [aiThread, setAiThread] = useState(() =>
    aiController.getThreadForTarget?.({
      targetBlueprintId,
      scriptRootId: moduleRoot?.id,
    }) || []
  )
  const [aiMention, setAiMention] = useState(null)
  const scriptError = app?.scriptError || null
  const errorInfo = useMemo(() => formatScriptError(scriptError), [scriptError])
  const fileCount = moduleRoot?.scriptFiles ? Object.keys(moduleRoot.scriptFiles).length : 0
  const entryPath = moduleRoot?.scriptEntry || ''
  const scriptFormat = moduleRoot?.scriptFormat || 'module'
  const [aiPending, setAiPending] = useState(
    () =>
      !!aiController.getPendingForTarget?.({
        targetBlueprintId,
        scriptRootId: moduleRoot?.id,
      })
  )
  const aiLocked = aiPending
  const canBuild = !!world.builder?.canBuild?.()
  const aiAccessIssue = world.isAdminClient
    ? 'AI requests are not available on admin connections.'
    : !canBuild
      ? 'Builder access required.'
      : null
  const aiCanUse = !!moduleRoot && !aiAccessIssue && !!aiController.requestEdit
  const aiCanSendEdit = aiCanUse && !aiLocked && !!aiPrompt.trim()
  const aiCanSendFix = aiCanUse && !aiLocked && !!scriptError
  const aiCanSend = aiMode === 'fix' ? aiCanSendFix : aiCanSendEdit
  const aiMetaClass = cls('script-ai-meta', {
    ready: aiStatus?.type === 'success',
    pending: aiLocked,
    error: aiStatus?.type === 'error',
  })
  const aiMeta = useMemo(() => {
    if (aiLocked) return 'Generating changes...'
    if (aiStatus?.type === 'success') return aiStatus.message || 'Last request applied'
    if (aiStatus?.type === 'error') return 'Last request failed'
    if (aiMode === 'fix') {
      return scriptError ? 'Fix the latest script error' : 'No script error to fix'
    }
    return ''
  }, [aiLocked, aiStatus?.type, aiStatus?.message, aiMode, scriptError])
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
  const showChat = viewMode === 'chat'
  const showCode = viewMode === 'code'
  useEffect(() => {
    return () => {
      aiController.destroy?.()
    }
  }, [aiController])
  useEffect(() => {
    const onProposal = payload => {
      aiController.onProposal?.(payload)
    }
    const onEvent = payload => {
      aiController.onEvent?.(payload)
    }
    world.on?.('script-ai-proposal', onProposal)
    world.on?.('script-ai-event', onEvent)
    return () => {
      world.off?.('script-ai-proposal', onProposal)
      world.off?.('script-ai-event', onEvent)
    }
  }, [world, aiController])
  useEffect(() => {
    if (!aiController.subscribeThread) {
      setAiThread([])
      return () => {}
    }
    return aiController.subscribeThread({
      targetBlueprintId,
      scriptRootId: moduleRoot?.id,
      onChange: setAiThread,
    })
  }, [aiController, targetBlueprintId, moduleRoot?.id])
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
    setAiPending(
      !!aiController.getPendingForTarget?.({
        targetBlueprintId,
        scriptRootId: moduleRoot?.id,
      })
    )
  }, [moduleRoot?.id, targetBlueprintId, aiController])
  useEffect(() => {
    if (!aiController.subscribeDocsIndex) {
      setAiDocsIndex([])
      return () => {}
    }
    return aiController.subscribeDocsIndex(setAiDocsIndex)
  }, [aiController, world.network?.apiUrl])
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
    if (!aiController.subscribeTarget) return () => {}
    return aiController.subscribeTarget({
      targetBlueprintId,
      scriptRootId: moduleRoot?.id,
      onRequest: payload => {
        aiRequestRef.current = payload.requestId || null
        const mode = payload.mode === 'fix' ? 'fix' : 'edit'
        setAiMode(mode)
        if (typeof payload.prompt === 'string') {
          setAiPrompt(payload.prompt)
        }
        setAiPending(true)
        setAiStatus({
          type: 'pending',
          message: mode === 'fix' ? 'Fixing script error...' : 'Generating changes...',
        })
      },
      onPending: payload => {
        if (aiRequestRef.current && payload.requestId && payload.requestId !== aiRequestRef.current) return
        setAiPending(payload.pending === true)
      },
      onResponse: payload => {
        if (aiRequestRef.current && payload.requestId && payload.requestId !== aiRequestRef.current) return
        aiRequestRef.current = null
        setAiPending(false)
        if (payload.error) {
          setAiStatus({
            type: 'error',
            message: payload.message || 'AI request failed.',
          })
        } else {
          const appliedMessage =
            payload.message || (payload.forked ? 'AI changes applied to a new fork.' : 'AI changes applied.')
          setAiStatus({
            type: 'success',
            message: appliedMessage,
            summary: payload.summary || '',
            source: payload.source || '',
            fileCount: payload.fileCount || 0,
            forked: payload.forked === true,
            appliedScriptRootId: typeof payload.appliedScriptRootId === 'string' ? payload.appliedScriptRootId : null,
          })
        }
      },
    })
  }, [aiController, moduleRoot?.id, targetBlueprintId])
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
    setAiAttachments(current => current.filter(entry => entry.type !== item.type || entry.path !== item.path))
  }, [])
  const sendAiEdit = useCallback(() => {
    if (aiAccessIssue) {
      setAiStatus({ type: 'error', message: aiAccessIssue })
      return
    }
    if (!aiController?.requestEdit) {
      setAiStatus({ type: 'error', message: 'AI scripts are not available in this session.' })
      return
    }
    if (aiLocked) {
      setAiStatus({
        type: 'error',
        message: 'AI request already in progress for this script.',
      })
      return
    }
    const trimmed = aiPrompt.trim()
    if (!trimmed) {
      setAiStatus({ type: 'error', message: 'Enter a prompt to request edits.' })
      return
    }
    const requestId = aiController.requestEdit({
      prompt: trimmed,
      app,
      attachments: aiAttachmentPayload,
    })
    if (!requestId) return
    aiPromptRef.current?.blur?.()
    aiRequestRef.current = requestId
    setAiPending(true)
    setAiStatus({ type: 'pending', message: 'Generating changes...' })
  }, [aiAccessIssue, aiLocked, aiPrompt, aiController, app, aiAttachmentPayload])
  const sendAiFix = useCallback(() => {
    if (aiAccessIssue) {
      setAiStatus({ type: 'error', message: aiAccessIssue })
      return
    }
    if (!aiController?.requestFix) {
      setAiStatus({ type: 'error', message: 'AI scripts are not available in this session.' })
      return
    }
    if (aiLocked) {
      setAiStatus({
        type: 'error',
        message: 'AI request already in progress for this script.',
      })
      return
    }
    if (!scriptError) {
      setAiStatus({ type: 'error', message: 'No script error detected.' })
      return
    }
    const requestId = aiController.requestFix({ app, attachments: aiAttachmentPayload })
    if (!requestId) return
    aiPromptRef.current?.blur?.()
    aiRequestRef.current = requestId
    setAiPending(true)
    setAiStatus({ type: 'pending', message: 'Fixing script error...' })
  }, [aiAccessIssue, aiLocked, scriptError, aiController, app, aiAttachmentPayload])
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
        sendAiRequest()
        return
      }
      if (!aiMention?.open) {
        if ((e.key === 'Enter' || e.code === 'Enter') && !e.shiftKey) {
          e.preventDefault()
          sendAiRequest()
        }
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAiMention(current => {
          if (!current) return current
          const next = current.activeIndex + 1 >= current.items.length ? 0 : current.activeIndex + 1
          return { ...current, activeIndex: next }
        })
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAiMention(current => {
          if (!current) return current
          const next = current.activeIndex - 1 < 0 ? Math.max(current.items.length - 1, 0) : current.activeIndex - 1
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
    [aiMention, addAiAttachment, sendAiRequest]
  )
  const handlePromptKeyUp = useCallback(
    e => {
      updateAiMention(e.currentTarget.value, e.currentTarget.selectionStart)
    },
    [updateAiMention]
  )
  useEffect(() => {
    if (!hidden || typeof document === 'undefined') return
    const active = document.activeElement
    if (active && containerRef.current?.contains(active) && typeof active.blur === 'function') {
      active.blur()
    }
  }, [hidden])
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
        .script-editor-shell {
          flex: 1;
          min-height: 0;
          display: flex;
        }
        .script-editor-shell.collapsed {
          flex: 0 0 auto;
          height: 0;
          overflow: hidden;
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
          flex: 1;
          min-height: 0;
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
          min-height: 0;
          flex: 1;
        }
        .script-ai-thread {
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
          max-height: none;
          flex: 1;
          min-height: 9rem;
          overflow: auto;
          padding: 0.2rem 0.15rem 0.2rem 0;
          scrollbar-width: thin;
          scrollbar-color: rgba(255, 255, 255, 0.26) transparent;
        }
        .script-ai-thread::-webkit-scrollbar {
          width: 10px;
        }
        .script-ai-thread::-webkit-scrollbar-track {
          background: transparent;
        }
        .script-ai-thread::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.2);
          border-radius: 999px;
          border: 2px solid transparent;
          background-clip: padding-box;
        }
        .script-ai-msg {
          border-radius: ${theme.radiusSmall};
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: rgba(255, 255, 255, 0.03);
          padding: 0.52rem 0.62rem;
          font-size: 0.74rem;
          line-height: 1.4;
          color: rgba(255, 255, 255, 0.85);
          white-space: pre-wrap;
          max-width: 90%;
          align-self: flex-start;
        }
        .script-ai-msg.user {
          align-self: flex-end;
          border-color: rgba(0, 167, 255, 0.45);
          color: #d7f2ff;
          background: rgba(0, 167, 255, 0.18);
        }
        .script-ai-msg.phase {
          color: rgba(255, 255, 255, 0.65);
          font-style: italic;
          border-style: dashed;
        }
        .script-ai-msg.error {
          border-color: rgba(255, 107, 107, 0.6);
          color: #ffb4b4;
          background: rgba(255, 107, 107, 0.09);
        }
        .script-ai-msg.success {
          border-color: rgba(0, 167, 255, 0.45);
          color: #91d8ff;
        }
        .script-ai-empty {
          border-radius: ${theme.radiusSmall};
          border: 1px dashed rgba(255, 255, 255, 0.16);
          padding: 0.7rem;
          font-size: 0.72rem;
          color: rgba(255, 255, 255, 0.48);
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
          border: 1px solid rgba(255, 255, 255, 0.14);
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
          scrollbar-width: thin;
          scrollbar-color: rgba(255, 255, 255, 0.26) transparent;
        }
        .script-ai-mentions::-webkit-scrollbar {
          width: 10px;
        }
        .script-ai-mentions::-webkit-scrollbar-track {
          background: transparent;
        }
        .script-ai-mentions::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.2);
          border-radius: 999px;
          border: 2px solid transparent;
          background-clip: padding-box;
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
          margin-top: auto;
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          padding-top: 0.55rem;
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
        &.hidden {
          opacity: 0;
          pointer-events: none;
        }
      `}
    >
      {showChat && (
        <ScriptChatPanel
          moduleRoot={moduleRoot}
          aiMetaClass={aiMetaClass}
          aiMeta={aiMeta}
          aiMode={aiMode}
          aiStatus={aiStatus}
          setAiStatus={setAiStatus}
          scriptError={scriptError}
          errorInfo={errorInfo}
          aiPromptRef={aiPromptRef}
          aiPrompt={aiPrompt}
          aiCanUse={aiCanUse}
          aiLocked={aiLocked}
          handlePromptChange={handlePromptChange}
          handlePromptKeyDown={handlePromptKeyDown}
          handlePromptKeyUp={handlePromptKeyUp}
          setAiMention={setAiMention}
          aiMention={aiMention}
          aiAttachmentSet={aiAttachmentSet}
          addAiAttachment={addAiAttachment}
          aiAttachments={aiAttachments}
          removeAiAttachment={removeAiAttachment}
          entryPath={entryPath}
          fileCount={fileCount}
          scriptFormat={scriptFormat}
          aiCanSend={aiCanSend}
          sendAiRequest={sendAiRequest}
          aiAccessIssue={aiAccessIssue}
          handle={handle}
          aiThread={aiThread}
        />
      )}
      <ScriptCodePanel
        moduleRoot={moduleRoot}
        handle={handle}
        aiLocked={aiLocked}
        showChrome={showCode}
        forceCollapsed={!showCode}
      >
        <ScriptFilesEditor scriptRoot={moduleRoot} world={world} onHandle={setHandle} aiLocked={aiLocked} />
      </ScriptCodePanel>
    </div>
  )
}
