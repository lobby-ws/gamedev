import { css } from '@firebolt-dev/css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cls } from './cls'
import { loadMonaco } from './monaco'
import { hashFile } from '../../core/utils-client'
import { isValidScriptPath } from '../../core/blueprintValidation'

const languageByExt = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
}

const SHARED_PREFIX = '@shared/'
const SHARED_ALIAS = 'shared/'

const aiDebugEnabled =
  (process?.env?.PUBLIC_DEBUG_AI_SCRIPT || globalThis?.env?.PUBLIC_DEBUG_AI_SCRIPT) === 'true'

function isSharedPath(path) {
  if (typeof path !== 'string') return false
  return path.startsWith(SHARED_PREFIX) || path.startsWith(SHARED_ALIAS)
}

function toSharedPath(path) {
  if (typeof path !== 'string') return null
  if (path.startsWith(SHARED_PREFIX)) return path
  if (path.startsWith(SHARED_ALIAS)) {
    return `${SHARED_PREFIX}${path.slice(SHARED_ALIAS.length)}`
  }
  return `${SHARED_PREFIX}${path}`
}

function normalizeAiPatchSet(input) {
  if (!input) return null
  const patchSet = input
  const files = Array.isArray(patchSet)
    ? patchSet
    : patchSet.files || patchSet.changes || patchSet.patches
  if (!Array.isArray(files) || files.length === 0) return null
  const normalizedFiles = []
  for (const entry of files) {
    if (!entry) continue
    const path = entry.path || entry.relPath || entry.file
    const content = entry.content ?? entry.text ?? entry.nextText ?? entry.code
    if (!path || typeof content !== 'string') continue
    normalizedFiles.push({ path, content })
  }
  if (!normalizedFiles.length) return null
  const autoApply =
    patchSet.autoApply === true || patchSet.autoCommit === true || patchSet.autoAccept === true
  return {
    id: typeof patchSet.id === 'string' ? patchSet.id : null,
    summary:
      typeof patchSet.summary === 'string'
        ? patchSet.summary
        : typeof patchSet.prompt === 'string'
          ? patchSet.prompt
          : '',
    source: typeof patchSet.source === 'string' ? patchSet.source : '',
    scriptRootId:
      typeof patchSet.scriptRootId === 'string'
        ? patchSet.scriptRootId
        : typeof patchSet.blueprintId === 'string'
          ? patchSet.blueprintId
          : null,
    autoPreview: patchSet.autoPreview !== false && !autoApply,
    autoApply,
    files: normalizedFiles,
  }
}

function getFileExtension(path) {
  if (typeof path !== 'string') return ''
  const idx = path.lastIndexOf('.')
  if (idx === -1 || idx === path.length - 1) return ''
  return path.slice(idx + 1).toLowerCase()
}

function getLanguageForPath(path) {
  const ext = getFileExtension(path)
  return languageByExt[ext] || 'javascript'
}

function deriveLockScopeFromBlueprintId(id) {
  if (typeof id !== 'string' || !id.trim()) return 'global'
  if (id === '$scene') return '$scene'
  const idx = id.indexOf('__')
  if (idx !== -1) {
    const appName = id.slice(0, idx)
    return appName ? appName : 'global'
  }
  return id
}

function buildFileTree(paths) {
  const root = { name: '', path: null, fullPath: '', children: new Map() }
  for (const path of paths) {
    const parts = path.split('/')
    let node = root
    let currentPath = ''
    for (let idx = 0; idx < parts.length; idx += 1) {
      const part = parts[idx]
      currentPath = currentPath ? `${currentPath}/${part}` : part
      let child = node.children.get(part)
      if (!child) {
        child = { name: part, path: null, fullPath: currentPath, children: new Map() }
        node.children.set(part, child)
      }
      if (idx === parts.length - 1) {
        child.path = path
      }
      node = child
    }
  }
  return root
}

