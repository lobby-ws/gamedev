import { css } from '@firebolt-dev/css'
import { useEffect, useState } from 'react'
import { HammerIcon } from 'lucide-react'
import { cls } from './cls'
import { theme } from './theme'
import { HintProvider } from './Hint'
import { exportApp } from '../../core/extras/appTools'
import { downloadFile } from '../../core/extras/downloadFile'
import { useRank } from './useRank'

import { World } from './sidebar/World'
import { Apps } from './sidebar/Apps'
import { Add } from './sidebar/Add'
import { App } from './sidebar/App'
import { Script } from './sidebar/Script'
import { Nodes } from './sidebar/Nodes'
import { Meta } from './sidebar/Meta'

export function Sidebar({ world, ui, onOpenMenu }) {
  const player = world.entities.player
  const { isBuilder } = useRank(world, player)
  const activePane = ui.active ? ui.pane : null
  const [open, setOpen] = useState(false)
  const downloadApp = async () => {
    const app = ui.app
    if (!app?.blueprint) return
    try {
      const file = await exportApp(app.blueprint, world.loader.loadFile, id => world.blueprints.get(id))
      downloadFile(file)
    } catch (err) {
      console.error(err)
      world.emit('toast', 'Export failed')
    }
  }
  useEffect(() => {
    if (ui.app && !open) setOpen(true)
  }, [ui.app])
  const selectPane = pane => {
    world.ui.togglePane(pane)
    if (!ui.active) setOpen(true)
  }
  return (
    <HintProvider>
      <div
        className='sidebar'
        css={css`
          position: absolute;
          font-size: 1rem;
          top: calc(2rem + env(safe-area-inset-top));
          right: calc(2rem + env(safe-area-inset-right));
          bottom: calc(2rem + env(safe-area-inset-bottom));
          left: calc(0.75rem + env(safe-area-inset-left));
          display: flex;
          gap: 0.625rem;
          justify-content: flex-start;
          overflow: hidden;
          .sidebar-topbar {
            position: absolute;
            top: 0;
            left: calc(0.75rem + env(safe-area-inset-left));
            display: flex;
            align-items: center;
            gap: 0.5rem;
            pointer-events: auto;
          }
          .sidebar-center {
            align-self: center;
            display: flex;
            gap: 0.625rem;
            &.open {
              height: 30%;
            }
          }
          .sidebar-nav {
            display: flex;
            flex-direction: column;
            gap: 1px;
            pointer-events: auto;
            background: transparent;
            border: 1px solid ${theme.border};
            border-radius: ${theme.radius};
            padding: 0.25rem;
          }
          .sidebar-nav-toggle {
            width: 2.25rem;
            height: 2.25rem;
            display: flex;
            align-items: center;
            justify-content: center;
            color: rgba(255, 255, 255, 0.6);
            border-radius: ${theme.radiusSmall};
            &:hover {
              cursor: pointer;
              color: white;
              background: ${theme.bgHover};
            }
          }
          .sidebar-nav-btn {
            padding: 0.375rem 0.75rem;
            font-size: 0.8125rem;
            color: rgba(255, 255, 255, 0.6);
            white-space: nowrap;
            border-radius: ${theme.radiusSmall};
            &:hover {
              cursor: pointer;
              color: white;
              background: ${theme.bgHover};
            }
            &.active {
              color: white;
              background: ${theme.bgHover};
            }
            &.suspended {
              color: rgba(255, 255, 255, 0.6);
              &::after {
                content: ' *';
              }
            }
          }
          .sidebar-nav-divider {
            height: 1px;
            background: ${theme.borderLight};
            margin: 0.25rem 0;
          }
          .sidebar-script {
            align-self: stretch;
            display: flex;
            pointer-events: auto;
          }
          &.touch {
            font-size: 0.875rem;
            top: env(safe-area-inset-top);
            right: calc(0.75rem + env(safe-area-inset-right));
            bottom: env(safe-area-inset-bottom);
            left: calc(0.75rem + env(safe-area-inset-left));
          }
        `}
      >
        <div className='sidebar-topbar'>
          <LogoBtn onClick={onOpenMenu} />
        </div>
        {isBuilder && (
          <div className={cls('sidebar-center', { open })}>
            <div className={cls('sidebar-nav', { open })}>
              <div className='sidebar-nav-toggle' onClick={() => setOpen(!open)}>
                <HammerIcon size='1.125rem' />
              </div>
              {open && (
                <>
                  <div className='sidebar-nav-divider' />
                  <div
                    className={cls('sidebar-nav-btn', { active: activePane === 'world' })}
                    onClick={() => selectPane('world')}
                  >
                    World
                  </div>
                  <div
                    className={cls('sidebar-nav-btn', { active: activePane === 'apps' })}
                    onClick={() => selectPane('apps')}
                  >
                    Objects
                  </div>
                  <div
                    className={cls('sidebar-nav-btn', {
                      active: activePane === 'add',
                      suspended: ui.app?.blueprint.id === '$scene',
                    })}
                    onClick={() => selectPane('add')}
                  >
                    Add
                  </div>
                  {ui.app && (
                    <>
                      <div className='sidebar-nav-divider' />
                      <div
                        className={cls('sidebar-nav-btn', { active: activePane === 'app' })}
                        onClick={() => selectPane('app')}
                      >
                        Object
                      </div>
                      <div
                        className={cls('sidebar-nav-btn', { active: activePane === 'script' })}
                        onClick={() => selectPane('script')}
                      >
                        Script
                      </div>
                      <div
                        className={cls('sidebar-nav-btn', { active: activePane === 'nodes' })}
                        onClick={() => selectPane('nodes')}
                      >
                        Nodes
                      </div>
                      <div
                        className={cls('sidebar-nav-btn', { active: activePane === 'meta' })}
                        onClick={() => selectPane('meta')}
                      >
                        Meta
                      </div>
                      <div className='sidebar-nav-divider' />
                      <div className='sidebar-nav-btn' onClick={downloadApp}>
                        Export
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
            {open && ui.pane === 'world' && <World world={world} hidden={!ui.active} />}
            {open && ui.pane === 'apps' && <Apps world={world} hidden={!ui.active} />}
            {open && ui.pane === 'add' && <Add world={world} hidden={!ui.active} />}
            {open && ui.pane === 'app' && <App key={ui.app.data.id} world={world} hidden={!ui.active} />}
            {open && ui.pane !== 'script' && ui.pane === 'nodes' && <Nodes key={ui.app.data.id} world={world} hidden={!ui.active} />}
            {open && ui.pane !== 'script' && ui.pane === 'meta' && <Meta key={ui.app.data.id} world={world} hidden={!ui.active} />}
          </div>
        )}
        {isBuilder && open && ui.pane === 'script' && (
          <div className='sidebar-script'>
            <Script key={ui.app.data.id} world={world} hidden={!ui.active} />
          </div>
        )}
      </div>
    </HintProvider>
  )
}

function LogoBtn({ onClick }) {
  return (
    <div
      className='sidebar-logo'
      css={css`
        width: 2.75rem;
        height: 2.75rem;
        display: flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: 1px solid ${theme.border};
        border-radius: ${theme.radius};
        cursor: pointer;
        &:hover {
          background: ${theme.bgHover};
        }
        img {
          width: 1.75rem;
          height: 1.75rem;
          object-fit: contain;
        }
      `}
      onClick={onClick}
    >
      <img src='/logo.png' />
    </div>
  )
}
