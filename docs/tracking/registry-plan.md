# Hyperfy Server Registry (Public Directory) — Implementation Plan

## Summary

We want a public directory of Hyperfy worlds (“servers”) that players can browse. Worlds are self-hosted websites running the Hyperfy server runtime and serving the client to browsers.

**Paradigm shift**
- Discovery becomes **push → verify → poll**:
  1) World server sends a **single POST on startup** to the registry (“I’m online at this join URL”).
  2) Registry performs a **one-time verification** by fetching the world’s `GET /status` and checking a challenge token.
  3) Registry keeps the directory fresh by **polling `GET /status`** every minute and delists servers after 3 failures.

This avoids crawling the internet, keeps runtime work minimal, and ensures only servers that can serve the join URL can be listed.

---

## Goals

- Public directory lists **only online** servers.
- Registration is **opt-out**:
  - By default, a server attempts to register on startup.
  - Must be disable-able via env var.
  - Must not register when running on `localhost`.
- Registry **polls once per minute**.
- Registry marks offline after **3 consecutive failures**.
- Registry + server expose only minimal, public-safe metadata:
  - `worldId`, `title`, `description`, `imageUrl`, `playerCount`, `playerLimit`, `commitHash`.
- OK to change existing `GET /status` and `GET /health`. No backwards-compat requirement.
- Require **https join URLs**, **no custom ports**, and the join URL must include any necessary path so players land directly in the world.

## Non-goals (for this phase)

- Persisting offline servers in the directory.
- Tags/genre/search ranking.
- Authenticated operator accounts.
- Server “shutdown” signals (no unregister/heartbeat from server).
- Moderation UI (but do include blacklist hooks).

---

## Key Implications / Design Notes

1) **Privacy:** Current `GET /status` returns per-user data (`connectedUsers[]` with ids/names/positions). This must be removed for a public directory. `playerCount` should be a number only.

2) **Abuse resistance with low friction:** Because registration is opt-out and unauthenticated, we need:
   - A **challenge/verification step** so random URLs don’t get listed.
   - **SSRF protections** in the registry (never fetch internal/private addresses).
   - **Rate limiting** and a blacklist/denylist mechanism.

3) **Opt-out guarantee:** If a server opts out (env var disables registry), it should be impossible for a third party to list it. The verification handshake enforces this: without the server receiving a registry-issued challenge token, it cannot pass verification.

---

## Proposed Protocol

### Actors

- **World server**: Hyperfy runtime (this repo).
- **Registry service**: separate repo/service.

### URLs

- **Join URL**: the URL players should open to enter the world, e.g. `https://example.com/myworld`.
- **Status URL**: `joinUrl + "/status"` (path-aware), e.g. `https://example.com/myworld/status`.

### Lifecycle

1) **Startup registration (world → registry)**
   - World server POSTs join URL to registry once at startup.
   - Registry returns a short-lived `verificationToken`.
   - World server stores token in memory temporarily.

2) **One-time verification (registry → world)**
   - Registry fetches `GET statusUrl`.
   - Registry checks `registry.verificationToken === verificationToken` and `listable === true`.
   - If valid, registry marks server “online” and starts polling.

3) **Polling (registry → world)**
   - Every 60s, registry fetches `GET statusUrl`.
   - On success, update directory fields (`playerCount`, etc.) and reset failure count.
   - On failure, increment consecutive failure count; after 3 failures, mark offline and remove from directory results.

---

## World Server Changes (this repo)

### 1) Redefine `GET /status` as “public registry safe”

File: `src/server/index.js` (existing handler)

**New response schema (example)**
```json
{
  "ok": true,
  "worldId": "local-xxxxxxxxxx",
  "title": "My World",
  "description": "A short blurb",
  "imageUrl": "https://cdn.example.com/preview.jpg",
  "playerCount": 3,
  "playerLimit": 20,
  "commitHash": "abc123",
  "listable": true,
  "updatedAt": "2026-01-15T12:34:56.000Z",
  "registry": {
    "verificationToken": "…",
    "verificationExpiresAt": "…"
  }
}
```