export function ScriptFilesEditor({ world, scriptRoot, onHandle }) {
  const mountRef = useRef(null)
  const editorRef = useRef(null)
  const monacoRef = useRef(null)
  const currentPathRef = useRef(null)
  const fileStatesRef = useRef(new Map())
  const loadCounterRef = useRef(0)
  const rootIdRef = useRef(null)
  const diffMountRef = useRef(null)
  const diffEditorRef = useRef(null)
  const diffOriginalsRef = useRef(new Map())
  const placeholderModelRef = useRef(null)
  const saveAllRef = useRef(null)
  const newFileInputRef = useRef(null)

  const [selectedPath, setSelectedPath] = useState(null)
  const [fontSize, setFontSize] = useState(() => 12 * world.prefs.ui)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [conflict, setConflict] = useState(null)
  const [dirtyTick, setDirtyTick] = useState(0)
  const [editorReady, setEditorReady] = useState(false)
  const [aiProposal, setAiProposal] = useState(null)
  const [aiPreviewOpen, setAiPreviewOpen] = useState(false)
  const [aiPreviewPath, setAiPreviewPath] = useState(null)
  const [extraPaths, setExtraPaths] = useState([])
  const [newFileOpen, setNewFileOpen] = useState(false)
  const [newFilePath, setNewFilePath] = useState('')
  const [newFileError, setNewFileError] = useState(null)

  const scriptFiles = scriptRoot?.scriptFiles
  const entryPath = scriptRoot?.scriptEntry || ''
  const rootId = scriptRoot?.id || ''
  const rootVersion = Number.isFinite(scriptRoot?.version) ? scriptRoot.version : 0
  const canMoveToShared =
    !!selectedPath &&
    selectedPath !== entryPath &&
    isValidScriptPath(selectedPath) &&
    !isSharedPath(selectedPath)

  const { validPaths, invalidPaths } = useMemo(() => {
    const basePaths =
      scriptFiles && typeof scriptFiles === 'object' && !Array.isArray(scriptFiles)
        ? Object.keys(scriptFiles)
        : []
    const combined = new Set(basePaths)
    for (const path of extraPaths) {
      combined.add(path)
    }
    const valid = []
    const invalid = []
    for (const path of combined) {
      if (isValidScriptPath(path)) {
        valid.push(path)
      } else {
        invalid.push(path)
      }
    }
    valid.sort((a, b) => a.localeCompare(b))
    return { validPaths: valid, invalidPaths: invalid }
  }, [scriptFiles, extraPaths])

  const tree = useMemo(() => buildFileTree(validPaths), [validPaths])

  const dirtyCount = useMemo(() => {
    let count = 0
    for (const state of fileStatesRef.current.values()) {
      if (state.dirty) count += 1
    }
    return count
  }, [dirtyTick])

  const isDirtySelected = useMemo(() => {
    if (!selectedPath) return false
    const state = fileStatesRef.current.get(selectedPath)
    return !!state?.dirty
  }, [selectedPath, dirtyTick])

  const clearAiProposal = useCallback(() => {
    setAiProposal(null)
    setAiPreviewOpen(false)
    setAiPreviewPath(null)
    if (diffEditorRef.current) {
      diffEditorRef.current.setModel(null)
    }
    for (const model of diffOriginalsRef.current.values()) {
      model.dispose()
    }
    diffOriginalsRef.current.clear()
  }, [])

  useEffect(() => {
    if (!rootId) return
    if (rootIdRef.current === rootId) return
    rootIdRef.current = rootId
    for (const state of fileStatesRef.current.values()) {
      state.model?.dispose()
      state.disposable?.dispose()
    }
    fileStatesRef.current.clear()
    clearAiProposal()
    setExtraPaths([])
    setSelectedPath(validPaths[0] || null)
    setNewFileOpen(false)
    setNewFilePath('')
    setNewFileError(null)
  }, [rootId, validPaths, clearAiProposal])

  useEffect(() => {
    if (!aiProposal) return
    clearAiProposal()
  }, [rootVersion, aiProposal, clearAiProposal])

  useEffect(() => {
    if (!extraPaths.length || !scriptFiles) return
    const basePaths = new Set(Object.keys(scriptFiles))
    const filtered = extraPaths.filter(path => !basePaths.has(path))
    if (filtered.length !== extraPaths.length) {
      setExtraPaths(filtered)
    }
  }, [extraPaths, scriptFiles])

  useEffect(() => {
    if (!validPaths.length) {
      setSelectedPath(null)
      return
    }
    setSelectedPath(current => {
      if (current && validPaths.includes(current)) return current
      return validPaths[0]
    })
    const validSet = new Set(validPaths)
    for (const [path, state] of fileStatesRef.current.entries()) {
      if (!validSet.has(path)) {
        state.model?.dispose()
        state.disposable?.dispose()
        fileStatesRef.current.delete(path)
      }
    }
  }, [validPaths])

  useEffect(() => {
    const onPrefsChange = changes => {
      if (changes.ui) {
        setFontSize(14 * changes.ui.value)
      }
    }
    world.prefs.on('change', onPrefsChange)
    return () => {
      world.prefs.off('change', onPrefsChange)
    }
  }, [world])

  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.updateOptions({ fontSize })
    }
  }, [fontSize])

  useEffect(() => {
    if (diffEditorRef.current) {
      diffEditorRef.current.updateOptions({ fontSize })
    }
  }, [fontSize])

  const emitAiTelemetry = useCallback(
    (action, details = {}) => {
      if (!aiDebugEnabled) return
      const payload = {
        action,
        rootId,
        rootVersion,
        timestamp: Date.now(),
        ...details,
      }
      console.log('[ai-script]', payload)
      world.emit?.('script-ai-sync', payload)
    },
    [world, rootId, rootVersion]
  )

  const ensureFileState = useCallback(
    async (path, { allowMissing } = {}) => {
      if (!path || !scriptRoot || !scriptFiles) return null
      if (!isValidScriptPath(path)) {
        throw new Error('invalid_path')
      }
      const existing = fileStatesRef.current.get(path)
      if (existing) return existing
      const monaco = monacoRef.current
      if (!monaco) {
        throw new Error('monaco_unavailable')
      }
      const assetUrl = scriptFiles[path]
      if (!assetUrl) {
        if (!allowMissing) {
          throw new Error('missing_script_file')
        }
        const uri = monaco.Uri.parse(`inmemory://module/${rootId}/${path}`)
        let model = monaco.editor.getModel(uri)
        if (!model) {
          model = monaco.editor.createModel('', getLanguageForPath(path), uri)
        } else if (model.getValue() !== '') {
          model.setValue('')
        }
        const state = {
          model,
          originalText: '',
          dirty: false,
          version: rootVersion,
          assetUrl: null,
          viewState: null,
          disposable: null,
          isNew: true,
        }
        state.disposable = model.onDidChangeContent(() => {
          const nextDirty = model.getValue() !== state.originalText
          if (nextDirty !== state.dirty) {
            state.dirty = nextDirty
            setDirtyTick(tick => tick + 1)
          }
        })
        fileStatesRef.current.set(path, state)
        setExtraPaths(current => (current.includes(path) ? current : [...current, path]))
        return state
      }
      const file = await world.loader.loadFile(assetUrl)
      const text = await file.text()
      const uri = monaco.Uri.parse(`inmemory://module/${rootId}/${path}`)
      let model = monaco.editor.getModel(uri)
      if (!model) {
        model = monaco.editor.createModel(text, getLanguageForPath(path), uri)
      } else if (model.getValue() !== text) {
        model.setValue(text)
      }
      const state = {
        model,
        originalText: text,
        dirty: false,
        version: rootVersion,
        assetUrl,
        viewState: null,
        disposable: null,
        isNew: false,
      }
      state.disposable = model.onDidChangeContent(() => {
        const nextDirty = model.getValue() !== state.originalText
        if (nextDirty !== state.dirty) {
          state.dirty = nextDirty
          setDirtyTick(tick => tick + 1)
        }
      })
      fileStatesRef.current.set(path, state)
      return state
    },
    [scriptRoot, scriptFiles, rootId, rootVersion, world]
  )

  const openNewFile = useCallback(() => {
    if (!scriptRoot || !scriptFiles) return
    setNewFileOpen(true)
    setNewFilePath('')
    setNewFileError(null)
    requestAnimationFrame(() => {
      newFileInputRef.current?.focus()
    })
  }, [scriptRoot, scriptFiles])

  const openNewSharedFile = useCallback(() => {
    if (!scriptRoot || !scriptFiles) return
    setNewFileOpen(true)
    setNewFilePath(SHARED_PREFIX)
    setNewFileError(null)
    requestAnimationFrame(() => {
      const input = newFileInputRef.current
      if (!input) return
      input.focus()
      if (typeof input.setSelectionRange === 'function') {
        const end = input.value.length
        input.setSelectionRange(end, end)
      }
    })
  }, [scriptRoot, scriptFiles])

  const cancelNewFile = useCallback(() => {
    setNewFileOpen(false)
    setNewFilePath('')
    setNewFileError(null)
  }, [])

  const createNewFile = useCallback(async () => {
    if (!scriptRoot || !scriptFiles) return
    const trimmed = newFilePath.trim()
    if (!trimmed) {
      setNewFileError('Enter a file path.')
      return
    }
    if (!isValidScriptPath(trimmed)) {
      setNewFileError('Invalid path. Use helpers/util.js or @shared/helpers/util.js.')
      return
    }
    if (
      Object.prototype.hasOwnProperty.call(scriptFiles, trimmed) ||
      extraPaths.includes(trimmed) ||
      fileStatesRef.current.has(trimmed)
    ) {
      setNewFileError('That file already exists.')
      return
    }
    try {
      const state = await ensureFileState(trimmed, { allowMissing: true })
      if (!state) throw new Error('new_file_failed')
      setSelectedPath(trimmed)
      setNewFileOpen(false)
      setNewFilePath('')
      setNewFileError(null)
    } catch (err) {
      console.error(err)
      setNewFileError('Failed to create file.')
    }
  }, [scriptRoot, scriptFiles, newFilePath, extraPaths, ensureFileState])

  const moveSelectedToShared = useCallback(async () => {
    if (!scriptRoot || !scriptFiles) return
    if (saving) return
    const path = selectedPath
    if (!path) return
    if (!isValidScriptPath(path)) {
      setError('Invalid script path.')
      return
    }
    if (path === entryPath) {
      setError('Entry script cannot be shared.')
      return
    }
    if (isSharedPath(path)) {
      setError('Script is already shared.')
      return
    }
    const sharedPath = toSharedPath(path)
    if (!sharedPath || !isValidScriptPath(sharedPath)) {
      setError('Invalid shared path.')
      return
    }
    if (
      Object.prototype.hasOwnProperty.call(scriptFiles, sharedPath) ||
      extraPaths.includes(sharedPath) ||
      fileStatesRef.current.has(sharedPath)
    ) {
      setError('Shared file already exists.')
      return
    }
    setLoading(true)
    setError(null)
    let lockToken
    try {
      const state = await ensureFileState(path)
      if (!state?.model) throw new Error('missing_state')
      const text = state.model.getValue()
      const nextState = await ensureFileState(sharedPath, { allowMissing: true })
      if (!nextState?.model) throw new Error('missing_shared_state')
      nextState.model.setValue(text)
      nextState.originalText = state.originalText
      nextState.dirty = text !== state.originalText
      nextState.viewState = state.viewState || null
      nextState.version = state.version
      nextState.assetUrl = state.assetUrl
      nextState.isNew = state.isNew
      state.disposable?.dispose()
      state.model?.dispose()
      fileStatesRef.current.delete(path)
      setExtraPaths(current => {
        let next = current.filter(item => item !== path)
        if (nextState.isNew) {
          if (!next.includes(sharedPath)) next = [...next, sharedPath]
        } else if (next.includes(sharedPath)) {
          next = next.filter(item => item !== sharedPath)
        }
        return next
      })
      setSelectedPath(sharedPath)
      setDirtyTick(tick => tick + 1)

      if (Object.prototype.hasOwnProperty.call(scriptFiles, path)) {
        if (!entryPath || !Object.prototype.hasOwnProperty.call(scriptFiles, entryPath)) {
          setError('Script entry missing.')
          return
        }
        if (!world.admin?.acquireDeployLock || !world.admin?.blueprintModify) {
          setError('Admin connection required.')
          return
        }
        const scope = deriveLockScopeFromBlueprintId(scriptRoot.id)
        const result = await world.admin.acquireDeployLock({
          owner: world.network.id,
          scope,
        })
        lockToken = result?.token || world.admin.deployLockToken
        const nextScriptFiles = { ...scriptFiles }
        const assetUrl = nextScriptFiles[path]
        if (!assetUrl) {
          setError('Missing script file.')
          return
        }
        delete nextScriptFiles[path]
        nextScriptFiles[sharedPath] = assetUrl
        nextState.assetUrl = assetUrl
        nextState.isNew = false
        const nextVersion = rootVersion + 1
        const change = {
          id: scriptRoot.id,
          version: nextVersion,
          script: nextScriptFiles[entryPath],
          scriptEntry: entryPath,
          scriptFiles: nextScriptFiles,
          scriptFormat: scriptRoot.scriptFormat || 'module',
        }
        world.blueprints.modify(change)
        await world.admin.blueprintModify(change, {
          ignoreNetworkId: world.network.id,
          lockToken,
        })
        nextState.version = nextVersion
      }
      world.emit('toast', 'Moved to shared')
    } catch (err) {
      console.error(err)
      setError('Failed to move to shared.')
    } finally {
      setLoading(false)
      if (lockToken && world.admin?.releaseDeployLock) {
        try {
          await world.admin.releaseDeployLock(lockToken)
        } catch (releaseErr) {
          console.error('failed to release deploy lock', releaseErr)
        }
      }
    }
  }, [
    scriptRoot,
    scriptFiles,
    entryPath,
    rootVersion,
    world,
    saving,
    selectedPath,
    extraPaths,
    ensureFileState,
  ])

  const setEditorModel = useCallback(path => {
    const editor = editorRef.current
    if (!editor) return
    const state = fileStatesRef.current.get(path)
    if (!state?.model) return
    const previous = currentPathRef.current
    if (previous && previous !== path) {
      const prevState = fileStatesRef.current.get(previous)
      if (prevState && editor) {
        prevState.viewState = editor.saveViewState()
      }
    }
    currentPathRef.current = path
    editor.setModel(state.model)
    if (state.viewState) {
      editor.restoreViewState(state.viewState)
    }
    editor.focus()
  }, [])

  const loadPath = useCallback(
    async (path, { force } = {}) => {
      if (!path || !scriptRoot || !scriptFiles) return
      if (!isValidScriptPath(path)) {
        setError('Invalid script path.')
        return
      }
      const existing = fileStatesRef.current.get(path)
      if (existing?.isNew) {
        setEditorModel(path)
        return
      }
      if (existing && !force) {
        setEditorModel(path)
        return
      }
      const assetUrl = scriptFiles[path]
      if (!assetUrl) {
        setError('Missing script file.')
        return
      }
      setLoading(true)
      const loadId = loadCounterRef.current + 1
      loadCounterRef.current = loadId
      try {
        const file = await world.loader.loadFile(assetUrl)
        const text = await file.text()
        if (loadCounterRef.current !== loadId) return
        const monaco = monacoRef.current
        if (!monaco) return
        let state = existing
        if (!state) {
          const uri = monaco.Uri.parse(`inmemory://module/${rootId}/${path}`)
          let model = monaco.editor.getModel(uri)
          if (!model) {
            model = monaco.editor.createModel(text, getLanguageForPath(path), uri)
          } else if (model.getValue() !== text) {
            model.setValue(text)
          }
          state = {
            model,
            originalText: text,
            dirty: false,
            version: rootVersion,
            assetUrl,
            viewState: null,
            disposable: null,
            isNew: false,
          }
          state.disposable = model.onDidChangeContent(() => {
            const nextDirty = model.getValue() !== state.originalText
            if (nextDirty !== state.dirty) {
              state.dirty = nextDirty
              setDirtyTick(tick => tick + 1)
            }
          })
          fileStatesRef.current.set(path, state)
        } else {
          state.originalText = text
          state.dirty = false
          state.version = rootVersion
          state.assetUrl = assetUrl
          state.isNew = false
          if (state.model.getValue() !== text) {
            state.model.setValue(text)
          }
          setDirtyTick(tick => tick + 1)
        }
        setEditorModel(path)
        setError(null)
        setConflict(null)
      } catch (err) {
        console.error(err)
        setError('Failed to load script.')
      } finally {
        if (loadCounterRef.current === loadId) {
          setLoading(false)
        }
      }
    },
    [scriptRoot, scriptFiles, rootId, rootVersion, setEditorModel, world]
  )

  const openAiPreview = useCallback(() => {
    if (!aiProposal?.files?.length) return
    const nextPath = aiPreviewPath || aiProposal.files[0].path
    if (nextPath) {
      setAiPreviewPath(nextPath)
    }
    setAiPreviewOpen(true)
    emitAiTelemetry('preview_open', { path: nextPath })
  }, [aiProposal, aiPreviewPath, emitAiTelemetry])

  const closeAiPreview = useCallback(() => {
    setAiPreviewOpen(false)
    emitAiTelemetry('preview_close')
  }, [emitAiTelemetry])

  const toggleAiPreview = useCallback(() => {
    if (aiPreviewOpen) {
      closeAiPreview()
    } else {
      openAiPreview()
    }
  }, [aiPreviewOpen, closeAiPreview, openAiPreview])

  const applyAiPatchSet = useCallback(
    async patchSetInput => {
      if (!scriptRoot || !scriptFiles) return
      const patchSet = normalizeAiPatchSet(patchSetInput)
      if (!patchSet) {
        setError('Invalid AI proposal.')
        return
      }
      const shouldAutoApply = patchSet.autoApply === true
      if (patchSet.scriptRootId && patchSet.scriptRootId !== rootId) {
        return
      }
      const requestedPaths = new Map()
      for (const file of patchSet.files) {
        requestedPaths.set(file.path, file.content)
      }
      const paths = Array.from(requestedPaths.keys())
      for (const path of paths) {
        if (!isValidScriptPath(path)) {
          setError(`Invalid script path: ${path}`)
          return
        }
        const isKnownPath = Object.prototype.hasOwnProperty.call(scriptFiles, path)
        const state = fileStatesRef.current.get(path)
        if (!isKnownPath && state && !state.isNew) {
          setError(`Missing script file: ${path}`)
          return
        }
        if (state?.dirty) {
          setError(`Save or discard changes in ${path} before applying AI proposal.`)
          return
        }
        if (state && state.version !== rootVersion) {
          setError(null)
          setConflict('Script changed on the server. Refresh or retry.')
          return
        }
      }
      setLoading(true)
      try {
        clearAiProposal()
        const proposalFiles = []
        const removedPaths = []
        for (const [path, content] of requestedPaths.entries()) {
          const hadState = fileStatesRef.current.has(path)
          const allowMissing = !Object.prototype.hasOwnProperty.call(scriptFiles, path)
          const state = await ensureFileState(path, { allowMissing })
          if (!state?.model) {
            throw new Error('ai_state_missing')
          }
          const originalText = state.model.getValue()
          const changed = content !== originalText
          if (changed) {
            state.model.setValue(content)
            const nextDirty = content !== state.originalText
            if (nextDirty !== state.dirty) {
              state.dirty = nextDirty
              setDirtyTick(tick => tick + 1)
            }
            proposalFiles.push({
              path,
              originalText,
              proposedText: content,
              isNew: !!state.isNew,
            })
          } else if (!hadState && state.isNew) {
            state.disposable?.dispose()
            state.model.dispose()
            fileStatesRef.current.delete(path)
            removedPaths.push(path)
          }
        }
        if (removedPaths.length) {
          const removed = new Set(removedPaths)
          setExtraPaths(current => current.filter(path => !removed.has(path)))
          if (selectedPath && removed.has(selectedPath)) {
            const remaining = validPaths.filter(path => !removed.has(path))
            setSelectedPath(remaining[0] || null)
          }
          setDirtyTick(tick => tick + 1)
        }
        if (!proposalFiles.length) {
          setError(null)
          setConflict(null)
          world.emit('toast', 'AI returned no changes')
          emitAiTelemetry('proposal_empty', { source: patchSet.source })
          return
        }
        proposalFiles.sort((a, b) => a.path.localeCompare(b.path))
        const firstPath = proposalFiles[0]?.path || null
        if (shouldAutoApply && saveAllRef.current) {
          const aiPaths = new Set(proposalFiles.map(file => file.path))
          emitAiTelemetry('commit_start', {
            fileCount: aiPaths.size,
            paths: Array.from(aiPaths),
            autoApply: true,
          })
          const ok = await saveAllRef.current({ paths: aiPaths })
          if (ok) {
            world.emit('toast', 'AI changes applied')
            emitAiTelemetry('commit_success', { fileCount: aiPaths.size, autoApply: true })
            return
          }
          emitAiTelemetry('commit_failed', { autoApply: true })
        }
        setAiProposal({
          id: patchSet.id,
          summary: patchSet.summary,
          source: patchSet.source,
          files: proposalFiles,
        })
        if (firstPath) {
          setSelectedPath(firstPath)
          setAiPreviewPath(firstPath)
        }
        setError(null)
        setConflict(null)
        if (patchSet.autoPreview) {
          setAiPreviewOpen(true)
          emitAiTelemetry('preview_open', { path: firstPath })
        }
        emitAiTelemetry('proposal_applied', {
          fileCount: proposalFiles.length,
          paths: proposalFiles.map(file => file.path),
          source: patchSet.source,
        })
      } catch (err) {
        console.error(err)
        setError('Failed to apply AI proposal.')
        emitAiTelemetry('proposal_error', { message: err?.message })
      } finally {
        setLoading(false)
      }
    },
    [
      scriptRoot,
      scriptFiles,
      rootId,
      clearAiProposal,
      ensureFileState,
      emitAiTelemetry,
      selectedPath,
      validPaths,
      world,
    ]
  )

  useEffect(() => {
    let dead = false
    loadMonaco().then(monaco => {
      if (dead) return
      monacoRef.current = monaco
      const placeholderText = validPaths.length ? '// Loading...' : '// No module files'
      const placeholderUri = monaco.Uri.parse(`inmemory://module/${rootId || 'default'}/placeholder`)
      let placeholder = monaco.editor.getModel(placeholderUri)
      if (!placeholder) {
        try {
          placeholder = monaco.editor.createModel(placeholderText, 'javascript', placeholderUri)
        } catch (err) {
          placeholder = monaco.editor.getModel(placeholderUri)
          if (!placeholder) throw err
        }
      } else if (placeholder.getValue() !== placeholderText) {
        placeholder.setValue(placeholderText)
      }
      placeholderModelRef.current = placeholder
      const editor = monaco.editor.create(mountRef.current, {
        model: placeholder,
        language: 'javascript',
        scrollBeyondLastLine: true,
        lineNumbers: 'on',
        minimap: { enabled: false },
        automaticLayout: true,
        tabSize: 2,
        insertSpaces: true,
        fontSize: fontSize,
      })
      editorRef.current = editor
      setEditorReady(true)
      if (selectedPath) {
        loadPath(selectedPath)
      } else if (validPaths.length) {
        setSelectedPath(validPaths[0])
      }
    })
    return () => {
      dead = true
      editorRef.current?.dispose()
      editorRef.current = null
      diffEditorRef.current?.dispose()
      diffEditorRef.current = null
      placeholderModelRef.current?.dispose()
      placeholderModelRef.current = null
      for (const state of fileStatesRef.current.values()) {
        state.model?.dispose()
        state.disposable?.dispose()
      }
      fileStatesRef.current.clear()
      for (const model of diffOriginalsRef.current.values()) {
        model.dispose()
      }
      diffOriginalsRef.current.clear()
    }
  }, [])

  useEffect(() => {
    if (!selectedPath || !editorReady) return
    loadPath(selectedPath)
  }, [selectedPath, editorReady, loadPath])

  useEffect(() => {
    if (!aiPreviewOpen) return
    const monaco = monacoRef.current
    if (!monaco || !diffMountRef.current) return
    if (!diffEditorRef.current) {
      diffEditorRef.current = monaco.editor.createDiffEditor(diffMountRef.current, {
        readOnly: true,
        renderSideBySide: true,
        automaticLayout: true,
        scrollBeyondLastLine: false,
        minimap: { enabled: false },
        fontSize,
      })
    }
    diffEditorRef.current.layout()
  }, [aiPreviewOpen, fontSize])

  useEffect(() => {
    if (!aiPreviewOpen || !aiProposal || !aiPreviewPath) return
    const monaco = monacoRef.current
    const diffEditor = diffEditorRef.current
    if (!monaco || !diffEditor) return
    const entry = aiProposal.files.find(file => file.path === aiPreviewPath)
    const state = fileStatesRef.current.get(aiPreviewPath)
    if (!entry || !state?.model) return
    let originalModel = diffOriginalsRef.current.get(aiPreviewPath)
    if (!originalModel) {
      const uri = monaco.Uri.parse(`inmemory://module-ai/${rootId}/${aiPreviewPath}`)
      originalModel = monaco.editor.getModel(uri)
      if (!originalModel) {
        try {
          originalModel = monaco.editor.createModel(
            entry.originalText,
            getLanguageForPath(aiPreviewPath),
            uri
          )
        } catch (err) {
          originalModel = monaco.editor.getModel(uri)
          if (!originalModel) throw err
        }
      } else if (originalModel.getValue() !== entry.originalText) {
        originalModel.setValue(entry.originalText)
      }
      diffOriginalsRef.current.set(aiPreviewPath, originalModel)
    } else if (originalModel.getValue() !== entry.originalText) {
      originalModel.setValue(entry.originalText)
    }
    diffEditor.setModel({ original: originalModel, modified: state.model })
  }, [aiPreviewOpen, aiPreviewPath, aiProposal, rootId])

  useEffect(() => {
    const handleAiProposal = payload => {
      if (!payload) return
      applyAiPatchSet(payload)
    }
    world.on?.('script-ai-proposal', handleAiProposal)
    return () => {
      world.off?.('script-ai-proposal', handleAiProposal)
    }
  }, [world, applyAiPatchSet])

  const copy = useCallback(async () => {
    const editor = editorRef.current
    const text = editor?.getValue() || ''
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      world.emit('toast', 'Code copied')
    } catch (err) {
      console.error(err)
      world.emit('toast', 'Copy failed')
    }
  }, [world])

  const refreshCurrent = useCallback(async () => {
    if (!selectedPath) return
    const state = fileStatesRef.current.get(selectedPath)
    if (state?.dirty) {
      const ok = await world.ui.confirm({
        title: 'Discard changes?',
        message: 'Refreshing will discard your local edits.',
        confirmText: 'Discard',
        cancelText: 'Cancel',
      })
      if (!ok) return
    }
    await loadPath(selectedPath, { force: true })
    world.emit('toast', 'Script refreshed')
  }, [selectedPath, loadPath, world])

  const saveCurrent = useCallback(async () => {
    if (!scriptRoot || !scriptFiles) return
    const path = currentPathRef.current
    if (!path) return
    const state = fileStatesRef.current.get(path)
    if (!state || !state.dirty) return
    if (!isValidScriptPath(path)) {
      setError('Invalid script path.')
      return
    }
    if (!entryPath || !isValidScriptPath(entryPath)) {
      setError('Invalid script entry.')
      return
    }
    if (!Object.prototype.hasOwnProperty.call(scriptFiles, path) && !state?.isNew) {
      setError('Missing script file.')
      return
    }
    if (!Object.prototype.hasOwnProperty.call(scriptFiles, entryPath)) {
      setError('Script entry missing.')
      return
    }
    if (state.version !== rootVersion) {
      setError(null)
      setConflict('Script changed on the server. Refresh or retry.')
      return
    }
    setSaving(true)
    setError(null)
    setConflict(null)
    let lockToken
    try {
      if (!world.admin?.upload || !world.admin?.acquireDeployLock) {
        setError('Admin connection required.')
        return
      }
      const text = state.model.getValue()
      const ext = getFileExtension(path)
      const assetExt = ext || 'js'
      const baseName = path.split('/').pop() || 'module'
      const filename = baseName.includes('.') ? baseName : `${baseName}.${assetExt}`
      const mime =
        assetExt === 'ts' || assetExt === 'tsx' ? 'text/typescript' : 'text/javascript'
      const file = new File([text], filename, { type: mime })
      const hash = await hashFile(file)
      const assetFilename = `${hash}.${assetExt}`
      const assetUrl = `asset://${assetFilename}`
      const scope = deriveLockScopeFromBlueprintId(scriptRoot.id)
      const result = await world.admin.acquireDeployLock({
        owner: world.network.id,
        scope,
      })
      lockToken = result?.token || world.admin.deployLockToken
      await world.admin.upload(file)
      const resolvedUrl = world.resolveURL ? world.resolveURL(assetUrl) : assetUrl
      world.loader.setFile?.(resolvedUrl, file)
      const nextScriptFiles = { ...scriptFiles, [path]: assetUrl }
      const nextVersion = rootVersion + 1
      const change = {
        id: scriptRoot.id,
        version: nextVersion,
        script: nextScriptFiles[entryPath],
        scriptEntry: entryPath,
        scriptFiles: nextScriptFiles,
        scriptFormat: scriptRoot.scriptFormat || 'module',
      }
      world.blueprints.modify(change)
      world.admin.blueprintModify(change, {
        ignoreNetworkId: world.network.id,
        lockToken,
      })
      state.originalText = text
      state.dirty = false
      state.version = nextVersion
      state.assetUrl = assetUrl
      state.isNew = false
      setDirtyTick(tick => tick + 1)
      world.emit('toast', 'Script saved')
    } catch (err) {
      const code = err?.code || err?.message
      if (code === 'deploy_required') {
        setError('Deploy code required.')
      } else if (code === 'locked' || code === 'deploy_locked' || code === 'deploy_lock_required') {
        const owner = err?.lock?.owner
        setError(owner ? `Deploy locked by ${owner}.` : 'Deploy locked by another session.')
      } else if (code === 'admin_required' || code === 'admin_code_missing') {
        setError('Admin code required.')
      } else if (code === 'upload_failed') {
        setError('Upload failed.')
      } else {
        console.error(err)
        setError('Save failed.')
      }
    } finally {
      setSaving(false)
      if (lockToken && world.admin?.releaseDeployLock) {
        try {
          await world.admin.releaseDeployLock(lockToken)
        } catch (releaseErr) {
          console.error('failed to release deploy lock', releaseErr)
        }
      }
    }
  }, [
    scriptRoot,
    scriptFiles,
    entryPath,
    rootVersion,
    world,
  ])

  const saveAll = useCallback(
    async ({ paths } = {}) => {
      if (!scriptRoot || !scriptFiles) return false
      if (saving) return false
      const pending = []
      for (const [path, state] of fileStatesRef.current.entries()) {
        if (!state?.dirty) continue
        if (paths && !paths.has(path)) continue
        pending.push({ path, state })
      }
      if (!pending.length) return false
      if (!entryPath || !isValidScriptPath(entryPath)) {
        setError('Invalid script entry.')
        return false
      }
      if (!Object.prototype.hasOwnProperty.call(scriptFiles, entryPath)) {
        setError('Script entry missing.')
        return false
      }
      for (const { path, state } of pending) {
        if (!isValidScriptPath(path)) {
          setError('Invalid script path.')
          return false
        }
        if (!Object.prototype.hasOwnProperty.call(scriptFiles, path) && !state?.isNew) {
          setError('Missing script file.')
          return false
        }
        if (state.version !== rootVersion) {
          setError(null)
          setConflict('Script changed on the server. Refresh or retry.')
          return false
        }
      }
      setSaving(true)
      setError(null)
      setConflict(null)
      let lockToken
      try {
        if (!world.admin?.upload || !world.admin?.acquireDeployLock) {
          setError('Admin connection required.')
          return false
        }
        const nextScriptFiles = { ...scriptFiles }
        const updates = []
        const scope = deriveLockScopeFromBlueprintId(scriptRoot.id)
        const result = await world.admin.acquireDeployLock({
          owner: world.network.id,
          scope,
        })
        lockToken = result?.token || world.admin.deployLockToken
        for (const { path, state } of pending) {
          const text = state.model.getValue()
          const ext = getFileExtension(path)
          const assetExt = ext || 'js'
          const baseName = path.split('/').pop() || 'module'
          const filename = baseName.includes('.') ? baseName : `${baseName}.${assetExt}`
          const mime =
            assetExt === 'ts' || assetExt === 'tsx' ? 'text/typescript' : 'text/javascript'
          const file = new File([text], filename, { type: mime })
          const hash = await hashFile(file)
          const assetFilename = `${hash}.${assetExt}`
          const assetUrl = `asset://${assetFilename}`
          await world.admin.upload(file)
          const resolvedUrl = world.resolveURL ? world.resolveURL(assetUrl) : assetUrl
          world.loader.setFile?.(resolvedUrl, file)
          nextScriptFiles[path] = assetUrl
          updates.push({ path, text, assetUrl })
        }
        const nextVersion = rootVersion + 1
        const change = {
          id: scriptRoot.id,
          version: nextVersion,
          script: nextScriptFiles[entryPath],
          scriptEntry: entryPath,
          scriptFiles: nextScriptFiles,
          scriptFormat: scriptRoot.scriptFormat || 'module',
        }
        world.blueprints.modify(change)
        world.admin.blueprintModify(change, {
          ignoreNetworkId: world.network.id,
          lockToken,
        })
        for (const update of updates) {
          const state = fileStatesRef.current.get(update.path)
          if (!state) continue
          state.originalText = update.text
          state.dirty = false
          state.version = nextVersion
          state.assetUrl = update.assetUrl
          state.isNew = false
        }
        setDirtyTick(tick => tick + 1)
        if (updates.length === 1) {
          world.emit('toast', 'Script saved')
        } else {
          world.emit('toast', `Saved ${updates.length} files`)
        }
        return true
      } catch (err) {
        const code = err?.code || err?.message
        if (code === 'deploy_required') {
          setError('Deploy code required.')
        } else if (code === 'locked' || code === 'deploy_locked' || code === 'deploy_lock_required') {
          const owner = err?.lock?.owner
          setError(owner ? `Deploy locked by ${owner}.` : 'Deploy locked by another session.')
        } else if (code === 'admin_required' || code === 'admin_code_missing') {
          setError('Admin code required.')
        } else if (code === 'upload_failed') {
          setError('Upload failed.')
        } else {
          console.error(err)
          setError('Save failed.')
        }
        return false
      } finally {
        setSaving(false)
        if (lockToken && world.admin?.releaseDeployLock) {
          try {
            await world.admin.releaseDeployLock(lockToken)
          } catch (releaseErr) {
            console.error('failed to release deploy lock', releaseErr)
          }
        }
      }
    },
    [scriptRoot, scriptFiles, entryPath, rootVersion, world, saving]
  )

  saveAllRef.current = saveAll

  const commitAiProposal = useCallback(async (options = {}) => {
    if (!aiProposal?.files?.length) return
    if (saving) return
    const skipConfirm = options.skipConfirm === true
    const aiPaths = new Set(aiProposal.files.map(file => file.path))
    const otherDirty = []
    for (const [path, state] of fileStatesRef.current.entries()) {
      if (state?.dirty && !aiPaths.has(path)) {
        otherDirty.push(path)
      }
    }
    if (otherDirty.length && !skipConfirm) {
      const ok = await world.ui.confirm({
        title: 'Apply AI changes only?',
        message: `You have ${otherDirty.length} other unsaved file${otherDirty.length === 1 ? '' : 's'}. Apply AI changes without them?`,
        confirmText: 'Apply',
        cancelText: 'Cancel',
      })
      if (!ok) return
    }
    emitAiTelemetry('commit_start', {
      fileCount: aiPaths.size,
      paths: Array.from(aiPaths),
    })
    const ok = await saveAll({ paths: aiPaths })
    if (!ok) {
      emitAiTelemetry('commit_failed')
      return
    }
    clearAiProposal()
    world.emit('toast', 'AI changes applied')
    emitAiTelemetry('commit_success', { fileCount: aiPaths.size })
  }, [aiProposal, saving, world, saveAll, clearAiProposal, emitAiTelemetry])

  const discardAiProposal = useCallback(async () => {
    if (!aiProposal?.files?.length) return
    if (saving) return
    const ok = await world.ui.confirm({
      title: 'Discard AI changes?',
      message: 'This will restore the previous file contents.',
      confirmText: 'Discard',
      cancelText: 'Cancel',
    })
    if (!ok) return
    const removed = new Set()
    for (const file of aiProposal.files) {
      const state = fileStatesRef.current.get(file.path)
      if (!state?.model) continue
      if (file.isNew) {
        state.disposable?.dispose()
        state.model.dispose()
        fileStatesRef.current.delete(file.path)
        removed.add(file.path)
      } else {
        state.model.setValue(file.originalText)
      }
    }
    if (removed.size) {
      setExtraPaths(current => current.filter(path => !removed.has(path)))
      if (selectedPath && removed.has(selectedPath)) {
        const remaining = validPaths.filter(path => !removed.has(path))
        setSelectedPath(remaining[0] || null)
      }
      setDirtyTick(tick => tick + 1)
    }
    clearAiProposal()
    world.emit('toast', 'AI changes discarded')
    emitAiTelemetry('proposal_discarded', { fileCount: aiProposal.files.length })
  }, [
    aiProposal,
    saving,
    world,
    clearAiProposal,
    emitAiTelemetry,
    selectedPath,
    validPaths,
  ])

  useEffect(() => {
    if (!world.ui) return
    const api = {
      proposeChanges: applyAiPatchSet,
      openPreview: openAiPreview,
      closePreview: closeAiPreview,
      togglePreview: toggleAiPreview,
      commit: commitAiProposal,
      discard: discardAiProposal,
    }
    world.ui.scriptEditorAI = api
    return () => {
      if (world.ui.scriptEditorAI === api) {
        world.ui.scriptEditorAI = null
      }
    }
  }, [
    world,
    applyAiPatchSet,
    openAiPreview,
    closeAiPreview,
    toggleAiPreview,
    commitAiProposal,
    discardAiProposal,
  ])

  const retrySave = useCallback(async () => {
    const path = currentPathRef.current
    if (!path) return
    const state = fileStatesRef.current.get(path)
    if (!state) return
    state.version = rootVersion
    setConflict(null)
    await saveCurrent()
  }, [rootVersion, saveCurrent])

  useEffect(() => {
    onHandle?.({
      copy,
      save: saveCurrent,
      saveAll,
      refresh: refreshCurrent,
      retry: retrySave,
      applyAiPatchSet,
      ai: aiProposal
        ? {
            active: true,
            summary: aiProposal.summary,
            source: aiProposal.source,
            fileCount: aiProposal.files.length,
            previewOpen: aiPreviewOpen,
            openPreview: openAiPreview,
            closePreview: closeAiPreview,
            togglePreview: toggleAiPreview,
            commit: commitAiProposal,
            discard: discardAiProposal,
          }
        : null,
      saving,
      dirty: isDirtySelected,
      dirtyCount,
      error,
      conflict,
      selectedPath,
    })
  }, [
    copy,
    saveCurrent,
    saveAll,
    refreshCurrent,
    retrySave,
    applyAiPatchSet,
    aiProposal,
    aiPreviewOpen,
    openAiPreview,
    closeAiPreview,
    toggleAiPreview,
    commitAiProposal,
    discardAiProposal,
    saving,
    isDirtySelected,
    dirtyCount,
    error,
    conflict,
    selectedPath,
    onHandle,
  ])

  if (!scriptRoot || !scriptFiles) {
    return (
      <div
        className='script-files-empty'
        css={css`
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          color: rgba(255, 255, 255, 0.5);
        `}
      >
        No module sources found.
      </div>
    )
  }

  return (
    <div
      className='script-files'
      css={css`
        flex: 1;
        display: flex;
        position: relative;
        min-height: 0;
        .script-files-tree {
          width: 12.5rem;
          flex-shrink: 0;
          border-right: 1px solid rgba(255, 255, 255, 0.05);
          padding: 0.75rem;
          overflow-y: auto;
        }
        .script-files-heading {
          font-size: 0.75rem;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: rgba(255, 255, 255, 0.45);
          margin: 0;
        }
        .script-files-heading-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
          margin-bottom: 0.5rem;
        }
        .script-files-actions {
          display: flex;
          align-items: center;
          gap: 0.35rem;
        }
        .script-files-add {
          height: 1.4rem;
          padding: 0 0.6rem;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.15);
          background: transparent;
          color: rgba(255, 255, 255, 0.75);
          font-size: 0.6rem;
          text-transform: uppercase;
          letter-spacing: 0.08em;
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
        .script-files-new {
          display: flex;
          flex-direction: column;
          gap: 0.35rem;
          margin-bottom: 0.75rem;
        }
        .script-files-new input {
          width: 100%;
          border-radius: 0.5rem;
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: rgba(8, 9, 14, 0.6);
          color: rgba(255, 255, 255, 0.9);
          font-size: 0.75rem;
          padding: 0.35rem 0.5rem;
        }
        .script-files-new input::placeholder {
          color: rgba(255, 255, 255, 0.45);
        }
        .script-files-new-actions {
          display: flex;
          gap: 0.35rem;
        }
        .script-files-new-btn {
          flex: 1;
          height: 1.6rem;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 0.5rem;
          border: 1px solid rgba(255, 255, 255, 0.15);
          background: transparent;
          color: rgba(255, 255, 255, 0.8);
          font-size: 0.7rem;
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
        .script-files-new-btn.primary {
          border-color: rgba(0, 167, 255, 0.5);
          color: #00a7ff;
        }
        .script-files-new-error {
          font-size: 0.7rem;
          color: #ff6b6b;
        }
        .script-files-move {
          width: 100%;
          height: 1.6rem;
          margin-bottom: 0.5rem;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 0.5rem;
          border: 1px solid rgba(255, 255, 255, 0.15);
          background: transparent;
          color: rgba(255, 255, 255, 0.8);
          font-size: 0.7rem;
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
        .script-files-entry {
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.6);
          margin-bottom: 0.75rem;
          word-break: break-word;
        }
        .script-file {
          display: flex;
          align-items: center;
          gap: 0.35rem;
          padding: 0.2rem 0.35rem;
          border-radius: 0.3rem;
          cursor: pointer;
          font-size: 0.8rem;
          color: rgba(255, 255, 255, 0.85);
        }
        .script-file.folder {
          cursor: default;
          color: rgba(255, 255, 255, 0.6);
        }
        .script-file.selected {
          background: rgba(0, 167, 255, 0.1);
          color: #00a7ff;
        }
        .script-file-name {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          flex: 1;
        }
        .script-file-entry-tag {
          font-size: 0.65rem;
          padding: 0 0.25rem;
          border-radius: 0.25rem;
          border: 1px solid rgba(255, 255, 255, 0.2);
          color: rgba(255, 255, 255, 0.7);
        }
        .script-file-dirty {
          color: #ffb74d;
          font-weight: 600;
        }
        .script-files-editor {
          flex: 1;
          position: relative;
          min-width: 0;
        }
        .script-files-editor-mount {
          position: absolute;
          inset: 0;
        }
        .script-files-warning {
          font-size: 0.75rem;
          color: rgba(255, 176, 77, 0.9);
          margin-top: 0.75rem;
        }
        .script-files-loading {
          position: absolute;
          top: 0.5rem;
          right: 0.75rem;
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.6);
          z-index: 1;
        }
        .script-files-ai-overlay {
          position: absolute;
          inset: 0;
          background: rgba(8, 8, 14, 0.96);
          display: flex;
          flex-direction: column;
          z-index: 5;
        }
        .script-files-ai-header {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding: 0.75rem 1rem;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }
        .script-files-ai-title {
          font-size: 0.9rem;
          font-weight: 600;
          color: rgba(255, 255, 255, 0.9);
        }
        .script-files-ai-summary {
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.6);
        }
        .script-files-ai-actions {
          margin-left: auto;
          display: flex;
          gap: 0.5rem;
        }
        .script-files-ai-action {
          height: 1.8rem;
          padding: 0 0.7rem;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.2);
          background: transparent;
          color: rgba(255, 255, 255, 0.85);
          font-size: 0.75rem;
          &:hover {
            cursor: pointer;
            border-color: rgba(255, 255, 255, 0.35);
            color: white;
          }
          &:disabled {
            opacity: 0.5;
            cursor: default;
          }
        }
        .script-files-ai-body {
          flex: 1;
          display: flex;
          min-height: 0;
        }
        .script-files-ai-list {
          width: 12.5rem;
          padding: 0.75rem;
          border-right: 1px solid rgba(255, 255, 255, 0.08);
          overflow-y: auto;
        }
        .script-files-ai-item {
          padding: 0.35rem 0.4rem;
          border-radius: 0.35rem;
          font-size: 0.8rem;
          color: rgba(255, 255, 255, 0.75);
          cursor: pointer;
        }
        .script-files-ai-item.selected {
          background: rgba(0, 167, 255, 0.15);
          color: #00a7ff;
        }
        .script-files-ai-diff {
          flex: 1;
          position: relative;
          min-width: 0;
        }
        .script-files-ai-diff-mount {
          position: absolute;
          inset: 0;
        }
      `}
    >
      <div className='script-files-tree noscrollbar'>
        <div className='script-files-heading-row'>
          <div className='script-files-heading'>Files</div>
          <div className='script-files-actions'>
            <button
              className='script-files-add'
              type='button'
              disabled={!editorReady}
              onClick={() => {
                if (!newFileOpen) {
                  openNewFile()
                }
              }}
            >
              New
            </button>
            <button
              className='script-files-add'
              type='button'
              disabled={!editorReady}
              onClick={openNewSharedFile}
            >
              Shared
            </button>
          </div>
        </div>
        {newFileOpen && (
          <div className='script-files-new'>
            <input
              ref={newFileInputRef}
              value={newFilePath}
              placeholder='new-file.js'
              onChange={event => {
                setNewFilePath(event.target.value)
                if (newFileError) {
                  setNewFileError(null)
                }
              }}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  createNewFile()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelNewFile()
                }
              }}
            />
            <div className='script-files-new-actions'>
              <button
                className='script-files-new-btn primary'
                type='button'
                disabled={!newFilePath.trim()}
                onClick={createNewFile}
              >
                Add
              </button>
              <button className='script-files-new-btn' type='button' onClick={cancelNewFile}>
                Cancel
              </button>
            </div>
            {newFileError && <div className='script-files-new-error'>{newFileError}</div>}
          </div>
        )}
        {entryPath && <div className='script-files-entry'>Entry: {entryPath}</div>}
        {canMoveToShared && (
          <button
            className='script-files-move'
            type='button'
            disabled={!editorReady}
            onClick={moveSelectedToShared}
          >
            Move to shared
          </button>
        )}
        {validPaths.length === 0 && <div className='script-files-entry'>No script files.</div>}
        {renderTree(tree, {
          selectedPath,
          entryPath,
          onSelect: path => setSelectedPath(path),
          dirtyPaths: fileStatesRef.current,
        })}
        {invalidPaths.length > 0 && (
          <div className='script-files-warning'>
            Some script files have invalid paths and are hidden.
          </div>
        )}
      </div>
      <div className='script-files-editor'>
        {loading && <div className='script-files-loading'>Loading...</div>}
        <div className='script-files-editor-mount' ref={mountRef} />
      </div>
      {aiPreviewOpen && aiProposal && (
        <div className='script-files-ai-overlay'>
          <div className='script-files-ai-header'>
            <div className='script-files-ai-title'>AI Review</div>
            <div className='script-files-ai-summary'>
              {aiProposal.summary ||
                `${aiProposal.files.length} file${aiProposal.files.length === 1 ? '' : 's'} changed`}
            </div>
            <div className='script-files-ai-actions'>
              <button className='script-files-ai-action' type='button' onClick={closeAiPreview}>
                Close
              </button>
              <button
                className='script-files-ai-action'
                type='button'
                disabled={saving}
                onClick={() => commitAiProposal()}
              >
                {saving ? 'Applying...' : 'Apply'}
              </button>
              <button
                className='script-files-ai-action'
                type='button'
                disabled={saving}
                onClick={() => discardAiProposal()}
              >
                Discard
              </button>
            </div>
          </div>
          <div className='script-files-ai-body'>
            <div className='script-files-ai-list noscrollbar'>
              {aiProposal.files.map(file => (
                <div
                  key={file.path}
                  className={cls('script-files-ai-item', { selected: file.path === aiPreviewPath })}
                  onClick={() => {
                    setAiPreviewPath(file.path)
                    setSelectedPath(file.path)
                  }}
                >
                  {file.path}
                </div>
              ))}
            </div>
            <div className='script-files-ai-diff'>
              <div className='script-files-ai-diff-mount' ref={diffMountRef} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function renderTree(node, { selectedPath, entryPath, onSelect, dirtyPaths }, depth = 0) {
  if (!node?.children) return null
  const entries = Array.from(node.children.values()).sort((a, b) => {
    const aIsFile = !!a.path && (!a.children || a.children.size === 0)
    const bIsFile = !!b.path && (!b.children || b.children.size === 0)
    if (aIsFile !== bIsFile) return aIsFile ? 1 : -1
    return a.name.localeCompare(b.name)
  })
  return entries.map(child => {
    const isFile = !!child.path
    const isSelected = isFile && child.path === selectedPath
    const isDirty = isFile && dirtyPaths.get(child.path)?.dirty
    return (
      <div key={child.fullPath}>
        <div
          className={cls('script-file', {
            folder: !isFile,
            selected: isSelected,
          })}
          style={{ paddingLeft: `${depth * 0.8}rem` }}
          onClick={() => {
            if (isFile) onSelect(child.path)
          }}
        >
          <span className='script-file-name'>{child.name}</span>
          {isFile && entryPath === child.path && <span className='script-file-entry-tag'>entry</span>}
          {isFile && isDirty && <span className='script-file-dirty'>*</span>}
        </div>
        {child.children && child.children.size > 0 && renderTree(child, { selectedPath, entryPath, onSelect, dirtyPaths }, depth + 1)}
      </div>
    )
  })
}
