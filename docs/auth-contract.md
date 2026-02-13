# Auth Contract

Status: Draft  
Last Updated: 2026-02-13

## Auth signal

`PUBLIC_AUTH_URL` is the single runtime auth signal:

1. `PUBLIC_AUTH_URL` set: runtime uses Lobby identity exchange flow.
2. `PUBLIC_AUTH_URL` unset: runtime uses local identity.

## Token Types

### `identity_exchange`
Issuer: world-service auth  
Audience: `runtime:exchange`  
Usage: client exchanges this with runtime `/api/auth/exchange` for a runtime session token.

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
Usage: runtime WS auth token accepted by runtime.

Required claims:
1. `typ=runtime_session`
2. `iss` (runtime issuer)
3. `aud=runtime:ws`
4. `userId`
5. `worldId`
6. `iat`
7. `exp`

## Behavior Matrix

### Local identity (`PUBLIC_AUTH_URL` unset)
1. Runtime accepts `runtime_session`.
2. If token is missing or invalid, runtime creates an anonymous local user.
3. Runtime may mint `runtime_session` directly.

### Lobby identity (`PUBLIC_AUTH_URL` set)
1. Runtime accepts only `runtime_session` on WS.
2. Missing token is allowed and runtime admits as guest.
3. Invalid provided token is rejected.
4. Signed-in client obtains `identity_exchange` from Lobby auth and calls runtime `/api/auth/exchange`.
5. Runtime verifies exchange token via Lobby verifier endpoint, then mints `runtime_session`.

## Runtime Environment Matrix

Common:
1. `WORLD_ID`
2. `JWT_SECRET`
3. `PUBLIC_API_URL`
4. `PUBLIC_WS_URL` (optional, derived from `PUBLIC_API_URL`)

Lobby identity:
1. `PUBLIC_AUTH_URL` (required for this mode)
2. `PUBLIC_WS_URL` (optional, derived from `PUBLIC_API_URL`)

Local identity:
1. `PUBLIC_WS_URL` is optional and can be derived from `PUBLIC_API_URL`.

## Endpoint Contracts

World-service:
1. `POST /worlds/:slug/join` -> returns GameServer connection endpoint.
2. `POST /auth/exchange` -> returns `identity_exchange` token for authenticated session.
3. `POST /auth/exchange/verify` -> validates `identity_exchange` and returns claims.

Runtime:
1. `POST /api/auth/exchange` -> accepts `identity_exchange`, returns `runtime_session`.
2. `GET /ws` -> accepts `runtime_session`.
