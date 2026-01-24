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

  const [selectedPath, setSelectedPath] = useState(null)
  const [fontSize, setFontSize] = useState(() => 12 * world.prefs.ui)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [conflict, setConflict] = useState(null)
  const [dirtyTick, setDirtyTick] = useState(0)

  const scriptFiles = scriptRoot?.scriptFiles
  const entryPath = scriptRoot?.scriptEntry || ''
  const rootId = scriptRoot?.id || ''
  const rootVersion = Number.isFinite(scriptRoot?.version) ? scriptRoot.version : 0

  const { validPaths, invalidPaths } = useMemo(() => {
    const paths = scriptFiles && typeof scriptFiles === 'object' && !Array.isArray(scriptFiles) ? Object.keys(scriptFiles) : []
    const valid = []
    const invalid = []
    for (const path of paths) {
      if (isValidScriptPath(path)) {
        valid.push(path)
      } else {
        invalid.push(path)
      }
    }
    valid.sort((a, b) => a.localeCompare(b))
    return { validPaths: valid, invalidPaths: invalid }
  }, [scriptFiles])

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

  useEffect(() => {
    if (!rootId) return
    if (rootIdRef.current === rootId) return
    rootIdRef.current = rootId
    for (const state of fileStatesRef.current.values()) {
      state.model?.dispose()
      state.disposable?.dispose()
    }
    fileStatesRef.current.clear()
    setSelectedPath(validPaths[0] || null)
  }, [rootId, validPaths])

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
      const assetUrl = scriptFiles[path]
      if (!assetUrl) {
        setError('Missing script file.')
        return
      }
      const existing = fileStatesRef.current.get(path)
      if (existing && !force) {
        setEditorModel(path)
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

  useEffect(() => {
    let dead = false
    loadMonaco().then(monaco => {
      if (dead) return
      monacoRef.current = monaco
      const placeholder = monaco.editor.createModel(
        validPaths.length ? '// Loading...' : '// No module files',
        'javascript',
        monaco.Uri.parse(`inmemory://module/${rootId || 'default'}/placeholder`)
      )
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
      for (const state of fileStatesRef.current.values()) {
        state.model?.dispose()
        state.disposable?.dispose()
      }
      fileStatesRef.current.clear()
    }
  }, [])

  useEffect(() => {
    if (!selectedPath) return
    loadPath(selectedPath)
  }, [selectedPath, loadPath])

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
    if (!Object.prototype.hasOwnProperty.call(scriptFiles, path)) {
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
        scriptFormat: scriptRoot.scriptFormat || 'legacy-body',
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
      refresh: refreshCurrent,
      retry: retrySave,
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
    refreshCurrent,
    retrySave,
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
          margin-bottom: 0.5rem;
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
      `}
    >
      <div className='script-files-tree noscrollbar'>
        <div className='script-files-heading'>Files</div>
        {entryPath && <div className='script-files-entry'>Entry: {entryPath}</div>}
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
