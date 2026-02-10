const DEFAULT_TIMEOUT_MS = 5000
const VALID_WORLD_ROLES = new Set(['admin', 'builder', 'visitor'])

export class WorldServiceRequestError extends Error {
  constructor(message, { status = null, body = null } = {}) {
    super(message)
    this.name = 'WorldServiceRequestError'
    this.status = status
    this.body = body
  }
}

function normalizeBaseUrl(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.replace(/\/+$/, '')
}

function parseJson(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function normalizeWorldRole(value) {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return VALID_WORLD_ROLES.has(normalized) ? normalized : null
}

function normalizeUserProjection(value) {
  if (!value || typeof value !== 'object') return null
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  if (!id) return null
  const name =
    typeof value.name === 'string' && value.name.trim()
      ? value.name.trim()
      : 'Anonymous'
  const avatar =
    typeof value.avatar === 'string' && value.avatar.trim()
      ? value.avatar.trim()
      : null
  return { id, name, avatar }
}

export function createWorldServiceInternalClient({
  baseUrl,
  apiKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  const normalizedApiKey = typeof apiKey === 'string' ? apiKey.trim() : ''

  if (!normalizedBaseUrl) {
    throw new Error('[envs] WORLD_SERVICE_INTERNAL_URL must be set when AUTH_MODE=platform')
  }
  if (!normalizedApiKey) {
    throw new Error('[envs] WORLD_SERVICE_API_KEY must be set when AUTH_MODE=platform')
  }

  const resolvedTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS

  async function request(path, { method = 'GET', body, headers } = {}) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), resolvedTimeoutMs)
    const requestHeaders = {
      authorization: `Bearer ${normalizedApiKey}`,
      accept: 'application/json',
      ...headers,
    }
    if (body !== undefined) {
      requestHeaders['content-type'] = 'application/json'
    }

    let response
    try {
      response = await fetch(`${normalizedBaseUrl}${path}`, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      const reason =
        err?.name === 'AbortError'
          ? 'timeout'
          : err?.message || String(err)
      throw new WorldServiceRequestError(
        `[world-service] ${method} ${path} failed: ${reason}`
      )
    } finally {
      clearTimeout(timeoutId)
    }

    const text = await response.text()
    const payload = parseJson(text)
    if (!response.ok) {
      const errorCode =
        typeof payload?.error === 'string' && payload.error
          ? payload.error
          : `http_${response.status}`
      throw new WorldServiceRequestError(
        `[world-service] ${method} ${path} failed (${response.status}): ${errorCode}`,
        { status: response.status, body: payload }
      )
    }

    return payload
  }

  return {
    async getWorld() {
      const payload = await request('/internal/world')
      const world = payload?.world
      if (!world || typeof world !== 'object') {
        throw new WorldServiceRequestError('[world-service] invalid world payload')
      }
      const id = typeof world.id === 'string' ? world.id.trim() : ''
      const slug = typeof world.slug === 'string' ? world.slug.trim() : ''
      if (!id || !slug) {
        throw new WorldServiceRequestError('[world-service] invalid world identity payload')
      }
      return {
        id,
        slug,
        name: typeof world.name === 'string' ? world.name : '',
        settings: world.settings ?? null,
        capacity:
          Number.isFinite(world.capacity) && world.capacity >= 0
            ? world.capacity
            : null,
      }
    },

    async getUserAccess(userId) {
      const normalizedUserId = typeof userId === 'string' ? userId.trim() : ''
      if (!normalizedUserId) {
        throw new Error('[world-service] userId is required')
      }
      const payload = await request(
        `/internal/users/${encodeURIComponent(normalizedUserId)}`
      )
      const access = Boolean(payload?.access)
      const user = normalizeUserProjection(payload?.user)
      const role = normalizeWorldRole(payload?.role)
      if (access && !user) {
        throw new WorldServiceRequestError(
          '[world-service] access response missing user projection'
        )
      }
      return { access, role, user }
    },

    async playerJoin(userId) {
      await request('/internal/players/join', {
        method: 'POST',
        body: { user_id: userId },
      })
    },

    async playerLeave(userId) {
      await request('/internal/players/leave', {
        method: 'POST',
        body: { user_id: userId },
      })
    },

    async heartbeat({ playerCount, address, serverId } = {}) {
      const body = { player_count: Number.isFinite(playerCount) ? playerCount : 0 }
      if (typeof address === 'string' && address.trim()) {
        body.address = address.trim()
      }
      const headers = {}
      if (typeof serverId === 'string' && serverId.trim()) {
        headers['x-server-id'] = serverId.trim()
      }
      await request('/internal/heartbeat', {
        method: 'POST',
        body,
        headers,
      })
    },
  }
}
