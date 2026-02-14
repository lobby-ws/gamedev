function hasValue(value) {
  return typeof value === 'string' && value.trim().length > 0
}

export function resolveAuthRuntimeConfig(env = process.env) {
  const usesLobbyIdentity = hasValue(env.PUBLIC_AUTH_URL)

  return {
    usesLobbyIdentity,
    usesLocalIdentity: !usesLobbyIdentity,
  }
}
