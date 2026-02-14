import { useEffect, useRef } from 'react'
import { BookTextIcon, CodeIcon, LoaderPinwheelIcon, SparkleIcon } from 'lucide-react'
import { cls } from '../cls'

export function ScriptChatPanel({
  moduleRoot,
  aiMetaClass,
  aiMeta,
  aiMode,
  aiStatus,
  errorInfo,
  aiPromptRef,
  aiPrompt,
  aiCanUse,
  aiLocked,
  handlePromptChange,
  handlePromptKeyDown,
  handlePromptKeyUp,
  setAiMention,
  aiMention,
  aiAttachmentSet,
  addAiAttachment,
  aiAttachments,
  removeAiAttachment,
  entryPath,
  fileCount,
  scriptFormat,
  aiCanSend,
  sendAiRequest,
  aiAccessIssue,
  handle,
  aiThread,
}) {
  const threadRef = useRef(null)
  useEffect(() => {
    const el = threadRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [aiThread])
  if (!moduleRoot) return null
  return (
    <div className='script-ai-panel'>
      <div className='script-ai-panel-head'>
        <div className='script-ai-title'>
          <SparkleIcon size='0.9rem' />
          AI Chat
        </div>
        <div className={aiMetaClass}>{aiMeta}</div>
      </div>
      <div className='script-ai-panel-body'>
          <div className='script-ai-thread' ref={threadRef}>
            {aiThread?.length ? (
              aiThread.map(item => (
                <div key={item.id} className={cls('script-ai-msg', item.type)}>
                  {item.text}
                </div>
              ))
            ) : (
              <div className='script-ai-empty'>Start chatting to generate, fix, and apply script changes.</div>
            )}
          </div>
          {aiMode === 'edit' ? (
            <div className='script-ai-input'>
              <textarea
                ref={aiPromptRef}
                value={aiPrompt}
                disabled={!aiCanUse || aiLocked}
                placeholder='Ask for changes conversationally. Use @ to attach files.'
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
                            {item.type === 'doc' ? <BookTextIcon size='0.85rem' /> : <CodeIcon size='0.85rem' />}
                          </span>
                          <span className='script-ai-mention-path'>{item.path}</span>
                          <span className='script-ai-mention-tag'>{attached ? 'attached' : item.type}</span>
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
              {errorInfo.detail && <pre className='script-ai-error-text'>{errorInfo.detail}</pre>}
            </div>
          )}
          {aiAttachments.length > 0 && (
            <div className='script-ai-attachments'>
              {aiAttachments.map(item => (
                <div key={`${item.type}:${item.path}`} className='script-ai-attachment'>
                  <span className='script-ai-attachment-icon'>
                    {item.type === 'doc' ? <BookTextIcon size='0.75rem' /> : <CodeIcon size='0.75rem' />}
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
              Entry: {entryPath || 'Unknown'} | {fileCount} file{fileCount === 1 ? '' : 's'} | {scriptFormat}
            </div>
            <div className='script-ai-buttons'>
              <button className='script-ai-btn primary' type='button' disabled={!aiCanSend} onClick={sendAiRequest}>
                Send
              </button>
            </div>
          </div>
          {aiAccessIssue && <div className='script-ai-status error'>{aiAccessIssue}</div>}
          {aiLocked && (
            <div className='script-ai-status pending'>
              <LoaderPinwheelIcon size='0.9rem' className='script-ai-spinner' />
              {aiStatus?.message || 'Generating changes...'}
            </div>
          )}
          {aiStatus?.type === 'error' && !aiAccessIssue && (
            <div className='script-ai-status error'>{aiStatus.message}</div>
          )}
          {aiStatus?.type === 'success' && !aiAccessIssue && !aiLocked && (
            <div className='script-ai-status'>{aiStatus.message}</div>
          )}
          {handle?.dirtyCount && !aiLocked ? (
            <div className='script-ai-status'>Unsaved edits will be reverted when an AI request starts.</div>
          ) : null}
      </div>
    </div>
  )
}
