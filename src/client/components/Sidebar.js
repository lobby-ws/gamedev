import { css } from '@firebolt-dev/css'
import { MenuIcon, MicIcon, MicOffIcon, VRIcon } from './Icons'
import {
  DownloadIcon,
  EarthIcon,
  UsersIcon,
  InfoIcon,
  LayersIcon,
  ListTreeIcon,
  MessageSquareTextIcon,
  Move3DIcon,
  SquareMenuIcon,
  TagIcon,
  ShieldBanIcon,
} from 'lucide-react'
import { cls } from './cls'
import { useEffect, useState } from 'react'
import { HintProvider } from './Hint'
import { exportApp } from '../../core/extras/appTools'
import { downloadFile } from '../../core/extras/downloadFile'
import { storage } from '../../core/storage'
import { useRank } from './useRank'

import { Prefs } from './sidebar/Prefs'
import { World } from './sidebar/World'
import { Apps } from './sidebar/Apps'
import { Add } from './sidebar/Add'
import { App } from './sidebar/App'
import { Script } from './sidebar/Script'
import { Nodes } from './sidebar/Nodes'
import { Meta } from './sidebar/Meta'
import { Players } from './sidebar/Players'

const mainSectionPanes = ['prefs']
const worldSectionPanes = ['world', 'docs', 'apps', 'add']
const appSectionPanes = ['app', 'script', 'nodes', 'meta']