**Rules**
- Do **not** include per-player ids, names, positions, or any other PII.
- `playerCount`: `world.network.sockets.size`.
- `playerLimit`: from `world.settings.playerLimit` (or `null`).
- `title`, `description`, `imageUrl`: from world settings:
  - `title`: `world.settings.title`
  - `description`: `world.settings.desc`
  - `imageUrl`: `world.resolveURL(world.settings.image?.url)` (should be absolute if possible)
- `worldId`: `world.network.worldId`.
- `commitHash`: `process.env.COMMIT_HASH` (already used).
- `listable`: derived from env var (see below).
- `registry.verificationToken` should be present **only while token is valid** (during verification window).
- Set `Cache-Control: no-store` (recommended) to keep player counts reasonably fresh and avoid intermediary caching.

### 2) Keep `GET /health` as infra-friendly

File: `src/server/index.js`

Recommendation:
- `GET /health` should remain a very cheap “process is alive” check (no heavy world inspection).
- Update `Dockerfile` healthcheck to hit `/health` instead of `/status` (optional but cleaner).

### 3) Startup registration POST (world → registry)

Add a small registration client invoked after the server successfully starts listening.

**Where**
- `src/server/index.js` after `fastify.listen(...)` succeeds, or a small module imported from there (e.g. `src/server/registryClient.js`).

**Environment variables**
- `REGISTRY_ENABLED`:
  - default: `true`
  - when `false`: do not POST; `/status` returns `listable: false` and does not expose verification token.
- `REGISTRY_URL`:
  - base URL of registry service, e.g. `https://registry.hyperfy.xyz`
  - recommended: provide a default in code if product requires true opt-out (least friction), but document clearly.
- `REGISTRY_JOIN_URL` (optional override):
  - if set, used as join URL directly.
  - otherwise derived from `PUBLIC_API_URL` by stripping trailing `/api` (and optional trailing slash).

**Localhost skip**
- If join URL hostname is `localhost` or `127.0.0.1`, skip registration (and probably set `listable: false`).
- Also skip if join URL is not `https:` or if it includes a non-default port.

**Join URL derivation (recommended)**
1) If `REGISTRY_JOIN_URL` exists: use it.
2) Else:
   - parse `PUBLIC_API_URL` as URL
   - remove a trailing `/api` or `/api/` from its path
   - keep the remaining path (supports subpaths)
   - drop any query/hash
3) Normalize:
   - remove trailing `/` (except keep `/` for root)
   - require `https:` and no explicit port

**POST request**
- `POST ${REGISTRY_URL}/v1/servers/register`
- JSON body:
  - `joinUrl` (string; required)
  - `worldId` (string; optional but helpful)
  - `commitHash` (string; optional)
- Keep runtime work minimal:
  - one request on startup
  - short timeout (e.g. 5s)
  - optional: small retry loop (e.g. 2–3 attempts with backoff) only if desired for reliability

**Response**
- `verificationToken` (string)
- `verificationExpiresAt` (ISO string)

Store these in memory and expose in `/status` under `registry` until expiry.

---

## Registry Service (separate repo)

### Core endpoints

#### `POST /v1/servers/register`

Purpose: accept startup registrations.

Request:
```json
{ "joinUrl": "https://example.com/myworld", "worldId": "…", "commitHash": "…" }
```

Validation:
- `joinUrl` must be `https://`.
- No custom port.
- No fragments.
- SSRF guard: disallow IP literals; resolve DNS and disallow private/loopback/link-local ranges.

Response (202 or 200):
```json
{
  "verificationToken": "random-string",
  "verificationExpiresAt": "2026-01-15T12:40:00.000Z",
  "statusUrl": "https://example.com/myworld/status"
}
```

Behavior:
- Upsert by `joinUrl`.
- Generate a new token on each register call.
- Mark server as `pendingVerification`.
- Kick off async verification attempts (see below).

#### `GET /v1/servers` (public directory API)

