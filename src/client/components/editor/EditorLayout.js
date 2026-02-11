import { css } from '@firebolt-dev/css'
import { useEffect, useState } from 'react'
import { editorTheme as theme } from './editorTheme'
import { EditorToolbar } from './EditorToolbar'
import { LeftPanel } from './LeftPanel'
import { RightPanel } from './RightPanel'
import { BottomPanel } from './BottomPanel'
import { HintProvider } from '../Hint'
import { useRank } from '../useRank'

export function EditorLayout({ world, ui, children }) {
  const [ready, setReady] = useState(false)
  const [player, setPlayer] = useState(() => world.entities.player)
  const { isBuilder } = useRank(world, player)
  const [open, setOpen] = useState(true)
  const hasApp = !!ui.app

  useEffect(() => {
    const onReady = () => {
      setReady(true)
      setPlayer(world.entities.player)
    }
    const onPlayer = p => setPlayer(p)
    world.on('ready', onReady)
    world.on('player', onPlayer)
    return () => {
      world.off('ready', onReady)
      world.off('player', onPlayer)
    }
  }, [])

  useEffect(() => {
    if (ui.app && !open) setOpen(true)
  }, [ui.app])

  const showEditor = ready && isBuilder && open
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
            {/* Toolbar - logo always visible when ready, hammer only for builders */}
            {ready && (
              <EditorToolbar
                world={world}
                open={open}
                onToggle={() => setOpen(!open)}
                isBuilder={isBuilder}
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
