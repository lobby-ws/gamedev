# Platform Mode Readiness Plan (Exchange Token First)

Status: Draft (tracked checklist)  
Last Updated: 2026-02-10  
Scope: `runtime` + `world-service`

## Locked Decisions

1. Use **exchange token first** for connection auth.
2. Keep runtime **self-hostable**.
3. Self-hosted runtime can use Lobby identity service.
4. No backward-compat work for existing worlds/dev data is required.
5. `WORLD_ID` is canonical and immutable.
6. Per-world DB schema is the tenancy boundary.

## Already Completed (Context)

- [x] Removed `deployment_id` coupling from runtime world-state path.
- [x] Switched to per-world `DB_SCHEMA` injection in world-service GameServer spec.
- [x] Removed `DEPLOYMENT_ID` from world-service runtime env/labels.
- [x] Added static engine root override (`ENGINE_STATIC_ROOT`) with default `public/engine`.
- [x] `PUBLIC_AUTH_URL` is env-overridable and now optional for pure standalone mode.

## Target Auth Model

### Platform mode
1. Client authenticates with Lobby auth (session/cookie at `PUBLIC_AUTH_URL`).
2. Client calls `POST /worlds/:slug/join` on world-service.
3. world-service provisions/locates runtime and returns a short-lived **world connection token**.
4. Client connects to runtime WS with that token.
5. Runtime validates token claims (not just signature), then admits/rejects.

### Standalone + Lobby identity mode
1. Client gets short-lived **identity exchange token** from Lobby auth.
2. Client calls runtime `POST /api/auth/exchange` with that identity token.
3. Runtime validates token with Lobby identity verifier.
4. Runtime returns runtime-local WS auth token.
5. Client connects WS with runtime token.

Notes:
- In both modes, direct anonymous fallback is disabled when external identity is selected.
- WS should never accept raw Lobby identity token directly; it should accept exchanged runtime token.

## PR-Sized Work Units

### PR-01: Auth Contract Freeze (Spec + Env Matrix)
- [x] Repo: `runtime`
- Deliverables:
  - Add/lock token types and required claims:
    - `world_connection` (platform join token)
    - `identity_exchange` (Lobby -> runtime exchange input)
    - `runtime_session` (runtime WS token)
  - Add env matrix for `AUTH_MODE` + inferred identity behavior (`PUBLIC_AUTH_URL` in standalone).
- Suggested files:
  - `runtime/docs/platform-mode-exchange-token-plan.md` (this file)
  - `runtime/docs/auth-contract.md`
- Acceptance:
  - Claims, TTLs, issuers/audiences, and mode behavior are explicit.
- Dependencies:
  - None.

### PR-02: Runtime Mode Switch Skeleton
- [x] Repo: `runtime`
- Deliverables:
  - Add `AUTH_MODE=standalone|platform` (default `standalone`).
  - Infer identity behavior from mode + env:
    - `platform` always lobby identity
    - `standalone` uses lobby identity only when `PUBLIC_AUTH_URL` is set
  - Centralize mode parsing/validation without `IDENTITY_MODE`.
- Suggested files:
  - `runtime/src/server/index.js`
  - `runtime/src/core/systems/ServerNetwork.js`
  - `runtime/.env.example`
- Acceptance:
  - Runtime boots with mode-specific guards and clear startup logs.
- Dependencies:
  - Can start independently.

### PR-03: Harden Platform Join Token Issuance
- [x] Repo: `world-service`
- Deliverables:
  - Harden token from `/worlds/:slug/join` with explicit typed claims:
    - `typ=world_connection`
    - `worldId`, `worldSlug`, `gameServer`, `userId`, `exp`, `iat`, `iss`, `aud`
  - Keep short TTL.
- Suggested files:
  - `world-service/src/lib/token.ts`
  - `world-service/src/api/worlds.ts`
- Acceptance:
  - Token payload is deterministic and claim-complete.
- Dependencies:
  - None.

### PR-04: Runtime Platform Token Validation
- [x] Repo: `runtime`
- Deliverables:
  - In `AUTH_MODE=platform`, validate:
    - signature
    - `typ=world_connection`
    - `worldId === WORLD_ID`
    - optional `gameServer` match (if configured)
    - expiry/audience/issuer
  - Reject invalid token before entity/user hydration.
- Suggested files:
  - `runtime/src/core/utils-server.js`
  - `runtime/src/core/systems/ServerNetwork.js`
- Acceptance:
  - Runtime rejects wrong-world or malformed tokens.
- Dependencies:
  - Depends on PR-03 claim contract.

### PR-05: Runtime Internal Credentials from World-Service
- [x] Repo: `world-service`
- Deliverables:
  - Provision/reuse per-world internal API key for runtime-to-world-service calls.
  - Inject into runtime pod env:
    - `WORLD_SERVICE_INTERNAL_URL`
    - `WORLD_SERVICE_API_KEY`
  - Keep existing `WORLD_ID`, `DB_SCHEMA`, `PUBLIC_AUTH_URL`.
- Suggested files:
  - `world-service/src/lib/agones.ts`
  - `world-service/src/api/worlds.ts`
  - `world-service/src/db/migrations/*` (only if key schema changes)
- Acceptance:
  - Runtime pod has internal auth envs and valid key path.
- Dependencies:
  - Can be done before runtime consumer.

