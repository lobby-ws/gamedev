import { cls } from '../cls'

export function ScriptFilesAiOverlay({
  aiProposal,
  aiPreviewPath,
  saving,
  onClose,
  onCommit,
  onDiscard,
  onSelectFile,
  diffMountRef,
}) {
  if (!aiProposal) return null
  return (
    <div className='script-files-ai-overlay'>
      <div className='script-files-ai-header'>
        <div className='script-files-ai-title'>AI Review</div>
        <div className='script-files-ai-summary'>
          {aiProposal.summary ||
            `${aiProposal.files.length} file${aiProposal.files.length === 1 ? '' : 's'} changed`}
        </div>
        <div className='script-files-ai-actions'>
          <button className='script-files-ai-action' type='button' onClick={onClose}>
            Close
          </button>
          <button
            className='script-files-ai-action'
            type='button'
            disabled={saving}
            onClick={onCommit}
          >
            {saving ? 'Applying...' : 'Apply'}
          </button>
          <button
            className='script-files-ai-action'
            type='button'
            disabled={saving}
            onClick={onDiscard}
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
              onClick={() => onSelectFile(file.path)}
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
  )
}
