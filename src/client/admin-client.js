import * as THREE from 'three'
import { useEffect, useMemo, useRef, useState } from 'react'
import { css } from '@firebolt-dev/css'

import { createAdminWorld } from '../core/createAdminWorld'
import { CoreUI } from './components/CoreUI'

export { System } from '../core/systems/System'

function resolveAdminUrl() {
  if (globalThis.env?.PUBLIC_ADMIN_URL) return globalThis.env.PUBLIC_ADMIN_URL
  if (window?.location?.origin) return window.location.origin
  if (globalThis.env?.PUBLIC_WS_URL) {
    const derived = globalThis.env.PUBLIC_WS_URL
      .replace(/^wss:/, 'https:')
      .replace(/^ws:/, 'http:')
      .replace(/\/ws\/?$/, '')
    if (derived) return derived
  }
  if (globalThis.env?.PUBLIC_API_URL) {
    return globalThis.env.PUBLIC_API_URL.replace(/\/api\/?$/, '')
  }
  return window.location.origin
}

export function AdminClient() {
  const viewportRef = useRef()
  const cssLayerRef = useRef()
  const uiRef = useRef()
  const world = useMemo(() => createAdminWorld(), [])
  const [ui, setUI] = useState(world.ui.state)
  const [authError, setAuthError] = useState(null)

  useEffect(() => {
    world.on('ui', setUI)
    return () => {
      world.off('ui', setUI)
    }
  }, [])

  useEffect(() => {
    const onAuth = state => {
      if (state?.ok) {
        setAuthError(null)
      } else if (state?.error) {
        setAuthError(state.error)
      }
    }
    world.on('admin-auth', onAuth)
    return () => {
      world.off('admin-auth', onAuth)
    }
  }, [])

  useEffect(() => {
    const init = async () => {
      const viewport = viewportRef.current
      const cssLayer = cssLayerRef.current
      const ui = uiRef.current
      const baseEnvironment = {
        model: '/base-environment.glb',
        bg: null,
        hdr: '/Clear_08_4pm_LDR.hdr',
        rotationY: 0,
        sunDirection: new THREE.Vector3(-1, -2, -2).normalize(),
        sunIntensity: 1,
        sunColor: 0xffffff,
        fogNear: null,
        fogFar: null,
        fogColor: null,
      }
      const adminUrl = resolveAdminUrl()
      world.init({ viewport, cssLayer, ui, adminUrl, baseEnvironment })
    }
    init()
  }, [])

  return (
    <div
      className='Admin'
      css={css`
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 100vh;
        height: 100dvh;
        .Admin__viewport {
          position: absolute;
          inset: 0;
          overflow: hidden;
        }
        .Admin__cssLayer {
          position: absolute;
          inset: 0;
          z-index: 0;
          pointer-events: none;
        }
        .Admin__ui {
          position: absolute;
          inset: 0;
          z-index: 2;
          pointer-events: none;
          user-select: none;
          display: ${ui.visible ? 'block' : 'none'};
        }
      `}
    >
      <div className='Admin__viewport' ref={viewportRef}>
        <div className='Admin__cssLayer' ref={cssLayerRef} />
        <div className='Admin__ui' ref={uiRef}>
          <CoreUI world={world} />
          {authError && <AdminAuthOverlay world={world} error={authError} />}
        </div>
      </div>
    </div>
  )
}

const authMessages = {
  invalid_code: 'Invalid admin code.',
  unauthorized: 'Admin code required.',
  auth_error: 'Admin authentication failed.',
  connection_error: 'Admin connection failed.',
}

function AdminAuthOverlay({ world, error }) {
  const [code, setCode] = useState(world.admin?.code || '')
  const message = authMessages[error] || 'Admin authentication required.'

  const submit = () => {
    const value = code.trim()
    if (!value) return
    world.admin?.setCode?.(value)
    world.adminNetwork?.setCode?.(value)
  }

  return (
    <div
      className='admin-auth'
      css={css`
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: auto;
        background: rgba(8, 8, 12, 0.7);
        backdrop-filter: blur(6px);
        .admin-auth-card {
          width: min(24rem, 90vw);
          background: rgba(14, 14, 20, 0.95);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 1.2rem;
          padding: 1.5rem;
          box-shadow: 0 1rem 3rem rgba(0, 0, 0, 0.35);
        }
        .admin-auth-title {
          font-size: 1.1rem;
          margin-bottom: 0.5rem;
        }
        .admin-auth-msg {
          font-size: 0.95rem;
          opacity: 0.7;
          margin-bottom: 1rem;
        }
        .admin-auth-input {
          width: 100%;
          border-radius: 0.75rem;
          border: 1px solid rgba(255, 255, 255, 0.1);
          background: rgba(0, 0, 0, 0.3);
          color: #fff;
          padding: 0.7rem 0.9rem;
          font-size: 0.95rem;
        }
        .admin-auth-actions {
          margin-top: 1rem;
          display: flex;
          justify-content: flex-end;
        }
        .admin-auth-btn {
          padding: 0.6rem 1.2rem;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.15);
          background: #ffffff;
          color: #0b0b10;
          font-weight: 600;
          cursor: pointer;
        }
      `}
    >
      <div className='admin-auth-card'>
        <div className='admin-auth-title'>Admin Access</div>
        <div className='admin-auth-msg'>{message}</div>
        <input
          className='admin-auth-input'
          type='password'
          placeholder='Enter admin code'
          value={code}
          onChange={e => setCode(e.target.value)}
          onKeyDown={e => {
            if (e.code === 'Enter' || e.key === 'Enter') {
              submit()
            }
          }}
        />
        <div className='admin-auth-actions'>
          <button className='admin-auth-btn' onClick={submit}>
            Connect
          </button>
        </div>
      </div>
    </div>
  )
}
