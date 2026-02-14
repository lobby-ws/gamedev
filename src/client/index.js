import 'ses'
import '../core/lockdown'
import { getAddress } from 'ethers'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  PrivyProvider,
  getEmbeddedConnectedWallet,
  useCreateWallet,
  usePrivy,
  useWallets,
} from '@privy-io/react-auth'

import { storage } from '../core/storage'
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

function resolveAuthEndpoint(authBaseUrl, pathSuffix) {
  const base = authBaseUrl.replace(/\/+$/, '')
  const suffix = pathSuffix.replace(/^\/+/, '')
  return `${base}/${suffix}`
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
  const endpoint = resolveAuthEndpoint(authBaseUrl, 'auth/nonce')
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ address }),
  })
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

async function verifySiweMessage(authBaseUrl, message, signature, { onStatus } = {}) {
  const endpoint = resolveAuthEndpoint(authBaseUrl, 'auth/verify')
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ message, signature }),
    credentials: 'include',
  })
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

async function performSiweLoginWithProvider(provider, authBaseUrl, onStatus) {
  if (!provider || typeof provider.request !== 'function') {
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
}

async function fetchIdentityExchangeToken(authBaseUrl) {
  const endpoint = resolveAuthEndpoint(authBaseUrl, 'auth/exchange')
  const res = await fetch(endpoint, {
    method: 'POST',
    credentials: 'include',
  })
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

async function fetchAuthMe(authBaseUrl) {
  const endpoint = resolveAuthEndpoint(authBaseUrl, 'auth/me')
  const res = await fetch(endpoint, {
    method: 'GET',
    credentials: 'include',
  })
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Unable to fetch session' }))
    throw createAuthError(error.message || error.error || 'Unable to fetch session', res.status)
  }
  return res.json()
}

async function logoutAuthSession(authBaseUrl) {
  const endpoint = resolveAuthEndpoint(authBaseUrl, 'auth/logout')
  const res = await fetch(endpoint, {
    method: 'POST',
    credentials: 'include',
  })
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Unable to logout' }))
    throw createAuthError(error.message || error.error || 'Unable to logout', res.status)
  }
  return true
}

function clearRuntimeAuthState() {
  storage.remove('authToken')
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

async function getConnectionUrl(onStatus) {
  const apiUrl = resolveRuntimeApiUrl()
  const usesLobbyIdentity = hasValue(env.PUBLIC_AUTH_URL)

  if (!apiUrl) {
    throw new Error('PUBLIC_API_URL is required')
  }

  const baseWsUrl = resolveStandaloneWsUrl(apiUrl)
  if (!baseWsUrl) {
    throw new Error('PUBLIC_WS_URL is required for runtime connection')
  }

  if (usesLobbyIdentity) {
    const authBaseUrl = env.PUBLIC_AUTH_URL
    onStatus?.('auth', 'Authorizing...')
    try {
      await fetchAuthMe(authBaseUrl)
    } catch (err) {
      if (err?.status === 401) {
        onStatus?.('connecting', 'Continuing as guest...')
        return buildWsUrl(baseWsUrl)
      }
      throw err
    }

    const identityToken = await fetchIdentityExchangeToken(authBaseUrl)
    const runtimeSessionToken = await exchangeForRuntimeSession(apiUrl, identityToken)
    return buildWsUrl(baseWsUrl, runtimeSessionToken)
  }

  return buildWsUrl(baseWsUrl)
}

function createInjectedRuntimeAuthBridge(authBaseUrl) {
  return {
    enabled: !!authBaseUrl,
    mode: 'injected',
    hasWalletProvider() {
      return !!getWalletProvider()
    },
    getWalletProvider,
    normalizeSiweAddress,
    async connectWalletSession({ onStatus } = {}) {
      if (!authBaseUrl) {
        throw createAuthError('Wallet auth is unavailable', 404, { skipAuth: true })
      }
      const provider = getWalletProvider()
      if (!provider) {
        throw createAuthError('No wallet provider found', 401, { skipAuth: true })
      }
      await performSiweLoginWithProvider(provider, authBaseUrl, onStatus)
      return fetchAuthMe(authBaseUrl).catch(() => null)
    },
    async getSessionUser() {
      if (!authBaseUrl) return null
      return fetchAuthMe(authBaseUrl).catch(() => null)
    },
    async logoutAndClearSession() {
      if (authBaseUrl) {
        await logoutAuthSession(authBaseUrl).catch(() => {})
      }
      clearRuntimeAuthState()
    },
    clearRuntimeAuthState,
    async getActiveWalletAddress() {
      const provider = getWalletProvider()
      if (!provider || typeof provider.request !== 'function') return ''
      const accounts = await provider.request({ method: 'eth_accounts' }).catch(() => [])
      return normalizeSiweAddress(Array.isArray(accounts) ? accounts[0] : '')
    },
    subscribeAccountChanges(listener) {
      const provider = getWalletProvider()
      if (!provider || typeof provider.on !== 'function' || typeof listener !== 'function') {
        return () => {}
      }
      const onAccountsChanged = accounts => {
        const nextAddress = normalizeSiweAddress(Array.isArray(accounts) ? accounts[0] : '')
        listener(nextAddress)
      }
      provider.on('accountsChanged', onAccountsChanged)
      return () => {
        provider.removeListener?.('accountsChanged', onAccountsChanged)
      }
    },
  }
}

const PRIVY_WALLET_WAIT_MS = 7000

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function createPrivyBridgeState(authBaseUrl) {
  return {
    authBaseUrl,
    ready: false,
    authenticated: false,
    login: null,
    logout: null,
    createWallet: null,
    walletsRef: null,
    embeddedAddress: '',
    listeners: new Set(),
  }
}

async function waitForPrivyEmbeddedWallet(state, timeoutMs = PRIVY_WALLET_WAIT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const wallet = getEmbeddedConnectedWallet(state.walletsRef?.current || [])
    if (wallet) return wallet
    await sleep(150)
  }
  return null
}