export function Sidebar({ world, ui }) {
  const player = world.entities.player
  const { isAdmin, isBuilder } = useRank(world, player)
  const [livePlayers, setLivePlayers] = useState(() => storage.get('admin-live', false))
  const [livekit, setLiveKit] = useState(() => world.livekit.status)
  useEffect(() => {
    const onLiveKitStatus = status => {
      setLiveKit({ ...status })
    }
    world.livekit.on('status', onLiveKitStatus)
    return () => {
      world.livekit.off('status', onLiveKitStatus)
    }
  }, [])
  useEffect(() => {
    if (!world.isAdminClient || !world.network?.setSubscriptions) return
    world.network.setSubscriptions({ snapshot: true, players: livePlayers, runtime: false })
    storage.set('admin-live', livePlayers)
  }, [livePlayers])
  const activePane = ui.active ? ui.pane : null
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
          left: calc(2rem + env(safe-area-inset-left));
          display: flex;
          gap: 0.625rem;
          justify-content: flex-start;
          overflow: hidden;
          .sidebar-left {
            align-self: flex-start;
            display: flex;
            flex-direction: column;
            gap: 0.625rem;
          }
          &.touch {
            font-size: 0.875rem;
            top: env(safe-area-inset-top);
            right: calc(0.75rem + env(safe-area-inset-right));
            bottom: env(safe-area-inset-bottom);
            left: calc(0.75rem + env(safe-area-inset-left));
            .sidebar-left {
              align-self: stretch;
              justify-content: flex-end;
            }
          }
        `}
      >
        <div className='sidebar-left'>
          <Section active={mainSectionPanes.includes(activePane) || activePane === 'players'} top>
            <Btn active={activePane === 'prefs'} onClick={() => world.ui.togglePane('prefs')}>
              <MenuIcon size='1.25rem' />
            </Btn>
            {isAdmin && (
              <Btn active={activePane === 'players'} onClick={() => world.ui.togglePane('players')}>
                <UsersIcon size='1.25rem' />
              </Btn>
            )}
            {livekit.enabled && (
              <Btn muted={livekit.muted} onClick={() => world.livekit.toggleMuted()}>
                {livekit.muted ? <MicOffIcon size='1.25rem' /> : <MicIcon size='1.25rem' />}
              </Btn>
            )}
            {world.xr.isSupported && (
              <Btn onClick={() => world.xr.start()}>
                <VRIcon size='1.5rem' />
              </Btn>
            )}
          </Section>
          {isBuilder && (
            <Section active={worldSectionPanes.includes(activePane)}>
              <Btn
                disabled={!isBuilder}
                active={activePane === 'world'}
                onClick={() => world.ui.togglePane('world')}
              >
                <EarthIcon size='1.25rem' />
              </Btn>
              <Btn disabled={!isBuilder} active={activePane === 'apps'} onClick={() => world.ui.togglePane('apps')}>
                <SquareMenuIcon size='1.25rem' />
              </Btn>
              <Btn
                disabled={!isBuilder}
                active={activePane === 'add'}
                suspended={ui.app?.blueprint.id === '$scene'}
                onClick={() => world.ui.togglePane('add')}
              >
                <LayersIcon size='1.25rem' />
              </Btn>
            </Section>
          )}
          {isBuilder && ui.app && (
            <Section active={appSectionPanes.includes(activePane)}>
              <Btn disabled={!isBuilder} active={activePane === 'app'} onClick={() => world.ui.togglePane('app')}>
                <TagIcon size='1.25rem' />
              </Btn>
              <Btn disabled={!isBuilder} active={activePane === 'script'} onClick={() => world.ui.togglePane('script')}>
                <MessageSquareTextIcon size='1.25rem' />
              </Btn>
              <Btn disabled={!isBuilder} active={activePane === 'nodes'} onClick={() => world.ui.togglePane('nodes')}>
                <ListTreeIcon size='1.25rem' />
              </Btn>
              <Btn disabled={!isBuilder} active={activePane === 'meta'} onClick={() => world.ui.togglePane('meta')}>
                <InfoIcon size='1.25rem' />
              </Btn>
            </Section>
          )}
          {isBuilder && ui.app && (
            <Section>
              <Btn onClick={() => world.builder.controlMode.set('translate')}>
                <Move3DIcon size='1.25rem' />
              </Btn>
              <Btn onClick={downloadApp}>
                <DownloadIcon size='1.25rem' />
              </Btn>
            </Section>
          )}
        </div>
        {ui.pane === 'prefs' && <Prefs world={world} hidden={!ui.active} />}
        {ui.pane === 'world' && <World world={world} hidden={!ui.active} />}
        {ui.pane === 'apps' && <Apps world={world} hidden={!ui.active} />}
        {ui.pane === 'add' && <Add world={world} hidden={!ui.active} />}
        {ui.pane === 'app' && <App key={ui.app.data.id} world={world} hidden={!ui.active} />}
        {ui.pane === 'script' && <Script key={ui.app.data.id} world={world} hidden={!ui.active} />}
        {ui.pane === 'nodes' && <Nodes key={ui.app.data.id} world={world} hidden={!ui.active} />}
        {ui.pane === 'meta' && <Meta key={ui.app.data.id} world={world} hidden={!ui.active} />}
        {ui.pane === 'players' && (
          <Players world={world} hidden={!ui.active} livePlayers={livePlayers} setLivePlayers={setLivePlayers} />
        )}
      </div>
    </HintProvider>
  )
}

function Section({ active, top, bottom, children }) {
  return (
    <div
      className={cls('sidebar-section', { active, top, bottom })}
      css={css`
        background: rgba(11, 10, 21, 0.2);
        border: 1px solid rgba(255, 255, 255, 0.05);
        border-radius: 2rem;
        padding: 0.6875rem 0;
        pointer-events: auto;
        position: relative;
        &.active {
          background: rgba(11, 10, 21, 0.9);
        }
      `}
    >
      {children}
    </div>
  )
}

function Btn({ disabled, suspended, active, muted, children, ...props }) {
  return (
    <div
      className={cls('sidebar-btn', { disabled, suspended, active, muted })}
      css={css`
        width: 2.75rem;
        height: 1.875rem;
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        position: relative;
        .sidebar-btn-dot {
          display: none;
          position: absolute;
          top: 0.8rem;
          right: 0.2rem;
          width: 0.3rem;
          height: 0.3rem;
          border-radius: 0.15rem;
          background: white;
        }
        &:hover {
          cursor: pointer;
          color: white;
        }
        &.active {
          color: white;
          .sidebar-btn-dot {
            display: block;
          }
        }
        &.suspended {
          .sidebar-btn-dot {
            display: block;
          }
        }
        &.disabled {
          color: rgba(255, 255, 255, 0.3);
        }
        &.muted {
          color: #ff4b4b;
        }
      `}
      {...props}
    >
      {children}
      <div className='sidebar-btn-dot' />
    </div>
  )
}
