const DEFAULT_REGISTRY_URL = 'https://disciplined-cheetah-263.convex.site/'
const REGISTER_PATH = '/v1/servers/register'
const REGISTRY_TIMEOUT_MS = 5000

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'y', 'on'])
const FALSE_VALUES = new Set(['0', 'false', 'no', 'n', 'off'])

function parseEnvBoolean(value, defaultValue) {
  if (value === undefined) return defaultValue
  const normalized = String(value).trim().toLowerCase()
  if (TRUE_VALUES.has(normalized)) return true
  if (FALSE_VALUES.has(normalized)) return false
  return defaultValue
}

function isLocalhost(hostname) {
  const host = hostname.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
}

function normalizeJoinUrl(rawUrl) {
  if (!rawUrl) return { url: null, reason: 'missing_url' }
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch (err) {
    return { url: null, reason: 'invalid_url' }
  }

  if (parsed.protocol !== 'https:') return { url: null, reason: 'not_https' }
  if (parsed.username || parsed.password) return { url: null, reason: 'userinfo_not_allowed' }
  if (!parsed.hostname) return { url: null, reason: 'missing_host' }
  if (isLocalhost(parsed.hostname)) return { url: null, reason: 'localhost' }
  if (parsed.port && parsed.port !== '443') return { url: null, reason: 'custom_port' }
  if (parsed.port === '443') parsed.port = ''

  parsed.search = ''
  parsed.hash = ''

  let path = parsed.pathname || '/'
  if (path !== '/' && path.endsWith('/')) {
    path = path.slice(0, -1)
  }
  parsed.pathname = path

  const joinPath = path === '/' ? '' : path
  return { url: `${parsed.origin}${joinPath}`, reason: null }
}

function deriveJoinUrl({ joinUrlOverride, publicApiUrl }) {
  if (joinUrlOverride) return normalizeJoinUrl(joinUrlOverride)
  if (!publicApiUrl) return { url: null, reason: 'missing_public_api_url' }

  let parsed
  try {
    parsed = new URL(publicApiUrl)
  } catch (err) {
    return { url: null, reason: 'invalid_public_api_url' }
  }

  let path = parsed.pathname || '/'
  path = path.replace(/\/+$/, '')
  if (path.endsWith('/api')) {
    path = path.slice(0, -4)
  }
  if (!path) path = '/'

  parsed.pathname = path
  parsed.search = ''
  parsed.hash = ''
  if (parsed.port === '443') parsed.port = ''

  return normalizeJoinUrl(parsed.toString())
}

export function createRegistryState(env = process.env) {
  const enabled = parseEnvBoolean(env.REGISTRY_ENABLED, true)
  const registryUrl = env.REGISTRY_URL || DEFAULT_REGISTRY_URL
  const { url: joinUrl, reason } = deriveJoinUrl({
    joinUrlOverride: env.REGISTRY_JOIN_URL,
    publicApiUrl: env.PUBLIC_API_URL,
  })

  return {
    enabled,
    registryUrl,
    joinUrl,
    listable: enabled && !!joinUrl,
    reason,
    verificationToken: null,
    verificationExpiresAt: null,
    verificationExpiresAtMs: null,
    verificationTimeoutId: null,
  }
}

export function getRegistryPublicStatus(state) {
  if (!state?.listable) return null
  if (!state.verificationToken || !state.verificationExpiresAtMs) return null
  if (Date.now() >= state.verificationExpiresAtMs) return null
  return {
    verificationToken: state.verificationToken,
    verificationExpiresAt: state.verificationExpiresAt,
  }
}

export async function registerWithRegistry(state, { worldId, commitHash } = {}) {
  if (!state?.enabled || !state.listable || !state.joinUrl) return
  if (!state.registryUrl) return

  let endpoint
  try {
    endpoint = new URL(REGISTER_PATH, state.registryUrl)
  } catch (err) {
    console.warn('[registry] invalid REGISTRY_URL:', state.registryUrl)
    return
  }

  const payload = { joinUrl: state.joinUrl }
  if (worldId) payload.worldId = worldId
  if (commitHash) payload.commitHash = commitHash

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS)

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    if (!response.ok) {
      console.warn(`[registry] registration failed: ${response.status}`)
      return
    }

    const data = await response.json()
    const token = data?.verificationToken
    const expiresAt = data?.verificationExpiresAt
    const expiresAtMs = Date.parse(expiresAt || '')
    if (!token || !Number.isFinite(expiresAtMs)) {
      console.warn('[registry] missing verification token')
      return
    }

    state.verificationToken = token
    state.verificationExpiresAt = new Date(expiresAtMs).toISOString()
    state.verificationExpiresAtMs = expiresAtMs

    if (state.verificationTimeoutId) {
      clearTimeout(state.verificationTimeoutId)
    }
    const delay = Math.max(expiresAtMs - Date.now(), 0)
    state.verificationTimeoutId = setTimeout(() => {
      if (state.verificationToken === token) {
        state.verificationToken = null
        state.verificationExpiresAt = null
        state.verificationExpiresAtMs = null
        state.verificationTimeoutId = null
      }
    }, delay)
  } catch (err) {
    const message = err?.name === 'AbortError' ? 'timeout' : err?.message || err
    console.warn('[registry] registration error:', message)
  } finally {
    clearTimeout(timeoutId)
  }
}
