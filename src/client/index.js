import 'ses'
import '../core/lockdown'
import { useCallback, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { Client } from './world-client'

function buildWsUrl(baseUrl, token) {
  try {
    const url = new URL(baseUrl)
    if (!url.pathname || url.pathname === '/') {
      url.pathname = '/ws'
    }
    if (token) {
      url.searchParams.set('authToken', token)
    }
    return url.toString()
  } catch {
    return baseUrl
  }
}

const MAX_WAIT_TIME = 60000 // 60 seconds

function normalizeMode(value, fallback) {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().toLowerCase()
  return normalized || fallback
}

function hasValue(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function resolveRuntimeApiUrl() {
  if (env.PUBLIC_API_URL) return env.PUBLIC_API_URL
  if (typeof window === 'undefined') return null
  return `${window.location.origin}/api`
}

function resolveStandaloneWsUrl(apiUrl) {
  if (env.PUBLIC_WS_URL) return env.PUBLIC_WS_URL
  if (apiUrl) {
    return apiUrl
      .replace(/\/api\/?$/, '/ws')
      .replace(/^http:/, 'ws:')
      .replace(/^https:/, 'wss:')
  }
  if (typeof window === 'undefined') return null
  return `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`
}

function resolveWorldSlug() {
  let worldSlug = env.PUBLIC_WORLD_SLUG
  if (!worldSlug && typeof window !== 'undefined') {
    const match = window.location.pathname.match(/^\/worlds\/([^/]+)/)
    if (match?.[1]) {
      worldSlug = decodeURIComponent(match[1])
    }
  }
  return worldSlug
}

function resolveAuthMode() {
  const explicit = normalizeMode(env.PUBLIC_AUTH_MODE, '')
  if (explicit === 'platform' || explicit === 'standalone') {
    return explicit
  }
  return hasValue(env.PUBLIC_WORLD_SLUG) ? 'platform' : 'standalone'
}

function buildAuthEndpointCandidates(authBaseUrl, pathSuffix) {
  const base = authBaseUrl.replace(/\/+$/, '')
  const suffix = pathSuffix.replace(/^\/+/, '')
  if (/\/api$/i.test(base)) {
    return [`${base}/${suffix}`]
  }
  return [`${base}/api/${suffix}`, `${base}/${suffix}`]
}

async function fetchIdentityExchangeToken(authBaseUrl) {
  const endpoints = buildAuthEndpointCandidates(authBaseUrl, 'auth/exchange')
  for (const endpoint of endpoints) {
    const res = await fetch(endpoint, {
      method: 'POST',
      credentials: 'include',
    })
    if (res.status === 404) {
      continue
    }
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: 'Unable to authenticate' }))
      const err = new Error(error.message || error.error || 'Unable to authenticate')
      err.status = res.status
      throw err
    }
    const data = await res.json()
    const token = typeof data?.token === 'string' ? data.token.trim() : ''
    if (!token) {
      throw new Error('Missing identity exchange token')
    }
    return token
  }
  throw new Error('Unable to authenticate')
}

async function exchangeForRuntimeSession(runtimeApiUrl, identityToken) {
  const res = await fetch(`${runtimeApiUrl.replace(/\/+$/, '')}/auth/exchange`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ token: identityToken }),
  })
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Unable to exchange token' }))
    throw new Error(error.message || error.error || 'Unable to exchange token')
  }
  const data = await res.json()
  const token = typeof data?.token === 'string' ? data.token.trim() : ''
  if (!token) {
    throw new Error('Missing runtime session token')
  }
  return token
}

// Fetch connection info from /join endpoint for platform worlds
async function getPlatformConnectionUrl(apiUrl, onStatus, startTime = Date.now()) {
  const worldSlug = resolveWorldSlug()
  if (!worldSlug) {
    throw new Error('World slug is required for platform mode')
  }

  const res = await fetch(`${apiUrl}/worlds/${worldSlug}/join`, {
    method: 'POST',
    credentials: 'include',
  })

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Failed to join world' }))
    throw new Error(error.message || error.error || 'Failed to join world')
  }

  const data = await res.json()

  if (data.status === 'provisioning' || data.status === 'starting') {
    if (Date.now() - startTime > MAX_WAIT_TIME) {
      onStatus?.('error', 'Cannot find server')
      throw new Error('Cannot find server - timed out waiting for server to start')
    }
    onStatus?.('waiting', data.message || 'Waiting for server...')
    await new Promise(r => setTimeout(r, 2000))
    return getPlatformConnectionUrl(apiUrl, onStatus, startTime)
  }

  onStatus?.('connecting', 'Connecting...')
  if (data.status !== 'ready') {
    throw new Error(`World not ready: ${data.message || data.status}`)
  }

  const { host, port, token, url, wsUrl } = data.connection || {}
  const baseUrl = wsUrl || url || `wss://${host}:${port}`
  return buildWsUrl(baseUrl, token)
}

async function getConnectionUrl(onStatus, startTime = Date.now()) {
  const apiUrl = resolveRuntimeApiUrl()
  const authMode = resolveAuthMode()
  const usesLobbyIdentity = authMode === 'standalone' && hasValue(env.PUBLIC_AUTH_URL)

  if (!apiUrl) {
    throw new Error('PUBLIC_API_URL is required')
  }

  if (authMode === 'platform') {
    return getPlatformConnectionUrl(apiUrl, onStatus, startTime)
  }

  const baseWsUrl = resolveStandaloneWsUrl(apiUrl)
  if (!baseWsUrl) {
    throw new Error('PUBLIC_WS_URL is required for standalone mode')
  }

  if (usesLobbyIdentity) {
    onStatus?.('auth', 'Authorizing...')
    try {
      const authBaseUrl = env.PUBLIC_AUTH_URL
      const identityToken = await fetchIdentityExchangeToken(authBaseUrl)
      const runtimeSessionToken = await exchangeForRuntimeSession(apiUrl, identityToken)
      return buildWsUrl(baseWsUrl, runtimeSessionToken)
    } catch (err) {
      // Allow unauthenticated users to continue as guests in standalone+lobby mode.
      if (err?.status === 401) {
        onStatus?.('connecting', 'Continuing as guest...')
        return buildWsUrl(baseWsUrl)
      }
      throw err
    }
  }

  return buildWsUrl(baseWsUrl)
}

function App() {
  const [connectionStatus, setConnectionStatus] = useState(null)

  const wsUrl = useCallback(() => {
    return getConnectionUrl((status, message) => {
      setConnectionStatus({ status, message })
    })
  }, [])

  return <Client
    wsUrl={wsUrl}
    connectionStatus={connectionStatus}
    apiUrl={env.PUBLIC_API_URL}
    authUrl={env.PUBLIC_AUTH_URL || null}
  />
}

const root = createRoot(document.getElementById('root'))
root.render(<App />)
