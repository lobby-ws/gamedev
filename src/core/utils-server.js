import crypto from 'crypto'
import jwt from 'jsonwebtoken'

/**
 *
 * Hash File
 *
 * takes a file and generates a sha256 unique hash.
 * carefully does this the same way as the client function.
 *
 */

export async function hashFile(file) {
  const hash = crypto.createHash('sha256')
  hash.update(file)
  return hash.digest('hex')
}

/**
 * JSON Web Tokens
 */

const jwtSecret = process.env.JWT_SECRET
const RUNTIME_SESSION_TYP = 'runtime_session'
const RUNTIME_SESSION_AUDIENCE = 'runtime:ws'
const IDENTITY_EXCHANGE_TYP = 'identity_exchange'
const IDENTITY_EXCHANGE_AUDIENCE = 'runtime:exchange'
const DEFAULT_RUNTIME_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7
const DEFAULT_VERIFY_TIMEOUT_MS = 5000

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const runtimeSessionTtlSeconds = parsePositiveInt(
  process.env.RUNTIME_SESSION_TTL_SECONDS,
  DEFAULT_RUNTIME_SESSION_TTL_SECONDS
)

function resolveRuntimeSessionIssuer() {
  const fromPublicApi = process.env.PUBLIC_API_URL?.trim()
  if (fromPublicApi) return fromPublicApi.replace(/\/api\/?$/, '')
  const fromPublicWs = process.env.PUBLIC_WS_URL?.trim()
  if (fromPublicWs) {
    return fromPublicWs
      .replace(/^wss:/, 'https:')
      .replace(/^ws:/, 'http:')
      .replace(/\/ws\/?$/, '')
  }
  const fromPublicAuth = process.env.PUBLIC_AUTH_URL?.trim()
  if (fromPublicAuth) return fromPublicAuth
  return 'runtime'
}

function resolveLobbyIdentityIssuer() {
  const fromPublicAuth = process.env.PUBLIC_AUTH_URL?.trim()
  if (fromPublicAuth) return fromPublicAuth
  return null
}

function resolveLobbyIdentityVerifyUrls(verifyUrl) {
  const explicit = typeof verifyUrl === 'string' ? verifyUrl.trim() : ''
  if (explicit) return [explicit]

  const base = process.env.PUBLIC_AUTH_URL?.trim()
  if (!base) return []

  const normalizedBase = base.replace(/\/+$/, '')
  if (/\/api$/i.test(normalizedBase)) {
    return [`${normalizedBase}/auth/exchange/verify`]
  }

  // Support both proxy-style (/api/*) and direct world-service routes.
  return [
    `${normalizedBase}/api/auth/exchange/verify`,
    `${normalizedBase}/auth/exchange/verify`,
  ]
}

export function createJWT(data, { worldId } = {}) {
  const userId = typeof data?.userId === 'string' ? data.userId.trim() : ''
  if (!userId) {
    return Promise.reject(new Error('createJWT requires userId'))
  }
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    typ: RUNTIME_SESSION_TYP,
    iss: resolveRuntimeSessionIssuer(),
    aud: RUNTIME_SESSION_AUDIENCE,
    userId,
    worldId: worldId || data?.worldId || process.env.WORLD_ID || null,
    iat: now,
    exp: now + runtimeSessionTtlSeconds,
  }
  return new Promise((resolve, reject) => {
    jwt.sign(payload, jwtSecret, (err, token) => {
      if (err) return reject(err)
      resolve(token)
    })
  })
}

export function readJWT(token, { worldId } = {}) {
  return new Promise((resolve, reject) => {
    const issuer = resolveRuntimeSessionIssuer()
    jwt.verify(
      token,
      jwtSecret,
      {
        audience: RUNTIME_SESSION_AUDIENCE,
        ...(issuer ? { issuer } : {}),
      },
      (err, data) => {
        if (err || !data || typeof data !== 'object') {
          resolve(null)
          return
        }
        if (data.typ !== RUNTIME_SESSION_TYP) {
          resolve(null)
          return
        }
        if (typeof data.userId !== 'string' || !data.userId.trim()) {
          resolve(null)
          return
        }
        if (worldId && data.worldId !== worldId) {
          resolve(null)
          return
        }
        resolve(data)
      }
    )
  })
}

export async function verifyIdentityExchangeTokenWithLobby(token, { verifyUrl, timeoutMs } = {}) {
  if (typeof token !== 'string' || !token.trim()) return null
  const endpoints = resolveLobbyIdentityVerifyUrls(verifyUrl)
  if (!endpoints.length) return null
  const resolvedTimeoutMs = parsePositiveInt(timeoutMs, DEFAULT_VERIFY_TIMEOUT_MS)
  for (const endpoint of endpoints) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), resolvedTimeoutMs)
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ token: token.trim() }),
        signal: controller.signal,
      })
      if (response.status === 404) {
        continue
      }
      if (!response.ok) return null
      const payload = await response.json().catch(() => null)
      if (payload?.valid !== true || !payload?.claims || typeof payload.claims !== 'object') {
        return null
      }
      const claims = payload.claims
      if (claims.typ !== IDENTITY_EXCHANGE_TYP) return null
      if (claims.aud !== IDENTITY_EXCHANGE_AUDIENCE) return null
      if (typeof claims.userId !== 'string' || !claims.userId.trim()) return null
      if (typeof claims.sub !== 'string' || claims.sub !== claims.userId) return null
      const expectedIssuer = resolveLobbyIdentityIssuer()
      if (expectedIssuer && claims.iss !== expectedIssuer) return null
      return claims
    } catch {
      continue
    } finally {
      clearTimeout(timeoutId)
    }
  }
  return null
}
