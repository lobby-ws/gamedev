import { cls } from '../cls'

export function ScriptCodePanel({
  moduleRoot,
  handle,
  aiLocked,
  showChrome,
  forceCollapsed,
  children,
}) {
  return (
    <>
      {showChrome && (
        <div className='script-head'>
          <div className='script-actions'>
            {moduleRoot && (
              <>
                <button
                  className='script-action'
                  type='button'
                  disabled={!handle?.dirty || handle?.saving || aiLocked}
                  onClick={() => handle?.save?.()}
                >
                  {handle?.saving ? 'Saving...' : 'Save'}
                </button>
                <button
                  className='script-action'
                  type='button'
                  disabled={handle?.saving || !handle?.refresh || aiLocked}
                  onClick={() => handle?.refresh?.()}
                >
                  Refresh
                </button>
                {handle?.conflict && (
                  <button
                    className='script-action'
                    type='button'
                    disabled={handle?.saving || aiLocked}
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
      )}
      {showChrome && moduleRoot && (handle?.error || handle?.conflict) && (
        <div className={cls('script-status', { error: handle?.error, conflict: handle?.conflict })}>
          {handle?.error || handle?.conflict}
        </div>
      )}
      <div className={cls('script-editor-shell', { collapsed: forceCollapsed })}>{children}</div>
    </>
  )
}
