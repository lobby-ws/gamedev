# Auth Contract

Status: Draft  
Last Updated: 2026-02-10

## Modes

`AUTH_MODE`
1. `standalone` (default)
2. `platform` (legacy/internal compatibility only)

Identity behavior is inferred:
1. `AUTH_MODE=platform` always uses Lobby identity.
2. `AUTH_MODE=standalone` + `PUBLIC_AUTH_URL` set uses Lobby identity.
3. `AUTH_MODE=standalone` + `PUBLIC_AUTH_URL` unset uses local identity.

## Token Types

### `world_connection` (legacy/platform)
Issuer: world-service  
Audience: `runtime:connect`  
Usage: legacy/platform runtimes that still use world-service-issued connection tokens.

Required claims:
1. `typ=world_connection`
2. `iss` (world-service issuer)
3. `aud=runtime:connect`
4. `worldId`
5. `worldSlug`
6. `gameServer`
7. `userId`
8. `iat`
9. `exp`

### `identity_exchange`
Issuer: world-service auth  
Audience: `runtime:exchange`  
Usage: standalone+lobby client exchanges this with runtime for a runtime session token

Required claims:
1. `typ=identity_exchange`
2. `iss` (Lobby auth issuer)
3. `aud=runtime:exchange`
4. `sub` (user id)
5. `userId`
6. `iat`
7. `exp`

Optional claims:
1. `walletAddress`

### `runtime_session`
Issuer: runtime  
Audience: `runtime:ws`  
Usage: runtime WS auth token accepted by runtime in standalone modes

Required claims:
1. `typ=runtime_session`
2. `iss` (runtime issuer)
3. `aud=runtime:ws`
4. `userId`
5. `worldId`
6. `iat`
7. `exp`

## Behavior Matrix

### `standalone` (local identity)
1. Runtime accepts `runtime_session`.
2. If missing/invalid token, runtime may create anonymous local user.
3. Runtime may mint `runtime_session` directly.

### `standalone + lobby identity`
1. Runtime accepts only `runtime_session` on WS.
2. Missing token is allowed and runtime admits as guest.
3. Invalid provided token is rejected.
4. Signed-in client obtains `identity_exchange` from Lobby auth and calls runtime `/api/auth/exchange`.
5. Runtime verifies exchange token via Lobby verifier endpoint, then mints `runtime_session`.

### `platform` (legacy/internal)
1. Legacy/runtime compatibility only: accepts `world_connection` on WS.
2. Runtime rejects anonymous fallback.
3. Runtime validates token claims: `typ`, issuer, audience, expiry, and `worldId == WORLD_ID`.
4. Runtime authorizes user via world-service internal API.

## Runtime Environment Matrix

Common:
1. `AUTH_MODE`
2. `WORLD_ID`
3. `JWT_SECRET`
4. `PUBLIC_API_URL`

Platform (legacy/internal):
1. `WORLD_SERVICE_API_KEY` (required in legacy mode)
2. `WORLD_SERVICE_INTERNAL_URL` (optional, defaults to `PUBLIC_API_URL`)
3. `PUBLIC_WS_URL` (optional, derived from `PUBLIC_API_URL`)

Standalone + lobby:
1. `PUBLIC_AUTH_URL` (required for this mode)
2. `PUBLIC_WS_URL` (optional, derived from `PUBLIC_API_URL`)

Standalone local identity:
1. `PUBLIC_AUTH_URL` must be unset.
2. `PUBLIC_WS_URL` is optional and can be derived from `PUBLIC_API_URL`.

## Endpoint Contracts

World-service:
1. `POST /worlds/:slug/join` -> returns `world_connection` token (platform/legacy runtime compatibility only).
2. `POST /auth/exchange` -> returns `identity_exchange` token for authenticated session.
3. `POST /auth/exchange/verify` -> validates `identity_exchange` and returns claims.

Runtime:
1. `POST /api/auth/exchange` -> accepts `identity_exchange`, returns `runtime_session`.
2. `GET /ws` -> accepts tokens according to resolved runtime mode.