Returns only online servers:
```json
{
  "servers": [
    {
      "joinUrl": "https://example.com/myworld",
      "worldId": "…",
      "title": "…",
      "description": "…",
      "imageUrl": "…",
      "playerCount": 3,
      "playerLimit": 20,
      "commitHash": "…",
      "lastSeenAt": "…"
    }
  ]
}
```

### Verification worker

After `register`:
- Attempt `GET statusUrl` immediately (and retry a few times within the verification TTL, e.g. 2 minutes total).
- Verification conditions:
  - HTTP 200
  - JSON parse success
  - `listable === true`
  - `registry.verificationToken === verificationToken` (exact match)
- On success:
  - mark `isOnline=true`, `verifiedAt=now`, `lastSeenAt=now`, reset failures
  - persist metadata from response
- On failure until TTL:
  - keep `pendingVerification`
- After TTL:
  - mark `isOnline=false` (not listed)

### Polling worker

Every 60s for currently-online servers:
- Fetch `GET statusUrl` with:
  - timeout: ~5s
  - redirect: disabled (prevent SSRF via redirects)
  - response body cap (prevent memory abuse)
- On success:
  - update metadata, `lastSeenAt`, reset failure count
  - if `listable === false`, delist immediately and stop polling (treat as offline/unlisted)
- On failure:
  - increment `consecutiveFailures`
  - if `consecutiveFailures >= 3`, mark offline and stop polling (until a new `register` happens)

### Data model (suggested)

Table: `servers`
- `joinUrl` (unique)
- `statusUrl`
- `worldId`
- `title`
- `description`
- `imageUrl`
- `playerCount`
- `playerLimit`
- `commitHash`
- `isOnline` (boolean)
- `lastSeenAt` (timestamp)
- `consecutiveFailures` (int)
- `verificationToken` (string, nullable)
- `verificationExpiresAt` (timestamp, nullable)
- `verifiedAt` (timestamp, nullable)
- `blacklistedAt` / `blacklistReason` (optional)

### Abuse controls (minimum viable)

- Rate-limit `POST /register` per source IP.
- Blacklist by:
  - `joinUrl` (exact match)
  - hostname
  - resolved IP ranges (block entire ASN/ranges if needed)
- Reject obviously bad metadata (length limits; strip control chars; restrict imageUrl scheme).
- SSRF protection:
  - Do not allow IP-literal hosts.
  - Resolve DNS and reject private/loopback/link-local.
  - Disable redirects.
  - Re-resolve periodically (DNS rebinding defense).

---

## Acceptance Criteria

### World server
- When started with a public `https` join URL and registry enabled, it POSTs once to the registry.
- `GET /status` returns only the minimal safe fields; no per-user data.
- When `REGISTRY_ENABLED=false`, the server does not POST, and `/status` reports `listable=false`.
- When started on `localhost`, the server does not POST.

### Registry
- A server is listed only after passing challenge verification.
- Registry updates `playerCount` via polling every 60s.
- Registry removes a server after 3 consecutive poll failures.
- Directory endpoint returns only online servers.

---

## Suggested Implementation Sequencing (PR-sized)

1) **Server: `/status` + `/health` reshaping**
   - Remove `connectedUsers` from `/status`.
   - Add `playerCount`, metadata fields, `listable`.
   - Optional: adjust Docker healthcheck to use `/health`.

2) **Server: startup registration client**
   - Add env vars.
   - Implement joinUrl derivation/validation.
   - Implement POST + token storage and temporary exposure in `/status`.

3) **Registry: register + verify + poll**
   - Implement `POST /v1/servers/register`.
   - Implement verification worker.
   - Implement polling worker + offline after 3 failures.
   - Implement `GET /v1/servers` directory API.

4) **Hardening**
   - SSRF guards, rate limiting, blacklist hooks, length limits.

---

## Testing Notes

World server:
- Unit tests for join URL derivation and validation.
- Integration test with a mock registry:
  - start server, capture POST
  - return token
  - assert `/status` contains token during TTL

Registry:
- Unit tests for joinUrl validation + SSRF guard logic.
- Integration test with a stub world server:
  - verify challenge success
  - polling success and failure transitions (offline after 3 failures)

