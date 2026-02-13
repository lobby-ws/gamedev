import 'ses'
import '../core/lockdown'
import { getAddress } from 'ethers'
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

function createAuthError(message, status, { skipAuth = false } = {}) {
  const err = new Error(message)
  if (status) err.status = status
  if (skipAuth) err.skipAuth = true
  return err
}

function toHexString(value) {
  const bytes = new TextEncoder().encode(String(value))
  return `0x${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
}

function getWalletProvider() {
  if (typeof window === 'undefined') return null
  const provider = window.ethereum
  if (!provider || typeof provider.request !== 'function') return null
  return provider
}

function normalizeHexAddress(value) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return /^0x[a-fA-F0-9]{40}$/.test(normalized) ? normalized : ''
}

function normalizeSiweAddress(address) {
  const normalized = normalizeHexAddress(address)
  if (!normalized) return ''
  try {
    return getAddress(normalized)
  } catch {
    return normalized
  }
}

function buildSiweMessage({ domain, address, uri, chainId, nonce }) {
  return `${domain} wants you to sign in with your Ethereum account:
${address}

Sign in with Ethereum

URI: ${uri}
Version: 1
Chain ID: ${chainId}
Nonce: ${nonce}
Issued At: ${new Date().toISOString()}`
}

function getProviderChainId(provider) {
  return provider
    .request({ method: 'eth_chainId' })
    .then(chainId => {
      const parsed = Number.parseInt(chainId, 16)
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
    })
    .catch(() => 1)
}

async function requestWalletAddress(provider) {
  const getAccounts = await provider.request({ method: 'eth_accounts' }).catch(() => [])
  let address = normalizeHexAddress(Array.isArray(getAccounts) ? getAccounts[0] : '')
  if (!address) {
    try {
      const requestedAccounts = await provider.request({ method: 'eth_requestAccounts' })
      address = normalizeHexAddress(Array.isArray(requestedAccounts) ? requestedAccounts[0] : '')
    } catch (err) {
      if (err?.code === 4001) {
        throw createAuthError('Wallet sign-in request was rejected', 401, { skipAuth: true })
      }
      throw err
    }
  }
  if (!address) {
    throw createAuthError('No wallet account available', 401, { skipAuth: true })
  }
  return normalizeSiweAddress(address)
}

async function requestSiweNonce(authBaseUrl, address, { onStatus } = {}) {
  const endpoints = buildAuthEndpointCandidates(authBaseUrl, 'auth/nonce')
  for (const endpoint of endpoints) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ address }),
    })
    if (res.status === 404) {
      continue
    }
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: 'Unable to request SIWE nonce' }))
      throw createAuthError(error.message || error.error || 'Unable to request SIWE nonce', res.status)
    }
    const data = await res.json()
    const nonce = typeof data?.nonce === 'string' ? data.nonce.trim() : ''
    if (!nonce) {
      throw createAuthError('Missing SIWE nonce', 401)
    }
    onStatus?.('auth', 'Sign-in nonce received...')
    return nonce
  }
  throw createAuthError('Unable to request SIWE nonce', 404)
}

async function verifySiweMessage(authBaseUrl, message, signature, { onStatus } = {}) {
  const endpoints = buildAuthEndpointCandidates(authBaseUrl, 'auth/verify')
  for (const endpoint of endpoints) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ message, signature }),
      credentials: 'include',
    })
    if (res.status === 404) {
      continue
    }
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: 'Unable to verify SIWE signature' }))
      const statusError = createAuthError(
        error.message || error.error || 'Unable to verify SIWE signature',
        res.status
      )
      if (res.status === 401) statusError.skipAuth = true
      throw statusError
    }
    onStatus?.('auth', 'Wallet signature verified...')
    return
  }
  throw createAuthError('Unable to verify SIWE signature', 404)
}

async function signSiwePayload(provider, address, message, { onStatus } = {}) {
  const encodedMessage = toHexString(message)
  try {
    return await provider.request({ method: 'personal_sign', params: [encodedMessage, address] })
  } catch (firstError) {
    try {
      return await provider.request({ method: 'personal_sign', params: [message, address] })
    } catch {
      onStatus?.('error', firstError?.message || 'Wallet signature was rejected')
      throw createAuthError('Unable to sign SIWE payload', 401, { skipAuth: true })
    }
  }
}

async function fetchIdentityExchangeTokenWithSiwe(authBaseUrl, onStatus) {
  const provider = getWalletProvider()
  if (!provider) {
    onStatus?.('connecting', 'No wallet available - continuing as guest')
    throw createAuthError('No wallet provider found', 401, { skipAuth: true })
  }

  const address = await requestWalletAddress(provider)
  onStatus?.('auth', `Signing in as ${address.slice(0, 6)}...${address.slice(-4)}...`)

  const nonce = await requestSiweNonce(authBaseUrl, address, { onStatus })
  const chainId = await getProviderChainId(provider)
  const parsedUrl = new URL(authBaseUrl.replace(/\/+$/, ''))
  const message = buildSiweMessage({
    domain: parsedUrl.hostname,
    address,
    uri: `${parsedUrl.protocol}//${parsedUrl.host}`,
    chainId,
    nonce,
  })

  const signature = await signSiwePayload(provider, address, message, { onStatus })
  await verifySiweMessage(authBaseUrl, message, signature, { onStatus })
  onStatus?.('auth', 'Wallet login complete')
  return fetchIdentityExchangeToken(authBaseUrl)
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
      let identityToken
      try {
        identityToken = await fetchIdentityExchangeToken(authBaseUrl)
      } catch (err) {
        if (err?.status !== 401) throw err
        identityToken = await fetchIdentityExchangeTokenWithSiwe(authBaseUrl, onStatus).catch(err => {
          if (err?.skipAuth) return null
          throw err
        })
      }
      if (!identityToken) {
        onStatus?.('connecting', 'Continuing as guest...')
        return buildWsUrl(baseWsUrl)
      }
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