### PR-06: Runtime World-Service Internal Client
- [x] Repo: `runtime`
- Deliverables:
  - Add typed client for world-service internal endpoints.
  - On connect in platform mode:
    - resolve user/access/role from world-service
    - deny on `access=false`
    - upsert runtime-local user projection (`id/name/avatar/rank`)
- Suggested files:
  - `runtime/src/core/systems/ServerNetwork.js`
  - `runtime/src/server/*` (new internal client module)
- Acceptance:
  - Platform runtime authorization is world-service authoritative.
- Dependencies:
  - Depends on PR-05.

### PR-07: Disable Local Escalation in Platform Mode
- [x] Repo: `runtime`
- Deliverables:
  - Disable `/admin <code>` privilege elevation path in `AUTH_MODE=platform`.
  - Prevent "everyone admin when ADMIN_CODE missing" behavior in platform mode.
  - Keep behavior unchanged in standalone/local mode.
- Suggested files:
  - `runtime/src/core/systems/ServerNetwork.js`
  - `runtime/src/server/index.js`
- Acceptance:
  - Platform mode permissions come only from world-service role mapping.
- Dependencies:
  - Depends on PR-06 role resolution.

### PR-08: Join Idempotency Lock
- [x] Repo: `world-service`
- Deliverables:
  - Add lock/idempotency around `POST /worlds/:slug/join` to avoid duplicate GameServer creation under concurrent joins.
  - Keep response behavior stable.
- Suggested files:
  - `world-service/src/api/worlds.ts`
- Acceptance:
  - Concurrent joins produce one provision operation.
- Dependencies:
  - None (can run in parallel with PR-05/06).

### PR-09: Lobby Identity Exchange Endpoint
- [x] Repo: `world-service`
- Deliverables:
  - Add auth endpoint to issue short-lived `identity_exchange` token from authenticated Lobby session.
  - Endpoint should be usable by self-hosted runtime clients.
- Suggested files:
  - `world-service/src/api/auth.ts`
  - `world-service/src/lib/token.ts`
- Acceptance:
  - Authenticated client can request exchange token with expected claims/TTL.
- Dependencies:
  - Depends on PR-01 contract freeze.

### PR-10: Runtime `/api/auth/exchange` (Standalone + Lobby)
- [x] Repo: `runtime`
- Deliverables:
  - Add endpoint to accept `identity_exchange` token.
  - Verify token against Lobby identity verifier.
  - Mint runtime `runtime_session` token and return it.
- Suggested files:
  - `runtime/src/server/index.js`
  - `runtime/src/core/utils-server.js`
  - `runtime/src/core/systems/ServerNetwork.js`
- Acceptance:
  - Runtime WS only receives runtime-session token; identity token is never accepted directly.
- Dependencies:
  - Depends on PR-09.

### PR-11: Client Flow Update for Standalone + Lobby
- [x] Repo: `runtime`
- Deliverables:
  - Client flow for standalone+lobby:
    - fetch exchange token from Lobby auth
    - call runtime `/api/auth/exchange`
    - connect WS with returned runtime token
  - Keep platform flow using world-service `/join`.
- Suggested files:
  - `runtime/src/client/index.js`
  - `runtime/src/client/world-client.js`
  - `runtime/src/core/systems/ClientNetwork.js`
- Acceptance:
  - No direct WS connect with raw Lobby identity token.
- Dependencies:
  - Depends on PR-10.

### PR-12: Presence + Heartbeat Wiring from Runtime
- [x] Repo: `runtime`
- Deliverables:
  - Call world-service internal endpoints for:
    - player join
    - player leave
    - heartbeat
  - Add retry/backoff (best effort).
- Suggested files:
  - `runtime/src/core/systems/ServerNetwork.js`
  - `runtime/src/server/*` (internal client module)
- Acceptance:
  - world-service status/presence reflects runtime events.
- Dependencies:
  - Depends on PR-05.

### PR-13: E2E Smoke Matrix + Ops Guardrails
- [x] Repo: `runtime` + `world-service`
- Deliverables:
  - Automated smoke matrix:
    - standalone + local identity
    - standalone + Lobby identity
    - platform + Lobby identity
  - Remove secret logging (`console.log(config)` in world-service config).
  - Add runbook for required envs per mode.
- Suggested files:
  - `world-service/src/lib/config.ts`
  - test/docs scripts in both repos
- Acceptance:
  - Mode matrix is reproducible on dev infra.
- Dependencies:
  - Depends on relevant feature PRs above.

## Dependency Notes (No-Avoid Cases)

1. PR-04 cannot be fully completed before PR-03 because claim validation depends on finalized join token claims.
2. PR-06 cannot be completed before PR-05 because runtime needs injected internal credentials.
3. PR-07 depends on PR-06 so role authority is already external before local escalation is removed.
4. PR-10 depends on PR-09 for exchange-token issuer contract.
5. PR-11 depends on PR-10 because client flow needs runtime exchange endpoint.

## Parallelization Guidance

Safe to run in parallel:
1. PR-02 and PR-03.
2. PR-05 and PR-08.
3. PR-09 in parallel with PR-05/08.

Recommended sequence:
1. PR-01
2. PR-02 + PR-03
3. PR-04
4. PR-05 + PR-08
5. PR-06 + PR-07 + PR-12
6. PR-09 + PR-10 + PR-11
7. PR-13
