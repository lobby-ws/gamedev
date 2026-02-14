# Runtime/World-Service Mode Runbook

Status: Active  
Last Updated: 2026-02-10

## Runtime Modes

### 1) `standalone` (pure self-host)

Required runtime envs:
1. `AUTH_MODE=standalone`
2. `WORLD_ID`
3. `JWT_SECRET`
4. `PUBLIC_API_URL`

Optional runtime envs:
1. `PUBLIC_WS_URL` (derived from `PUBLIC_API_URL` when unset)

Notes:
1. `PUBLIC_AUTH_URL` should be unset in this mode.
2. Anonymous fallback is enabled.
3. Runtime mints `runtime_session` tokens locally.

### 2) `standalone + lobby identity`

Required runtime envs:
1. `AUTH_MODE=standalone`
2. `PUBLIC_AUTH_URL`
3. `WORLD_ID`
4. `JWT_SECRET`
5. `PUBLIC_API_URL`

Optional runtime envs:
1. `PUBLIC_WS_URL` (derived from `PUBLIC_API_URL` when unset)
2. `RUNTIME_SESSION_TTL_SECONDS`

Required world-service/auth envs:
1. `/auth/exchange` and `/auth/exchange/verify` must be reachable from `PUBLIC_AUTH_URL`.

Notes:
1. Signed-in client does `identity_exchange` -> runtime `/api/auth/exchange` before WS.
2. Missing token is allowed and runtime admits as guest.
3. Invalid provided runtime session token is rejected.

### 3) `platform`

Required runtime envs:
1. `AUTH_MODE=platform`
2. `WORLD_SERVICE_API_KEY`
3. `WORLD_ID`
4. `JWT_SECRET`
5. `PUBLIC_API_URL`

Optional runtime envs:
1. `WORLD_SERVICE_INTERNAL_URL` (defaults to `PUBLIC_API_URL`)
2. `PUBLIC_WS_URL` (derived from `PUBLIC_API_URL` when unset)
3. `WORLD_SERVICE_HEARTBEAT_INTERVAL_MS`
4. `WORLD_SERVICE_RETRY_BASE_MS`
5. `WORLD_SERVICE_MAX_RETRIES`

Required world-service envs:
1. `PUBLIC_API_URL`
2. `JWT_SECRET`
3. Kubernetes settings used to spawn runtime (`K8S_NAMESPACE`, image config, etc.)

Notes:
1. Runtime accepts only `world_connection` tokens on WS.
2. Runtime user access/role is resolved via world-service internal API.
3. Runtime posts player join/leave + heartbeat to world-service internal endpoints.

## Smoke Matrix

Command:

```bash
npm run smoke:matrix
```

Inputs:
1. `SMOKE_RUNTIME_API_URL` (default `http://127.0.0.1:3000/api`)
2. `SMOKE_WORLD_SERVICE_API_URL` (default `https://dev.lobby.ws/api`)
3. `SMOKE_LOBBY_SESSION_COOKIE` (required for lobby checks)
4. `SMOKE_WORLD_SLUG` (required for platform check)
5. `SMOKE_TIMEOUT_MS` (optional, default `10000`)

Behavior:
1. `standalone` runs with runtime health/status checks.
2. `standalone+lobby` runs exchange-token issue + runtime exchange flow checks.
3. `platform` runs `/worlds/:slug/join` and validates world token claims when ready.
