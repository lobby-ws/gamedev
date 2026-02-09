import { cls } from '../cls'

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
        {child.children && child.children.size > 0 &&
          renderTree(child, { selectedPath, entryPath, onSelect, dirtyPaths }, depth + 1)}
      </div>
    )
  })
}

export function ScriptFilesTree({
  tree,
  validPaths,
  invalidPaths,
  selectedPath,
  entryPath,
  dirtyPaths,
  newFileOpen,
  newFilePath,
  newFileError,
  newFileInputRef,
  onNewFileChange,
  onNewFileKeyDown,
  onCreateNewFile,
  onCancelNewFile,
  renameFileOpen,
  renameFilePath,
  renameFileError,
  renameFileInputRef,
  onRenameFileChange,
  onRenameFileKeyDown,
  onRenameSelectedFile,
  onCancelRenameFile,
  onOpenNewFile,
  onOpenNewSharedFile,
  onOpenRenameFile,
  onDeleteSelectedFile,
  onMoveSelectedToShared,
  onSelectPath,
  editorReady,
  saving,
  canRenameSelected,
  canDeleteSelected,
  canMoveToShared,
}) {
  return (
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
                onOpenNewFile()
              }
            }}
          >
            New
          </button>
          <button
            className='script-files-add'
            type='button'
            disabled={!editorReady}
            onClick={onOpenNewSharedFile}
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
            onChange={onNewFileChange}
            onKeyDown={onNewFileKeyDown}
          />
          <div className='script-files-new-actions'>
            <button
              className='script-files-new-btn primary'
              type='button'
              disabled={!newFilePath.trim()}
              onClick={onCreateNewFile}
            >
              Add
            </button>
            <button className='script-files-new-btn' type='button' onClick={onCancelNewFile}>
              Cancel
            </button>
          </div>
          {newFileError && <div className='script-files-new-error'>{newFileError}</div>}
        </div>
      )}
      {renameFileOpen && (
        <div className='script-files-new'>
          <input
            ref={renameFileInputRef}
            value={renameFilePath}
            placeholder='helpers/util.js'
            onChange={onRenameFileChange}
            onKeyDown={onRenameFileKeyDown}
          />
          <div className='script-files-new-actions'>
            <button
              className='script-files-new-btn primary'
              type='button'
              disabled={!renameFilePath.trim()}
              onClick={onRenameSelectedFile}
            >
              Rename
            </button>
            <button className='script-files-new-btn' type='button' onClick={onCancelRenameFile}>
              Cancel
            </button>
          </div>
          {renameFileError && <div className='script-files-new-error'>{renameFileError}</div>}
        </div>
      )}
      {entryPath && <div className='script-files-entry'>Entry: {entryPath}</div>}
      {canRenameSelected && (
        <button
          className='script-files-move'
          type='button'
          disabled={!editorReady || saving}
          onClick={onOpenRenameFile}
        >
          Rename
        </button>
      )}
      {canDeleteSelected && (
        <button
          className='script-files-move danger'
          type='button'
          disabled={!editorReady || saving}
          onClick={onDeleteSelectedFile}
        >
          Delete
        </button>
      )}
      {canMoveToShared && (
        <button
          className='script-files-move'
          type='button'
          disabled={!editorReady || saving}
          onClick={onMoveSelectedToShared}
        >
          Move to shared
        </button>
      )}
      {validPaths.length === 0 && <div className='script-files-entry'>No script files.</div>}
      {renderTree(tree, {
        selectedPath,
        entryPath,
        onSelect: onSelectPath,
        dirtyPaths,
      })}
      {invalidPaths.length > 0 && (
        <div className='script-files-warning'>
          Some script files have invalid paths and are hidden.
        </div>
      )}
    </div>
  )
}
