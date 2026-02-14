import { css } from '@firebolt-dev/css'
import { useContext, useEffect, useState } from 'react'
import { editorTheme as theme } from './editorTheme'
import { EditorToolbar } from './EditorToolbar'
import { LeftPanel } from './LeftPanel'
import { RightPanel } from './RightPanel'
import { BottomPanel } from './BottomPanel'
import { HintContext, HintProvider } from '../Hint'
import { useRank } from '../useRank'

export function EditorLayout({ world, ui, children }) {
  const [ready, setReady] = useState(false)
  const [player, setPlayer] = useState(() => world.entities.player)
  const { isBuilder } = useRank(world, player)
  const [open, setOpen] = useState(true)
  const [buildMode, setBuildMode] = useState(false)
  const hasApp = !!ui.app

  useEffect(() => {
    const onReady = () => {
      setReady(true)
      setPlayer(world.entities.player)
    }
    const onPlayer = p => setPlayer(p)
    const onBuildMode = enabled => {
      setBuildMode(enabled)
      if (enabled) {
        setOpen(true)
      } else {
        setOpen(false)
        world.ui.setApp(null)
      }
    }
    world.on('ready', onReady)
    world.on('player', onPlayer)
    world.on('build-mode', onBuildMode)
    return () => {
      world.off('ready', onReady)
      world.off('player', onPlayer)
      world.off('build-mode', onBuildMode)
    }
  }, [])

  useEffect(() => {
    if (ui.app && !open) setOpen(true)
  }, [ui.app])

  const showEditor = ready && isBuilder && open && buildMode
  const showRight = showEditor && hasApp
  const showBottom = showEditor && hasApp

  return (
    <HintProvider>
      <div
        className='editor-layout'
        css={css`
          position: absolute;
          inset: 0;
          display: flex;
          overflow: hidden;
        `}
      >
        {/* Left panel */}
        {showEditor && <LeftPanel world={world} />}

        {/* Center column: viewport + bottom panel */}
        <div
          className='editor-center'
          css={css`
            flex: 1;
            display: flex;
            flex-direction: column;
            min-width: 0;
            min-height: 0;
            position: relative;
          `}
        >
          {/* Viewport area - children (the 3D viewport divs) go here */}
          <div
            className='editor-viewport'
            css={css`
              flex: 1;
              position: relative;
              min-height: 0;
              overflow: hidden;
            `}
          >
            {children}
            <EditorHint />
            {/* Toolbar - logo always visible when ready, hammer only for builders */}
            {ready && (
              <EditorToolbar
                world={world}
                open={open}
                onToggle={() => setOpen(!open)}
                isBuilder={isBuilder}
                buildMode={buildMode}
              />
            )}
          </div>

          {/* Bottom panel */}
          {showBottom && <BottomPanel world={world} />}
        </div>

        {/* Right panel */}
        {showRight && <RightPanel world={world} />}
      </div>
    </HintProvider>
  )
}

function EditorHint() {
  const { hint } = useContext(HintContext)
  if (!hint) return null
  return (
    <div
      css={css`
        position: absolute;
        bottom: 0.5rem;
        left: 50%;
        transform: translateX(-50%);
        width: 50%;
        max-height: 70%;
        overflow: auto;
        z-index: 5;
        pointer-events: none;
        background: ${theme.bgPanel};
        border: 1px solid ${theme.border};
        backdrop-filter: blur(5px);
        border-radius: ${theme.radius};
        padding: 0.625rem 0.75rem;
        font-size: 0.8125rem;
      `}
    >
      <span>{hint}</span>
    </div>
  )
}
