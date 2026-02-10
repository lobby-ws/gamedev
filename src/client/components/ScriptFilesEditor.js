import { css } from '@firebolt-dev/css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { loadMonaco } from './monaco'
import { hashFile } from '../../core/utils-client'
import { isValidScriptPath } from '../../core/blueprintValidation'
import { buildScriptGroups } from '../../core/extras/blueprintGroups'
import { ScriptFilesAiOverlay } from './ScriptFilesEditor/ScriptFilesAiOverlay'
import { ScriptFilesTree } from './ScriptFilesEditor/ScriptFilesTree'
import {
  SHARED_PREFIX,
  buildFileTree,
  ensureJsExtension,
  getFileExtension,
  getLanguageForPath,
  getNewFileTemplate,
  isSharedPath,
  normalizeAiPatchSet,
  normalizeScope,
  resolveScriptFormatForSave,
  toSharedPath,
} from './ScriptFilesEditor/scriptFileUtils'

const aiDebugEnabled = (process?.env?.PUBLIC_DEBUG_AI_SCRIPT || globalThis?.env?.PUBLIC_DEBUG_AI_SCRIPT) === 'true'

export function ScriptFilesEditor({ world, scriptRoot, onHandle, aiLocked = false }) {
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
  const saveCurrentRef = useRef(null)
  const applyScriptUpdateRef = useRef(null)
  const newFileInputRef = useRef(null)
  const renameFileInputRef = useRef(null)
  const aiLockedRef = useRef(!!aiLocked)
  const prevAiLockedRef = useRef(!!aiLocked)

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
  const [renameFileOpen, setRenameFileOpen] = useState(false)
  const [renameFilePath, setRenameFilePath] = useState('')
  const [renameFileError, setRenameFileError] = useState(null)

  const scriptFiles = scriptRoot?.scriptFiles
  const entryPath = scriptRoot?.scriptEntry || ''
  const rootId = scriptRoot?.id || ''
  const rootVersion = Number.isFinite(scriptRoot?.version) ? scriptRoot.version : 0
  const canMoveToShared =
    !!selectedPath && selectedPath !== entryPath && isValidScriptPath(selectedPath) && !isSharedPath(selectedPath)
  const canRenameSelected = !!selectedPath && isValidScriptPath(selectedPath)
  const canDeleteSelected = !!selectedPath && selectedPath !== entryPath && isValidScriptPath(selectedPath)

  const { validPaths, invalidPaths } = useMemo(() => {
    const basePaths =
      scriptFiles && typeof scriptFiles === 'object' && !Array.isArray(scriptFiles) ? Object.keys(scriptFiles) : []
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

  const getStateStaleReason = useCallback(
    (path, state) => {
      if (!path || !state || state.isNew || !scriptFiles) return null
      if (!Object.prototype.hasOwnProperty.call(scriptFiles, path)) {
        return 'missing'
      }
      const currentAssetUrl = scriptFiles[path]
      if (!currentAssetUrl) {
        return 'missing'
      }
      if (state.assetUrl && state.assetUrl !== currentAssetUrl) {
        return 'changed'
      }
      return null
    },
    [scriptFiles]
  )

  const setServerConflict = useCallback(() => {
    setError(null)
    setConflict('Script changed on the server. Refresh or retry.')
  }, [])

  const setAiPendingError = useCallback(() => {
    setConflict(null)
    setError('AI request is running for this script. Wait for it to finish.')
  }, [])

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

  const revertDirtyEditsForAi = useCallback(() => {
    let changed = false
    const removed = new Set()
    for (const [path, state] of fileStatesRef.current.entries()) {
      if (!state?.dirty) continue
      changed = true
      if (state.isNew) {
        state.disposable?.dispose()
        state.model?.dispose()
        fileStatesRef.current.delete(path)
        removed.add(path)
        continue
      }
      if (state.model && state.model.getValue() !== state.originalText) {
        state.model.setValue(state.originalText)
      }
      state.dirty = false
    }
    if (removed.size) {
      setExtraPaths(current => current.filter(path => !removed.has(path)))
      if (selectedPath && removed.has(selectedPath)) {
        const remaining = validPaths.filter(path => !removed.has(path))
        setSelectedPath(remaining[0] || null)
      }
    }
    if (changed) {
      setDirtyTick(tick => tick + 1)
      world.emit('toast', 'Reverted local edits while AI request runs')
    }
    setConflict(null)
    setError(null)
  }, [selectedPath, validPaths, world])

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
    setRenameFileOpen(false)
    setRenameFilePath('')
    setRenameFileError(null)
  }, [rootId, validPaths, clearAiProposal])

  useEffect(() => {
    if (!aiProposal) return
    clearAiProposal()
  }, [rootVersion, aiProposal, clearAiProposal])

  useEffect(() => {
    if (aiLocked && !prevAiLockedRef.current) {
      revertDirtyEditsForAi()
      setNewFileOpen(false)
      setNewFilePath('')
      setNewFileError(null)
      setRenameFileOpen(false)
      setRenameFilePath('')
      setRenameFileError(null)
      clearAiProposal()
    }
    prevAiLockedRef.current = !!aiLocked
  }, [aiLocked, revertDirtyEditsForAi, clearAiProposal])

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
    aiLockedRef.current = !!aiLocked
    if (editorRef.current) {
      editorRef.current.updateOptions({ readOnly: !!aiLocked })
    }
  }, [aiLocked])

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
    async (path, { allowMissing, useTemplate } = {}) => {
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
        const template = useTemplate ? getNewFileTemplate() : ''
        let model = monaco.editor.getModel(uri)
        if (!model) {
          model = monaco.editor.createModel(template, getLanguageForPath(path), uri)
        } else if (model.getValue() !== template) {
          model.setValue(template)
        }
        const state = {
          model,
          originalText: template,
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

  const rekeyFileState = useCallback(
    (fromPath, toPath, { focus = true } = {}) => {
      if (!fromPath || !toPath || fromPath === toPath) return fileStatesRef.current.get(fromPath) || null
      const state = fileStatesRef.current.get(fromPath)
      const monaco = monacoRef.current
      if (!state?.model || !monaco) return null
      const sourceModel = state.model
      const nextUri = monaco.Uri.parse(`inmemory://module/${rootId}/${toPath}`)
      let nextModel = monaco.editor.getModel(nextUri)
      if (nextModel && nextModel !== sourceModel) {
        nextModel.dispose()
        nextModel = null
      }
      if (!nextModel) {
        nextModel = monaco.editor.createModel(sourceModel.getValue(), getLanguageForPath(toPath), nextUri)
      }
      const nextState = {
        ...state,
        model: nextModel,
        disposable: null,
      }
      nextState.disposable = nextModel.onDidChangeContent(() => {
        const nextDirty = nextModel.getValue() !== nextState.originalText
        if (nextDirty !== nextState.dirty) {
          nextState.dirty = nextDirty
          setDirtyTick(tick => tick + 1)
        }
      })

      const editor = editorRef.current
      if (currentPathRef.current === fromPath && editor && editor.getModel() === sourceModel) {
        nextState.viewState = editor.saveViewState()
        currentPathRef.current = toPath
        editor.setModel(nextModel)
        if (nextState.viewState) {
          editor.restoreViewState(nextState.viewState)
        }
        if (focus) {
          editor.focus()
        }
      }

      state.disposable?.dispose()
      fileStatesRef.current.delete(fromPath)
      fileStatesRef.current.set(toPath, nextState)
      sourceModel.dispose()
      setDirtyTick(tick => tick + 1)
      return nextState
    },
    [rootId]
  )

  const removeFileState = useCallback(path => {
    if (!path) return
    const state = fileStatesRef.current.get(path)
    if (!state) return
    const editor = editorRef.current
    if (currentPathRef.current === path && editor && editor.getModel() === state.model) {
      currentPathRef.current = null
      if (placeholderModelRef.current) {
        editor.setModel(placeholderModelRef.current)
      }
    }
    state.disposable?.dispose()
    state.model?.dispose()
    fileStatesRef.current.delete(path)
    setDirtyTick(tick => tick + 1)
  }, [])

  const openNewFile = useCallback(() => {
    if (!scriptRoot || !scriptFiles) return
    if (aiLockedRef.current) {
      setAiPendingError()
      return
    }
    setRenameFileOpen(false)
    setRenameFilePath('')
    setRenameFileError(null)
    setNewFileOpen(true)
    setNewFilePath('')
    setNewFileError(null)
    requestAnimationFrame(() => {
      newFileInputRef.current?.focus()
    })
  }, [scriptRoot, scriptFiles, setAiPendingError])

  const openNewSharedFile = useCallback(() => {
    if (!scriptRoot || !scriptFiles) return
    if (aiLockedRef.current) {
      setAiPendingError()
      return
    }
    setRenameFileOpen(false)
    setRenameFilePath('')
    setRenameFileError(null)
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
  }, [scriptRoot, scriptFiles, setAiPendingError])

  const cancelNewFile = useCallback(() => {
    setNewFileOpen(false)
    setNewFilePath('')
    setNewFileError(null)
  }, [])

  const createNewFile = useCallback(async () => {
    if (!scriptRoot || !scriptFiles) return
    if (aiLockedRef.current) {
      setAiPendingError()
      return
    }
    const trimmed = newFilePath.trim()
    if (!trimmed) {
      setNewFileError('Enter a file path.')
      return
    }
    const normalizedPath = ensureJsExtension(trimmed)
    if (normalizedPath !== trimmed) {
      setNewFilePath(normalizedPath)
    }
    if (!isValidScriptPath(normalizedPath)) {
      setNewFileError('Invalid path. Use helpers/util.js or @shared/helpers/util.js.')
      return
    }
    if (
      Object.prototype.hasOwnProperty.call(scriptFiles, normalizedPath) ||
      extraPaths.includes(normalizedPath) ||
      fileStatesRef.current.has(normalizedPath)
    ) {
      setNewFileError('That file already exists.')
      return
    }
    try {
      const state = await ensureFileState(normalizedPath, { allowMissing: true, useTemplate: true })
      if (!state) throw new Error('new_file_failed')
      state.originalText = ''
      state.dirty = true
      setDirtyTick(tick => tick + 1)
      setSelectedPath(normalizedPath)
      setNewFileOpen(false)
      setNewFilePath('')
      setNewFileError(null)
      if (saveAllRef.current) {
        await saveAllRef.current({ paths: new Set([normalizedPath]) })
      }
    } catch (err) {
      console.error(err)
      setNewFileError('Failed to create file.')
    }
  }, [scriptRoot, scriptFiles, newFilePath, extraPaths, ensureFileState, setAiPendingError])

  const openRenameFile = useCallback(() => {
    if (!scriptRoot || !scriptFiles) return
    if (aiLockedRef.current) {
      setAiPendingError()
      return
    }
    if (!selectedPath || !isValidScriptPath(selectedPath)) return
    setNewFileOpen(false)
    setNewFilePath('')
    setNewFileError(null)
    setRenameFileOpen(true)
    setRenameFilePath(selectedPath)
    setRenameFileError(null)
    requestAnimationFrame(() => {
      const input = renameFileInputRef.current
      if (!input) return
      input.focus()
      if (typeof input.setSelectionRange === 'function') {
        const end = input.value.length
        input.setSelectionRange(end, end)
      }
    })
  }, [scriptRoot, scriptFiles, selectedPath, setAiPendingError])

  const cancelRenameFile = useCallback(() => {
    setRenameFileOpen(false)
    setRenameFilePath('')
    setRenameFileError(null)
  }, [])

  const moveSelectedToShared = useCallback(async () => {
    if (!scriptRoot || !scriptFiles) return
    if (aiLockedRef.current) {
      setAiPendingError()
      return
    }
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
    const persisted = Object.prototype.hasOwnProperty.call(scriptFiles, path)
    try {
      const state = await ensureFileState(path, { allowMissing: !persisted })
      if (!state?.model) {
        setError('Missing script file.')
        return
      }

      if (!persisted) {
        const nextState = rekeyFileState(path, sharedPath)
        if (!nextState) {
          setError('Failed to move to shared.')
          return
        }
        nextState.isNew = true
        setExtraPaths(current => current.map(item => (item === path ? sharedPath : item)))
        setSelectedPath(sharedPath)
        setError(null)
        setConflict(null)
        world.emit('toast', 'Moved to shared')
        return
      }

      if (getStateStaleReason(path, state)) {
        setServerConflict()
        return
      }
      if (!entryPath || !Object.prototype.hasOwnProperty.call(scriptFiles, entryPath)) {
        setError('Script entry missing.')
        return
      }

      const nextScriptFiles = { ...scriptFiles }
      const assetUrl = nextScriptFiles[path]
      if (!assetUrl) {
        setError('Missing script file.')
        return
      }
      delete nextScriptFiles[path]
      nextScriptFiles[sharedPath] = assetUrl
      const scriptUpdate = {
        script: nextScriptFiles[entryPath],
        scriptEntry: entryPath,
        scriptFiles: nextScriptFiles,
        scriptFormat: resolveScriptFormatForSave(scriptRoot, entryPath, fileStatesRef.current),
      }

      setSaving(true)
      setError(null)
      setConflict(null)
      const applyScriptUpdateFn = applyScriptUpdateRef.current
      if (!applyScriptUpdateFn) {
        throw new Error('update_unavailable')
      }
      const result = await applyScriptUpdateFn(scriptUpdate)
      if (result.mode === 'fork') {
        world.emit('toast', 'Script forked')
        return
      }

      const nextState = rekeyFileState(path, sharedPath)
      if (!nextState) {
        throw new Error('move_state_failed')
      }
      nextState.assetUrl = assetUrl
      nextState.isNew = false
      nextState.version = result.nextVersion
      setExtraPaths(current => current.filter(item => item !== path && item !== sharedPath))
      setSelectedPath(sharedPath)
      world.emit('toast', 'Moved to shared')
    } catch (err) {
      const code = err?.code || err?.message
      if (code === 'version_mismatch') {
        setServerConflict()
      } else if (code === 'ai_request_pending') {
        setAiPendingError()
      } else if (code === 'admin_required' || code === 'admin_code_missing' || code === 'deploy_required') {
        setError('Admin code required.')
      } else if (code === 'locked' || code === 'deploy_locked' || code === 'deploy_lock_required') {
        const owner = err?.lock?.owner
        setError(owner ? `Deploy locked by ${owner}.` : 'Deploy locked by another session.')
      } else if (code === 'builder_required') {
        setError('Builder access required.')
      } else if (code === 'scope_required') {
        setError('Script scope metadata is missing.')
      } else if (code !== 'fork_failed') {
        console.error(err)
        setError('Failed to move to shared.')
      }
    } finally {
      setSaving(false)
    }
  }, [
    scriptRoot,
    scriptFiles,
    entryPath,
    world,
    saving,
    selectedPath,
    extraPaths,
    ensureFileState,
    rekeyFileState,
    getStateStaleReason,
    setServerConflict,
    setAiPendingError,
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
        const staleReason = getStateStaleReason(path, existing)
        if (!staleReason) {
          setEditorModel(path)
          return
        }
        if (existing.dirty) {
          setEditorModel(path)
          setServerConflict()
          return
        }
      }
      const assetUrl = scriptFiles[path]
      if (!assetUrl) {
        if (existing && existing.dirty) {
          setServerConflict()
        } else {
          setError('Missing script file.')
        }
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
    [scriptRoot, scriptFiles, rootId, rootVersion, setEditorModel, world, getStateStaleReason, setServerConflict]
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
        if (state && getStateStaleReason(path, state)) {
          setServerConflict()
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
      getStateStaleReason,
      selectedPath,
      setServerConflict,
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
        readOnly: aiLockedRef.current,
      })
      editor.addAction({
        id: 'script-editor-save',
        label: 'Save Script',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: async () => {
          if (aiLockedRef.current) {
            setAiPendingError()
            return
          }
          if (saveAllRef.current) {
            const savedAny = await saveAllRef.current()
            if (savedAny) return
          }
          await saveCurrentRef.current?.()
        },
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
    const onKeyDown = event => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (String(event.key || '').toLowerCase() !== 's') return
      event.preventDefault()
      event.stopPropagation()
      ;(async () => {
        if (aiLockedRef.current) {
          setAiPendingError()
          return
        }
        if (saveAllRef.current) {
          const savedAny = await saveAllRef.current()
          if (savedAny) return
        }
        await saveCurrentRef.current?.()
      })().catch(err => {
        console.error(err)
      })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [setAiPendingError])

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
          originalModel = monaco.editor.createModel(entry.originalText, getLanguageForPath(aiPreviewPath), uri)
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
    if (aiLockedRef.current) {
      setAiPendingError()
      return
    }
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
  }, [selectedPath, loadPath, world, setAiPendingError])

  const resolveScriptUpdateMode = useCallback(async () => {
    const app = world.ui?.state?.app || null
    const targetBlueprint =
      (app?.data?.blueprint && world.blueprints.get(app.data.blueprint)) || app?.blueprint || scriptRoot
    if (!scriptRoot) {
      return { mode: 'group', group: null, targetBlueprint }
    }
    const groups = buildScriptGroups(world.blueprints.items)
    const group = (targetBlueprint?.id && groups.byId.get(targetBlueprint.id)) || groups.byId.get(scriptRoot.id) || null
    const groupSize = group?.items?.length || 0
    const targetId = typeof targetBlueprint?.id === 'string' ? targetBlueprint.id : null
    const scriptRootId = typeof scriptRoot?.id === 'string' ? scriptRoot.id : null
    const shouldFork =
      !!app &&
      (groupSize > 1 || (!!targetId && !!scriptRootId && targetId !== scriptRootId))
    return { mode: shouldFork ? 'fork' : 'group', group, targetBlueprint }
  }, [world, scriptRoot])

  const applyScriptUpdate = useCallback(
    async scriptUpdate => {
      if (aiLockedRef.current) {
        const err = new Error('ai_request_pending')
        err.code = 'ai_request_pending'
        throw err
      }
      const updateMode = await resolveScriptUpdateMode()

      if (updateMode.mode === 'fork') {
        if (!world.builder?.forkTemplateFromBlueprint) {
          const err = new Error('builder_required')
          err.code = 'builder_required'
          throw err
        }
        const sourceBlueprint = updateMode.targetBlueprint || scriptRoot
        const forked = await world.builder.forkTemplateFromBlueprint(sourceBlueprint, 'Code fork', null, {
          ...scriptUpdate,
          scriptRef: null,
        })
        if (!forked) {
          const err = new Error('fork_failed')
          err.code = 'fork_failed'
          throw err
        }
        const app = world.ui?.state?.app
        if (app) {
          app.modify({ blueprint: forked.id })
          world.admin.entityModify({ id: app.data.id, blueprint: forked.id }, { ignoreNetworkId: world.network.id })
        }
        return { mode: 'fork', nextVersion: null }
      }

      if (!world.admin?.acquireDeployLock || !world.admin?.blueprintModify) {
        const err = new Error('admin_required')
        err.code = 'admin_required'
        throw err
      }
      const scope = normalizeScope(scriptRoot?.scope)
      if (!scope) {
        const err = new Error('scope_required')
        err.code = 'scope_required'
        throw err
      }

      let lockToken
      try {
        const result = await world.admin.acquireDeployLock({
          owner: world.network.id,
          scope,
        })
        lockToken = result?.token || world.admin.deployLockToken
        const nextVersion = rootVersion + 1
        const change = {
          id: scriptRoot.id,
          version: nextVersion,
          ...scriptUpdate,
        }
        await world.admin.blueprintModify(change, {
          ignoreNetworkId: world.network.id,
          lockToken,
          request: true,
        })

        const siblingChanges = []
        if (updateMode.group?.items?.length) {
          for (const sibling of updateMode.group.items) {
            if (!sibling?.id || sibling.id === scriptRoot.id) continue
            const siblingChange = {
              id: sibling.id,
              version: (sibling.version || 0) + 1,
              script: scriptUpdate.script,
              scriptEntry: null,
              scriptFiles: null,
              scriptFormat: scriptUpdate.scriptFormat,
              scriptRef: scriptRoot.id,
            }
            await world.admin.blueprintModify(siblingChange, {
              ignoreNetworkId: world.network.id,
              lockToken,
              request: true,
            })
            siblingChanges.push(siblingChange)
          }
        }

        world.blueprints.modify(change)
        for (const siblingChange of siblingChanges) {
          world.blueprints.modify(siblingChange)
        }
        return { mode: 'group', nextVersion }
      } finally {
        if (lockToken && world.admin?.releaseDeployLock) {
          try {
            await world.admin.releaseDeployLock(lockToken)
          } catch (releaseErr) {
            console.error('failed to release deploy lock', releaseErr)
          }
        }
      }
    },
    [resolveScriptUpdateMode, world, scriptRoot, rootVersion]
  )
  applyScriptUpdateRef.current = applyScriptUpdate

  const renameSelectedFile = useCallback(async () => {
    if (!scriptRoot || !scriptFiles) return
    if (aiLockedRef.current) {
      setAiPendingError()
      return
    }
    if (saving) return
    const fromPath = selectedPath
    if (!fromPath || !isValidScriptPath(fromPath)) {
      setRenameFileError('Invalid script path.')
      return
    }
    const toPath = renameFilePath.trim()
    if (!toPath) {
      setRenameFileError('Enter a file path.')
      return
    }
    if (!isValidScriptPath(toPath)) {
      setRenameFileError('Invalid path. Use helpers/util.js or @shared/helpers/util.js.')
      return
    }
    if (toPath === fromPath) {
      cancelRenameFile()
      return
    }
    if (
      Object.prototype.hasOwnProperty.call(scriptFiles, toPath) ||
      extraPaths.includes(toPath) ||
      fileStatesRef.current.has(toPath)
    ) {
      setRenameFileError('That file already exists.')
      return
    }
    const persisted = Object.prototype.hasOwnProperty.call(scriptFiles, fromPath)
    const state = await ensureFileState(fromPath, { allowMissing: !persisted })
    if (!state?.model) {
      setRenameFileError('Missing script file.')
      return
    }

    if (!persisted) {
      const nextState = rekeyFileState(fromPath, toPath)
      if (!nextState) {
        setRenameFileError('Failed to rename file.')
        return
      }
      nextState.isNew = true
      setExtraPaths(current => current.map(item => (item === fromPath ? toPath : item)))
      setSelectedPath(toPath)
      cancelRenameFile()
      setError(null)
      setConflict(null)
      world.emit('toast', 'File renamed')
      return
    }

    const nextScriptFiles = { ...scriptFiles }
    const assetUrl = nextScriptFiles[fromPath]
    if (!assetUrl) {
      setRenameFileError('Missing script file.')
      return
    }
    delete nextScriptFiles[fromPath]
    nextScriptFiles[toPath] = assetUrl
    const nextEntryPath = entryPath === fromPath ? toPath : entryPath
    if (!nextEntryPath || !Object.prototype.hasOwnProperty.call(nextScriptFiles, nextEntryPath)) {
      setRenameFileError('Script entry missing.')
      return
    }
    const scriptUpdate = {
      script: nextScriptFiles[nextEntryPath],
      scriptEntry: nextEntryPath,
      scriptFiles: nextScriptFiles,
      scriptFormat: resolveScriptFormatForSave(
        scriptRoot,
        nextEntryPath,
        fileStatesRef.current,
        fromPath === entryPath ? state.model.getValue() : null
      ),
    }

    setSaving(true)
    setError(null)
    setConflict(null)
    setRenameFileError(null)
    try {
      const result = await applyScriptUpdate(scriptUpdate)
      if (result.mode === 'fork') {
        cancelRenameFile()
        world.emit('toast', 'Script forked')
        return
      }
      const nextState = rekeyFileState(fromPath, toPath)
      if (!nextState) {
        throw new Error('rename_state_failed')
      }
      nextState.version = result.nextVersion
      nextState.assetUrl = assetUrl
      nextState.isNew = false
      setExtraPaths(current => current.filter(item => item !== fromPath && item !== toPath))
      setSelectedPath(toPath)
      cancelRenameFile()
      world.emit('toast', 'File renamed')
    } catch (err) {
      const code = err?.code || err?.message
      if (code === 'version_mismatch') {
        setServerConflict()
      } else if (code === 'ai_request_pending') {
        setAiPendingError()
      } else if (code === 'admin_required' || code === 'admin_code_missing' || code === 'deploy_required') {
        setError('Admin code required.')
      } else if (code === 'locked' || code === 'deploy_locked' || code === 'deploy_lock_required') {
        const owner = err?.lock?.owner
        setError(owner ? `Deploy locked by ${owner}.` : 'Deploy locked by another session.')
      } else if (code === 'builder_required') {
        setError('Builder access required.')
      } else if (code === 'scope_required') {
        setError('Script scope metadata is missing.')
      } else if (code !== 'fork_failed') {
        console.error(err)
        setError('Rename failed.')
      }
      if (code !== 'fork_failed') {
        setRenameFileError('Rename failed.')
      }
    } finally {
      setSaving(false)
    }
  }, [
    scriptRoot,
    scriptFiles,
    saving,
    selectedPath,
    renameFilePath,
    extraPaths,
    entryPath,
    ensureFileState,
    rekeyFileState,
    cancelRenameFile,
    world,
    applyScriptUpdate,
    setServerConflict,
    setAiPendingError,
  ])

  const deleteSelectedFile = useCallback(async () => {
    if (!scriptRoot || !scriptFiles) return
    if (aiLockedRef.current) {
      setAiPendingError()
      return
    }
    if (saving) return
    const path = selectedPath
    if (!path || !isValidScriptPath(path)) return
    if (path === entryPath) {
      setError('Entry script cannot be deleted.')
      return
    }

    const state = fileStatesRef.current.get(path)
    const ok = await world.ui.confirm({
      title: 'Delete file?',
      message: state?.dirty ? `Delete ${path}? Unsaved edits will be discarded.` : `Delete ${path}?`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
    })
    if (!ok) return

    const persisted = Object.prototype.hasOwnProperty.call(scriptFiles, path)
    if (!persisted) {
      removeFileState(path)
      setExtraPaths(current => current.filter(item => item !== path))
      if (selectedPath === path) {
        const remaining = validPaths.filter(item => item !== path)
        setSelectedPath(remaining[0] || null)
      }
      setError(null)
      setConflict(null)
      world.emit('toast', 'File deleted')
      return
    }

    const nextScriptFiles = { ...scriptFiles }
    if (!nextScriptFiles[path]) {
      setError('Missing script file.')
      return
    }
    delete nextScriptFiles[path]
    const remainingPaths = Object.keys(nextScriptFiles).sort((a, b) => a.localeCompare(b))
    if (!remainingPaths.length) {
      setError('At least one script file is required.')
      return
    }
    const nextEntryPath = entryPath
    if (!nextEntryPath || !Object.prototype.hasOwnProperty.call(nextScriptFiles, nextEntryPath)) {
      setError('Script entry missing.')
      return
    }
    const scriptUpdate = {
      script: nextScriptFiles[nextEntryPath],
      scriptEntry: nextEntryPath,
      scriptFiles: nextScriptFiles,
      scriptFormat: resolveScriptFormatForSave(scriptRoot, nextEntryPath, fileStatesRef.current),
    }

    setSaving(true)
    setError(null)
    setConflict(null)
    try {
      const result = await applyScriptUpdate(scriptUpdate)
      if (result.mode === 'fork') {
        world.emit('toast', 'Script forked')
        return
      }
      removeFileState(path)
      setExtraPaths(current => current.filter(item => item !== path))
      if (selectedPath === path) {
        setSelectedPath(remainingPaths[0] || null)
      }
      world.emit('toast', 'File deleted')
    } catch (err) {
      const code = err?.code || err?.message
      if (code === 'version_mismatch') {
        setServerConflict()
      } else if (code === 'ai_request_pending') {
        setAiPendingError()
      } else if (code === 'admin_required' || code === 'admin_code_missing' || code === 'deploy_required') {
        setError('Admin code required.')
      } else if (code === 'locked' || code === 'deploy_locked' || code === 'deploy_lock_required') {
        const owner = err?.lock?.owner
        setError(owner ? `Deploy locked by ${owner}.` : 'Deploy locked by another session.')
      } else if (code === 'builder_required') {
        setError('Builder access required.')
      } else if (code === 'scope_required') {
        setError('Script scope metadata is missing.')
      } else if (code !== 'fork_failed') {
        console.error(err)
        setError('Delete failed.')
      }
    } finally {
      setSaving(false)
    }
  }, [
    scriptRoot,
    scriptFiles,
    saving,
    selectedPath,
    entryPath,
    world,
    validPaths,
    removeFileState,
    applyScriptUpdate,
    setServerConflict,
    setAiPendingError,
  ])

  const saveCurrent = useCallback(async () => {
    if (!scriptRoot || !scriptFiles) return
    if (aiLockedRef.current) {
      setAiPendingError()
      return
    }
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
    if (getStateStaleReason(path, state)) {
      setServerConflict()
      return
    }
    const updateMode = await resolveScriptUpdateMode()
    setSaving(true)
    setError(null)
    setConflict(null)
    let lockToken
    try {
      if (!world.admin?.upload) {
        setError('Admin connection required.')
        return
      }
      const text = state.model.getValue()
      const ext = getFileExtension(path)
      const assetExt = ext || 'js'
      const baseName = path.split('/').pop() || 'module'
      const filename = baseName.includes('.') ? baseName : `${baseName}.${assetExt}`
      const mime = assetExt === 'ts' || assetExt === 'tsx' ? 'text/typescript' : 'text/javascript'
      const file = new File([text], filename, { type: mime })
      const hash = await hashFile(file)
      const assetFilename = `${hash}.${assetExt}`
      const assetUrl = `asset://${assetFilename}`
      await world.admin.upload(file)
      const resolvedUrl = world.resolveURL ? world.resolveURL(assetUrl) : assetUrl
      world.loader.setFile?.(resolvedUrl, file)
      const nextScriptFiles = { ...scriptFiles, [path]: assetUrl }
      const entryUrl = nextScriptFiles[entryPath]
      const scriptUpdate = {
        script: entryUrl,
        scriptEntry: entryPath,
        scriptFiles: nextScriptFiles,
        scriptFormat: resolveScriptFormatForSave(
          scriptRoot,
          entryPath,
          fileStatesRef.current,
          path === entryPath ? text : null
        ),
      }

      if (updateMode.mode === 'fork') {
        if (!world.builder?.forkTemplateFromBlueprint) {
          setError('Builder access required.')
          return
        }
        const sourceBlueprint = updateMode.targetBlueprint || scriptRoot
        const forked = await world.builder.forkTemplateFromBlueprint(sourceBlueprint, 'Code fork', null, {
          ...scriptUpdate,
          scriptRef: null,
        })
        if (!forked) return
        const app = world.ui?.state?.app
        if (app) {
          app.modify({ blueprint: forked.id })
          world.admin.entityModify({ id: app.data.id, blueprint: forked.id }, { ignoreNetworkId: world.network.id })
        }
        world.emit('toast', 'Script forked')
        return
      }

      if (!world.admin?.acquireDeployLock) {
        setError('Admin connection required.')
        return
      }
      const scope = normalizeScope(scriptRoot.scope)
      if (!scope) {
        setError('Script scope metadata is missing.')
        return
      }
      const result = await world.admin.acquireDeployLock({
        owner: world.network.id,
        scope,
      })
      lockToken = result?.token || world.admin.deployLockToken
      const nextVersion = rootVersion + 1
      const change = {
        id: scriptRoot.id,
        version: nextVersion,
        ...scriptUpdate,
      }
      world.blueprints.modify(change)
      world.admin.blueprintModify(change, {
        ignoreNetworkId: world.network.id,
        lockToken,
      })
      if (updateMode.group?.items?.length) {
        for (const sibling of updateMode.group.items) {
          if (!sibling?.id || sibling.id === scriptRoot.id) continue
          const siblingChange = {
            id: sibling.id,
            version: (sibling.version || 0) + 1,
            script: entryUrl,
            scriptEntry: null,
            scriptFiles: null,
            scriptFormat: scriptUpdate.scriptFormat,
            scriptRef: scriptRoot.id,
          }
          world.blueprints.modify(siblingChange)
          world.admin.blueprintModify(siblingChange, {
            ignoreNetworkId: world.network.id,
            lockToken,
          })
        }
      }
      state.originalText = text
      state.dirty = false
      state.version = nextVersion
      state.assetUrl = assetUrl
      state.isNew = false
      setDirtyTick(tick => tick + 1)
      world.emit('toast', 'Script saved')
    } catch (err) {
      const code = err?.code || err?.message
      if (code === 'ai_request_pending') {
        setAiPendingError()
      } else if (code === 'admin_required' || code === 'admin_code_missing' || code === 'deploy_required') {
        setError('Admin code required.')
      } else if (code === 'locked' || code === 'deploy_locked' || code === 'deploy_lock_required') {
        const owner = err?.lock?.owner
        setError(owner ? `Deploy locked by ${owner}.` : 'Deploy locked by another session.')
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
    getStateStaleReason,
    resolveScriptUpdateMode,
    setServerConflict,
    setAiPendingError,
  ])

  const saveAll = useCallback(
    async ({ paths } = {}) => {
      if (!scriptRoot || !scriptFiles) return false
      if (aiLockedRef.current) {
        setAiPendingError()
        return false
      }
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
        if (getStateStaleReason(path, state)) {
          setServerConflict()
          return false
        }
      }
      const updateMode = await resolveScriptUpdateMode()
      setSaving(true)
      setError(null)
      setConflict(null)
      let lockToken
      try {
        if (!world.admin?.upload) {
          setError('Admin connection required.')
          return false
        }
        const nextScriptFiles = { ...scriptFiles }
        const updates = []
        for (const { path, state } of pending) {
          const text = state.model.getValue()
          const ext = getFileExtension(path)
          const assetExt = ext || 'js'
          const baseName = path.split('/').pop() || 'module'
          const filename = baseName.includes('.') ? baseName : `${baseName}.${assetExt}`
          const mime = assetExt === 'ts' || assetExt === 'tsx' ? 'text/typescript' : 'text/javascript'
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
        const entryUrl = nextScriptFiles[entryPath]
        let nextEntryText = null
        for (const update of updates) {
          if (update.path === entryPath) {
            nextEntryText = update.text
            break
          }
        }
        const scriptUpdate = {
          script: entryUrl,
          scriptEntry: entryPath,
          scriptFiles: nextScriptFiles,
          scriptFormat: resolveScriptFormatForSave(scriptRoot, entryPath, fileStatesRef.current, nextEntryText),
        }

        if (updateMode.mode === 'fork') {
          if (!world.builder?.forkTemplateFromBlueprint) {
            setError('Builder access required.')
            return false
          }
          const sourceBlueprint = updateMode.targetBlueprint || scriptRoot
          const forked = await world.builder.forkTemplateFromBlueprint(sourceBlueprint, 'Code fork', null, {
            ...scriptUpdate,
            scriptRef: null,
          })
          if (!forked) return false
          const app = world.ui?.state?.app
          if (app) {
            app.modify({ blueprint: forked.id })
            world.admin.entityModify({ id: app.data.id, blueprint: forked.id }, { ignoreNetworkId: world.network.id })
          }
          world.emit('toast', 'Script forked')
          return true
        }

        if (!world.admin?.acquireDeployLock) {
          setError('Admin connection required.')
          return false
        }
        const scope = normalizeScope(scriptRoot.scope)
        if (!scope) {
          setError('Script scope metadata is missing.')
          return false
        }
        const result = await world.admin.acquireDeployLock({
          owner: world.network.id,
          scope,
        })
        lockToken = result?.token || world.admin.deployLockToken
        const nextVersion = rootVersion + 1
        const change = {
          id: scriptRoot.id,
          version: nextVersion,
          ...scriptUpdate,
        }
        world.blueprints.modify(change)
        world.admin.blueprintModify(change, {
          ignoreNetworkId: world.network.id,
          lockToken,
        })
        if (updateMode.group?.items?.length) {
          for (const sibling of updateMode.group.items) {
            if (!sibling?.id || sibling.id === scriptRoot.id) continue
            const siblingChange = {
              id: sibling.id,
              version: (sibling.version || 0) + 1,
              script: entryUrl,
              scriptEntry: null,
              scriptFiles: null,
              scriptFormat: scriptUpdate.scriptFormat,
              scriptRef: scriptRoot.id,
            }
            world.blueprints.modify(siblingChange)
            world.admin.blueprintModify(siblingChange, {
              ignoreNetworkId: world.network.id,
              lockToken,
            })
          }
        }
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
        if (code === 'ai_request_pending') {
          setAiPendingError()
        } else if (code === 'admin_required' || code === 'admin_code_missing' || code === 'deploy_required') {
          setError('Admin code required.')
        } else if (code === 'locked' || code === 'deploy_locked' || code === 'deploy_lock_required') {
          const owner = err?.lock?.owner
          setError(owner ? `Deploy locked by ${owner}.` : 'Deploy locked by another session.')
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
    [
      scriptRoot,
      scriptFiles,
      entryPath,
      rootVersion,
      world,
      saving,
      resolveScriptUpdateMode,
      getStateStaleReason,
      setServerConflict,
      setAiPendingError,
    ]
  )

  saveCurrentRef.current = saveCurrent
  saveAllRef.current = saveAll

  const commitAiProposal = useCallback(
    async (options = {}) => {
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
    },
    [aiProposal, saving, world, saveAll, clearAiProposal, emitAiTelemetry]
  )

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
  }, [aiProposal, saving, world, clearAiProposal, emitAiTelemetry, selectedPath, validPaths])

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
  }, [world, applyAiPatchSet, openAiPreview, closeAiPreview, toggleAiPreview, commitAiProposal, discardAiProposal])

  const retrySave = useCallback(async () => {
    if (aiLockedRef.current) {
      setAiPendingError()
      return
    }
    const path = currentPathRef.current
    if (!path) return
    const state = fileStatesRef.current.get(path)
    if (!state) return
    if (scriptFiles && Object.prototype.hasOwnProperty.call(scriptFiles, path)) {
      const currentAssetUrl = scriptFiles[path]
      if (currentAssetUrl) {
        state.assetUrl = currentAssetUrl
      }
      state.isNew = false
    }
    state.version = rootVersion
    setConflict(null)
    await saveCurrent()
  }, [rootVersion, saveCurrent, scriptFiles, setAiPendingError])

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
      aiLocked,
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
    aiLocked,
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
        .script-files-move.danger {
          border-color: rgba(255, 107, 107, 0.45);
          color: #ff8a8a;
          &:hover {
            border-color: rgba(255, 107, 107, 0.75);
            color: #ffb3b3;
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
      <ScriptFilesTree
        tree={tree}
        validPaths={validPaths}
        invalidPaths={invalidPaths}
        selectedPath={selectedPath}
        entryPath={entryPath}
        dirtyPaths={fileStatesRef.current}
        newFileOpen={newFileOpen}
        newFilePath={newFilePath}
        newFileError={newFileError}
        newFileInputRef={newFileInputRef}
        onNewFileChange={event => {
          setNewFilePath(event.target.value)
          if (newFileError) {
            setNewFileError(null)
          }
        }}
        onNewFileKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            createNewFile()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            cancelNewFile()
          }
        }}
        onCreateNewFile={createNewFile}
        onCancelNewFile={cancelNewFile}
        renameFileOpen={renameFileOpen}
        renameFilePath={renameFilePath}
        renameFileError={renameFileError}
        renameFileInputRef={renameFileInputRef}
        onRenameFileChange={event => {
          setRenameFilePath(event.target.value)
          if (renameFileError) {
            setRenameFileError(null)
          }
        }}
        onRenameFileKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            renameSelectedFile()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            cancelRenameFile()
          }
        }}
        onRenameSelectedFile={renameSelectedFile}
        onCancelRenameFile={cancelRenameFile}
        onOpenNewFile={openNewFile}
        onOpenNewSharedFile={openNewSharedFile}
        onOpenRenameFile={openRenameFile}
        onDeleteSelectedFile={deleteSelectedFile}
        onMoveSelectedToShared={moveSelectedToShared}
        onSelectPath={path => setSelectedPath(path)}
        editorReady={editorReady}
        saving={saving}
        aiLocked={aiLocked}
        canRenameSelected={canRenameSelected}
        canDeleteSelected={canDeleteSelected}
        canMoveToShared={canMoveToShared}
      />
      <div className='script-files-editor'>
        {loading && <div className='script-files-loading'>Loading...</div>}
        <div className='script-files-editor-mount' ref={mountRef} />
      </div>
      {aiPreviewOpen && aiProposal && (
        <ScriptFilesAiOverlay
          aiProposal={aiProposal}
          aiPreviewPath={aiPreviewPath}
          saving={saving}
          onClose={closeAiPreview}
          onCommit={() => commitAiProposal()}
          onDiscard={() => discardAiProposal()}
          onSelectFile={path => {
            setAiPreviewPath(path)
            setSelectedPath(path)
          }}
          diffMountRef={diffMountRef}
        />
      )}
    </div>
  )
}
