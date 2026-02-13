# Runtime/World-Service Mode Runbook

Status: Active  
Last Updated: 2026-02-10

## Runtime Modes

### 1) Local identity

Required runtime envs:
1. `WORLD_ID`
2. `JWT_SECRET`
3. `PUBLIC_API_URL`

Optional runtime envs:
1. `PUBLIC_WS_URL` (derived from `PUBLIC_API_URL` when unset)
2. `RUNTIME_SESSION_TTL_SECONDS`

Notes:
1. `PUBLIC_AUTH_URL` should be unset in this mode.
2. Anonymous fallback is enabled.
3. Runtime mints `runtime_session` tokens locally.

### 2) Lobby identity

Required runtime envs:
1. `PUBLIC_AUTH_URL`
2. `WORLD_ID`
3. `JWT_SECRET`
4. `PUBLIC_API_URL`

Optional runtime envs:
1. `PUBLIC_WS_URL` (derived from `PUBLIC_API_URL` when unset)
2. `RUNTIME_SESSION_TTL_SECONDS`

Required world-service/auth envs:
1. `/auth/exchange` and `/auth/exchange/verify` must be reachable from `PUBLIC_AUTH_URL`.

Notes:
1. Signed-in client does `identity_exchange` -> runtime `/api/auth/exchange` before WS.
2. Missing token is allowed and runtime admits as guest.
3. Invalid provided runtime session token is rejected.

## Smoke Matrix

Command:

```bash
npm run smoke:matrix
```

Inputs:
1. `SMOKE_RUNTIME_API_URL` (default `http://127.0.0.1:3000/api`)
2. `SMOKE_WORLD_SERVICE_API_URL` (default `https://dev.lobby.ws/api`)
3. `SMOKE_LOBBY_SESSION_COOKIE` (required for lobby checks)
4. `SMOKE_TIMEOUT_MS` (optional, default `10000`)

Behavior:
1. `local identity` runs with runtime health/status checks.
2. `lobby identity` runs identity token issue + runtime exchange flow checks.
