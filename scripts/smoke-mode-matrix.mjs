import process from 'node:process'

class SkipError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SkipError'
  }
}

function normalizeUrl(value) {
  if (!value || typeof value !== 'string') return null
  return value.trim().replace(/\/+$/, '')
}

function decodeJwtClaims(token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8')
    return JSON.parse(payload)
  } catch {
    return null
  }
}

async function requestJson(url, { method = 'GET', headers = {}, body, timeoutMs = 10000 } = {}) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => null)
    return { ok: response.ok, status: response.status, payload }
  } finally {
    clearTimeout(timeoutId)
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

const runtimeApiUrl = normalizeUrl(
  process.env.SMOKE_RUNTIME_API_URL
    || process.env.PUBLIC_API_URL
    || 'http://127.0.0.1:3000/api'
)
const worldServiceApiUrl = normalizeUrl(
  process.env.SMOKE_WORLD_SERVICE_API_URL
    || process.env.PUBLIC_AUTH_API_URL
    || 'https://dev.lobby.ws/api'
)
const lobbySessionCookie = process.env.SMOKE_LOBBY_SESSION_COOKIE?.trim() || ''
const worldSlug = process.env.SMOKE_WORLD_SLUG?.trim() || ''
const timeoutMs = Number.parseInt(process.env.SMOKE_TIMEOUT_MS || '10000', 10)

async function runStandaloneLocal() {
  const health = await requestJson(`${runtimeApiUrl.replace(/\/api$/, '')}/health`, { timeoutMs })
  assert(health.ok, `runtime health failed (${health.status})`)
  assert(health.payload?.ok === true, 'runtime health payload is not ok=true')

  const status = await requestJson(`${runtimeApiUrl.replace(/\/api$/, '')}/status`, { timeoutMs })
  assert(status.ok, `runtime status failed (${status.status})`)
  assert(status.payload?.ok === true, 'runtime status payload is not ok=true')
}

async function requestIdentityExchangeToken() {
  if (!lobbySessionCookie) {
    throw new SkipError('SMOKE_LOBBY_SESSION_COOKIE is required')
  }
  const result = await requestJson(`${worldServiceApiUrl}/auth/exchange`, {
    method: 'POST',
    headers: {
      cookie: `session=${lobbySessionCookie}`,
    },
    timeoutMs,
  })
  assert(result.ok, `world-service /auth/exchange failed (${result.status})`)
  const token = typeof result.payload?.token === 'string' ? result.payload.token.trim() : ''
  assert(token, 'missing identity exchange token')
  return token
}

async function runStandaloneLobby() {
  const identityToken = await requestIdentityExchangeToken()
  const exchange = await requestJson(`${runtimeApiUrl}/auth/exchange`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: { token: identityToken },
    timeoutMs,
  })
  assert(exchange.ok, `runtime /api/auth/exchange failed (${exchange.status})`)
  const runtimeToken = typeof exchange.payload?.token === 'string' ? exchange.payload.token.trim() : ''
  assert(runtimeToken, 'missing runtime session token')
  const claims = decodeJwtClaims(runtimeToken)
  assert(claims?.typ === 'runtime_session', 'runtime session typ mismatch')
  assert(claims?.aud === 'runtime:ws', 'runtime session aud mismatch')
}

async function runPlatformLobby() {
  if (!worldSlug) {
    throw new SkipError('SMOKE_WORLD_SLUG is required')
  }
  if (!lobbySessionCookie) {
    throw new SkipError('SMOKE_LOBBY_SESSION_COOKIE is required')
  }
  const join = await requestJson(`${worldServiceApiUrl}/worlds/${encodeURIComponent(worldSlug)}/join`, {
    method: 'POST',
    headers: {
      cookie: `session=${lobbySessionCookie}`,
    },
    timeoutMs,
  })
  assert(join.ok, `world-service /worlds/:slug/join failed (${join.status})`)
  const status = join.payload?.status
  assert(['ready', 'starting', 'provisioning'].includes(status), `unexpected join status: ${status}`)
  if (status === 'ready') {
    const token = join.payload?.connection?.token
    const claims = decodeJwtClaims(token)
    assert(claims?.typ === 'world_connection', 'world connection typ mismatch')
    assert(claims?.aud === 'runtime:connect', 'world connection aud mismatch')
    assert(claims?.worldSlug === worldSlug, 'world connection slug mismatch')
  }
}

const checks = [
  { name: 'standalone + local identity', run: runStandaloneLocal },
  { name: 'standalone + lobby identity', run: runStandaloneLobby },
  { name: 'platform + lobby identity', run: runPlatformLobby },
]

const results = []
let failures = 0

for (const check of checks) {
  try {
    await check.run()
    results.push({ name: check.name, status: 'PASS', detail: '' })
  } catch (err) {
    if (err instanceof SkipError) {
      results.push({ name: check.name, status: 'SKIP', detail: err.message })
      continue
    }
    failures += 1
    results.push({ name: check.name, status: 'FAIL', detail: err?.message || String(err) })
  }
}

console.log('Smoke Matrix')
for (const result of results) {
  const suffix = result.detail ? ` - ${result.detail}` : ''
  console.log(`${result.status.padEnd(4)} ${result.name}${suffix}`)
}

if (failures > 0) {
  process.exit(1)
}
