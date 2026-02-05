import { css } from '@firebolt-dev/css'
import {
  DownloadIcon,
  EarthIcon,
  InfoIcon,
  LayersIcon,
  ListTreeIcon,
  MessageSquareTextIcon,
  Move3DIcon,
  SquareMenuIcon,
  TagIcon,
} from 'lucide-react'
import { cls } from './cls'
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

const worldSectionPanes = ['world', 'docs', 'apps', 'add']
const appSectionPanes = ['app', 'script', 'nodes', 'meta']

export function Sidebar({ world, ui, onOpenMenu }) {
  const player = world.entities.player
  const { isBuilder } = useRank(world, player)
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
          .sidebar-topbar {
            position: absolute;
            top: 0;
            left: 0;
            display: flex;
            align-items: center;
            gap: 0.5rem;
            pointer-events: auto;
          }
          .sidebar-left {
            align-self: flex-start;
            display: flex;
            flex-direction: column;
            gap: 0.625rem;
            margin-top: 3.5rem;
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
        <div className='sidebar-topbar'>
          <LogoBtn onClick={onOpenMenu} />
        </div>
        <div className='sidebar-left'>
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
        {ui.pane === 'world' && <World world={world} hidden={!ui.active} />}
        {ui.pane === 'apps' && <Apps world={world} hidden={!ui.active} />}
        {ui.pane === 'add' && <Add world={world} hidden={!ui.active} />}
        {ui.pane === 'app' && <App key={ui.app.data.id} world={world} hidden={!ui.active} />}
        {ui.pane === 'script' && <Script key={ui.app.data.id} world={world} hidden={!ui.active} />}
        {ui.pane === 'nodes' && <Nodes key={ui.app.data.id} world={world} hidden={!ui.active} />}
        {ui.pane === 'meta' && <Meta key={ui.app.data.id} world={world} hidden={!ui.active} />}
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
        background: rgba(11, 10, 21, 0.2);
        border: 1px solid rgba(255, 255, 255, 0.05);
        border-radius: 50%;
        cursor: pointer;
        &:hover {
          background: rgba(11, 10, 21, 0.9);
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
