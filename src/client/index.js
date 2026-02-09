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

// Fetch connection info from /join endpoint for direct GameServer connection
async function getConnectionUrl(onStatus, startTime = Date.now()) {
  const apiUrl = env.PUBLIC_API_URL
  let worldSlug = env.PUBLIC_WORLD_SLUG
  if (!worldSlug && typeof window !== 'undefined') {
    const match = window.location.pathname.match(/^\/worlds\/([^/]+)/)
    if (match?.[1]) {
      worldSlug = decodeURIComponent(match[1])
    }
  }
  
  // If we have a direct WS URL (legacy/self-hosted), use it
  if (env.PUBLIC_WS_URL && !worldSlug) {
    return buildWsUrl(env.PUBLIC_WS_URL)
  }
  
  // Call /join to provision GameServer and get connection info
  const res = await fetch(`${apiUrl}/worlds/${worldSlug}/join`, {
    method: 'POST',
    credentials: 'include',
  })
  
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Failed to join world' }))
    throw new Error(error.message || error.error || 'Failed to join world')
  }
  
  const data = await res.json()
  
  // If provisioning, poll until ready (with timeout)
  if (data.status === 'provisioning' || data.status === 'starting') {
    if (Date.now() - startTime > MAX_WAIT_TIME) {
      onStatus?.('error', 'Cannot find server')
      throw new Error('Cannot find server - timed out waiting for server to start')
    }
    onStatus?.('waiting', data.message || 'Waiting for server...')
    await new Promise(r => setTimeout(r, 2000))
    return getConnectionUrl(onStatus, startTime) // Retry with callback and start time
  }

  onStatus?.('connecting', 'Connecting...')
  
  if (data.status !== 'ready') {
    throw new Error(`World not ready: ${data.message || data.status}`)
  }
  
  // Return WebSocket URL with auth token
  const { host, port, token, url, wsUrl } = data.connection || {}
  const baseUrl = wsUrl || url || `wss://${host}:${port}`
  return buildWsUrl(baseUrl, token)
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
    authUrl={env.PUBLIC_AUTH_URL}
  />
}

const root = createRoot(document.getElementById('root'))
root.render(<App />)
