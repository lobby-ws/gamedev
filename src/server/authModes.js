const VALID_AUTH_MODES = new Set(['standalone', 'platform'])

function normalizeMode(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim().toLowerCase()
  return trimmed || fallback
}

function hasValue(value) {
  return typeof value === 'string' && value.trim().length > 0
}

export function resolveAuthRuntimeConfig(env = process.env) {
  const authMode = normalizeMode(env.AUTH_MODE, 'standalone')

  if (!VALID_AUTH_MODES.has(authMode)) {
    throw new Error(`[envs] AUTH_MODE must be one of: standalone, platform (got ${authMode})`)
  }

  // Identity mode is inferred:
  // - platform always uses Lobby identity
  // - standalone uses Lobby identity only when PUBLIC_AUTH_URL is set
  const usesLobbyIdentity = authMode === 'platform' || hasValue(env.PUBLIC_AUTH_URL)
  const identityMode = usesLobbyIdentity ? 'lobby' : 'local'

  return {
    authMode,
    identityMode,
    isPlatformMode: authMode === 'platform',
    isStandaloneMode: authMode === 'standalone',
    usesLobbyIdentity,
    usesLocalIdentity: !usesLobbyIdentity,
  }
}
