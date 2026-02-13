// import 'ses'
// import '../core/lockdown'
import * as THREE from 'three'
import { useEffect, useMemo, useRef, useState } from 'react'
import { css } from '@firebolt-dev/css'

import { createClientWorld } from '../core/createClientWorld'
import { CoreUI } from './components/CoreUI'
import { assetPath } from './utils'

export { System } from '../core/systems/System'

export function Client({ wsUrl, apiUrl, authUrl, connectionStatus, onSetup }) {
  const viewportRef = useRef()
  const cssLayerRef = useRef()
  const uiRef = useRef()
  const world = useMemo(() => createClientWorld(), [])
  const [ui, setUI] = useState(world.ui.state)
  const [resolvedWsUrl, setResolvedWsUrl] = useState(null)
  const [apiBaseUrl, setApiBaseUrl] = useState(null)
  const [authBaseUrl, setAuthBaseUrl] = useState(null)
  const [entered] = useState(true)
  useEffect(() => {
    world.on('ui', setUI)
    return () => {
      world.off('ui', setUI)
    }
  }, [])
  useEffect(() => {
    let cancelled = false
    const resolve = async () => {
      try {
        let finalWsUrl = wsUrl
        if (typeof finalWsUrl === 'function') {
          finalWsUrl = finalWsUrl()
          if (finalWsUrl instanceof Promise) finalWsUrl = await finalWsUrl
        }
        if (cancelled) return
        setResolvedWsUrl(finalWsUrl)
        const derivedHttpUrl = finalWsUrl.replace(/^ws/, 'http').replace(/\/ws.*$/, '')
        setApiBaseUrl(apiUrl || derivedHttpUrl)
        const cleanedAuthUrl = typeof authUrl === 'string' ? authUrl.trim() : authUrl
        setAuthBaseUrl(cleanedAuthUrl)
      } catch (err) {
        console.error('Failed to resolve connection:', err)
      }
    }
    resolve()
    return () => {
      cancelled = true
    }
  }, [wsUrl, apiUrl, authUrl])

  useEffect(() => {
    if (!entered) return
    if (!resolvedWsUrl) return
    const init = async () => {
      const viewport = viewportRef.current
      const cssLayer = cssLayerRef.current
      const ui = uiRef.current
      const baseEnvironment = {
        model: assetPath('/base-environment.glb'),
        bg: null, // '/day2-2k.jpg',
        hdr: assetPath('/Clear_08_4pm_LDR.hdr'),
        rotationY: 0,
        sunDirection: new THREE.Vector3(-1, -2, -2).normalize(),
        sunIntensity: 1,
        sunColor: 0xffffff,
        fogNear: null,
        fogFar: null,
        fogColor: null,
      }
      const config = { viewport, cssLayer, ui, wsUrl: resolvedWsUrl, baseEnvironment, apiUrl: apiBaseUrl, authUrl: authBaseUrl }
      onSetup?.(world, config)
      world.init(config)
    }
    init()
  }, [entered, resolvedWsUrl, apiBaseUrl, authBaseUrl])
  return (
    <div
      className='App'
      css={css`
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 100vh;
        height: 100dvh;
        .App__viewport {
          position: absolute;
          inset: 0;
          overflow: hidden;
        }
        .App__cssLayer {
          position: absolute;
          inset: 0;
          z-index: 0;
          pointer-events: none;
        }
        .App__ui {
          position: absolute;
          inset: 0;
          z-index: 2;
          pointer-events: none;
          user-select: none;
          display: ${ui.visible ? 'block' : 'none'};
        }
      `}
    >
      <div className='App__viewport' ref={viewportRef}>
        <div className='App__cssLayer' ref={cssLayerRef} />
        <div className='App__ui' ref={uiRef}>
          <CoreUI world={world} connectionStatus={connectionStatus} />
        </div>
      </div>
    </div>
  )
}
