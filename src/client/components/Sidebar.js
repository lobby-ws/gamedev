import { css } from '@firebolt-dev/css'
import { useEffect, useState } from 'react'
import { HammerIcon } from 'lucide-react'
import { cls } from './cls'
import { theme } from './theme'
import { HintProvider } from './Hint'
import { exportApp } from '../../core/extras/appTools'
import { assetPath, isTouch } from '../utils'
import { downloadFile } from '../../core/extras/downloadFile'
import { useRank } from './useRank'
import { MouseLeftIcon } from './MouseLeftIcon'
import { MouseRightIcon } from './MouseRightIcon'
import { MouseWheelIcon } from './MouseWheelIcon'
import { buttons, propToLabel } from '../../core/extras/buttons'
import { World } from './sidebar/World'
import { Apps } from './sidebar/Apps'
import { Add } from './sidebar/Add'
import { App } from './sidebar/App'
import { Script } from './sidebar/Script'
import { Nodes } from './sidebar/Nodes'
import { Meta } from './sidebar/Meta'

export function Sidebar({ world, ui, onOpenMenu, walletAuth, onConnectWallet }) {
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
            position: relative;
            align-self: center;
            display: flex;
            gap: 0.625rem;
            &.open {
              height: 35%;
            }
          }
          .sidebar-actions {
            position: absolute;
            left: 0;
            bottom: calc(100% + 0.75rem);
            transform: scale(0.5);
            transform-origin: bottom left;
            pointer-events: none;
            @media all and (max-width: 1200px) {
              bottom: calc(100% + 0.5rem);
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
          <WalletBtn auth={walletAuth} onClick={onConnectWallet} />
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
            {open && ui.pane !== 'script' && ui.pane === 'nodes' && (
              <Nodes key={ui.app.data.id} world={world} hidden={!ui.active} />
            )}
            {open && ui.pane !== 'script' && ui.pane === 'meta' && (
              <Meta key={ui.app.data.id} world={world} hidden={!ui.active} />
            )}
            <ActionsPanel world={world} />
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

function ActionsPanel({ world }) {
  const [showActions, setShowActions] = useState(() => world.prefs.actions)
  useEffect(() => {
    const onPrefsChange = changes => {
      if (changes.actions) setShowActions(changes.actions.value)
    }
    world.prefs.on('change', onPrefsChange)
    return () => {
      world.prefs.off('change', onPrefsChange)
    }
  }, [])
  if (isTouch) return null
  if (!showActions) return null
  return (
    <div className='sidebar-actions'>
      <Actions world={world} />
    </div>
  )
}

function Actions({ world }) {
  const [actions, setActions] = useState(() => world.controls.actions)
  useEffect(() => {
    world.on('actions', setActions)
    return () => world.off('actions', setActions)
  }, [])
  return (
    <div
      className='actions'
      css={css`
        display: flex;
        flex-direction: column;
        justify-content: center;
        .actions-item {
          display: flex;
          align-items: flex-start;
          margin: 0 0 0.5rem;
          &-icon {
            flex: 0 0 auto;
            width: 2.25em;
            display: flex;
            justify-content: center;
            align-items: center;
          }
          &-label {
            margin-left: 0.5em;
            line-height: 1.2;
            white-space: normal;
            max-width: 12em;
            paint-order: stroke fill;
            -webkit-text-stroke: 0.25rem rgba(0, 0, 0, 0.2);
          }
        }
      `}
    >
      {actions.map(action => (
        <div className='actions-item' key={action.id}>
          <div className='actions-item-icon'>{getActionIcon(action)}</div>
          <div className='actions-item-label'>{action.label}</div>
        </div>
      ))}
    </div>
  )
}

function getActionIcon(action) {
  if (action.type === 'custom') {
    return <ActionPill label={action.btn} />
  }
  if (action.type === 'controlLeft') {
    return <ActionPill label='Ctrl' />
  }
  if (action.type === 'mouseLeft') {
    return <ActionIcon icon={MouseLeftIcon} />
  }
  if (action.type === 'mouseRight') {
    return <ActionIcon icon={MouseRightIcon} />
  }
  if (action.type === 'mouseWheel') {
    return <ActionIcon icon={MouseWheelIcon} />
  }
  if (buttons.has(action.type)) {
    return <ActionPill label={propToLabel[action.type]} />
  }
  return <ActionPill label='?' />
}

function ActionPill({ label }) {
  return (
    <div
      className='actionpill'
      css={css`
        border: 0.0625rem solid white;
        border-radius: 0.25rem;
        background: rgba(0, 0, 0, 0.1);
        padding: 0.125rem 0.3125rem;
        font-size: 0.75em;
        line-height: 1;
        height: 1.25em;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
        paint-order: stroke fill;
        -webkit-text-stroke: 0.25rem rgba(0, 0, 0, 0.2);
      `}
    >
      {label}
    </div>
  )
}

function ActionIcon({ icon: Icon }) {
  return (
    <div
      className='actionicon'
      css={css`
        line-height: 0;
        svg {
          filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.8));
        }
      `}
    >
      <Icon size='1.5rem' />
    </div>
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
      <img src={assetPath('/logo.png')} />
    </div>
  )
}

function formatWalletAddress(address) {
  if (!address) return ''
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function WalletBtn({ auth, onClick }) {
  if (!auth?.enabled) return null
  const providerMissing = !auth.providerAvailable
  const disabled = auth.pending || auth.connected || providerMissing
  const label = auth.pending
    ? 'Connecting...'
    : auth.connected
      ? formatWalletAddress(auth.address)
      : providerMissing
        ? 'No Wallet'
        : 'Connect Wallet'
  return (
    <div
      className={cls('sidebar-wallet', { disabled })}
      css={css`
        min-width: 7.5rem;
        height: 2.75rem;
        padding: 0 0.75rem;
        display: flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: 1px solid ${theme.border};
        border-radius: ${theme.radius};
        color: rgba(255, 255, 255, 0.9);
        font-size: 0.75rem;
        font-weight: 600;
        letter-spacing: 0.01em;
        cursor: pointer;
        user-select: none;
        &:hover {
          background: ${theme.bgHover};
        }
        &.disabled {
          cursor: default;
          color: rgba(255, 255, 255, 0.55);
          background: transparent;
        }
      `}
      onClick={() => {
        if (disabled) return
        onClick?.()
      }}
    >
      {label}
    </div>
  )
}