function notifyPrivyAddressChange(state, address) {
  for (const listener of state.listeners) {
    try {
      listener(address)
    } catch {
      // ignore listener errors
    }
  }
}

function createPrivyRuntimeAuthBridge(state) {
  return {
    enabled: !!state.authBaseUrl,
    mode: 'privy',
    hasWalletProvider() {
      return !!state.ready
    },
    getWalletProvider() {
      return null
    },
    normalizeSiweAddress,
    async connectWalletSession({ onStatus } = {}) {
      if (!state.authBaseUrl) {
        throw createAuthError('Wallet auth is unavailable', 404, { skipAuth: true })
      }
      if (!state.ready) {
        throw createAuthError('Privy is still loading', 503, { skipAuth: true })
      }
      if (!state.authenticated) {
        onStatus?.('auth', 'Opening wallet login...')
        try {
          await state.login?.()
        } catch (err) {
          throw createAuthError(err?.message || 'Wallet login was rejected', 401, { skipAuth: true })
        }
        const authDeadline = Date.now() + PRIVY_WALLET_WAIT_MS
        while (!state.authenticated && Date.now() < authDeadline) {
          await sleep(100)
        }
      }
      if (!state.authenticated) {
        throw createAuthError('Wallet login did not complete', 401, { skipAuth: true })
      }

      let wallet = getEmbeddedConnectedWallet(state.walletsRef?.current || [])
      if (!wallet) {
        onStatus?.('auth', 'Creating embedded wallet...')
        try {
          const created = await state.createWallet?.()
          if (created) wallet = created
        } catch (err) {
          throw createAuthError(err?.message || 'Unable to create embedded wallet', 500)
        }
      }
      if (!wallet) {
        wallet = await waitForPrivyEmbeddedWallet(state)
      }
      if (!wallet) {
        throw createAuthError('No embedded wallet available', 401, { skipAuth: true })
      }

      const provider = await wallet.getEthereumProvider?.().catch(() => null)
      if (!provider || typeof provider.request !== 'function') {
        throw createAuthError('Privy wallet provider unavailable', 401, { skipAuth: true })
      }

      await performSiweLoginWithProvider(provider, state.authBaseUrl, onStatus)
      return fetchAuthMe(state.authBaseUrl).catch(() => null)
    },
    async getSessionUser() {
      if (!state.authBaseUrl) return null
      return fetchAuthMe(state.authBaseUrl).catch(() => null)
    },
    async logoutAndClearSession() {
      if (state.authBaseUrl) {
        await logoutAuthSession(state.authBaseUrl).catch(() => {})
      }
      clearRuntimeAuthState()
      await state.logout?.().catch(() => {})
    },
    clearRuntimeAuthState,
    async getActiveWalletAddress() {
      return normalizeSiweAddress(state.embeddedAddress || '')
    },
    subscribeAccountChanges(listener) {
      if (typeof listener !== 'function') return () => {}
      state.listeners.add(listener)
      return () => {
        state.listeners.delete(listener)
      }
    },
  }
}

function PrivyRuntimeAuthSync({ state, children }) {
  const { ready, authenticated, login, logout } = usePrivy()
  const { wallets } = useWallets()
  const { createWallet } = useCreateWallet()
  const walletsRef = useRef(wallets)
  walletsRef.current = wallets

  const embeddedAddress = useMemo(() => {
    const wallet = getEmbeddedConnectedWallet(wallets)
    return normalizeSiweAddress(wallet?.address || '')
  }, [wallets])

  useEffect(() => {
    state.ready = ready
    state.authenticated = authenticated
    state.login = login
    state.logout = logout
    state.createWallet = createWallet
    state.walletsRef = walletsRef
  }, [state, ready, authenticated, login, logout, createWallet])

  useEffect(() => {
    if (state.embeddedAddress === embeddedAddress) return
    state.embeddedAddress = embeddedAddress
    notifyPrivyAddressChange(state, embeddedAddress)
  }, [state, embeddedAddress])

  return children
}

const authBaseUrl = hasValue(env.PUBLIC_AUTH_URL) ? env.PUBLIC_AUTH_URL : null
const privyAppId = hasValue(env.PUBLIC_PRIVY_APP_ID) ? env.PUBLIC_PRIVY_APP_ID : ''
const privyBridgeState = privyAppId ? createPrivyBridgeState(authBaseUrl) : null
if (typeof globalThis !== 'undefined') {
  globalThis.__runtimeAuth = privyBridgeState
    ? createPrivyRuntimeAuthBridge(privyBridgeState)
    : createInjectedRuntimeAuthBridge(authBaseUrl)
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

function RootApp() {
  if (!privyAppId || !privyBridgeState) {
    return <App />
  }
  return (
    <PrivyProvider
      appId={privyAppId}
      config={{
        appearance: {
          walletChainType: 'ethereum-only',
        },
        embeddedWallets: {
          ethereum: { createOnLogin: 'users-without-wallets' },
        },
      }}
    >
      <PrivyRuntimeAuthSync state={privyBridgeState}>
        <App />
      </PrivyRuntimeAuthSync>
    </PrivyProvider>
  )
}

const root = createRoot(document.getElementById('root'))
root.render(<RootApp />)
