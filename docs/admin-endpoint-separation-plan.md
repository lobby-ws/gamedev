# Plan: Separate Admin Concerns From `/ws` via a New `/admin` Control Plane

## Summary

Today, world authoring (blueprint/entity mutations + asset uploads) is performed by “builder/admin” players over the same `/ws` channel used for normal gameplay networking. This couples admin privileges to the player networking stack, forces the dev `app-server` to piggyback on a browser client connection, and leaves uploads broadly accessible.

This plan introduces a new `/admin` control plane (WebSocket + HTTP) that is the *only* way to perform privileged world mutations and uploads. `/ws` remains the player networking plane, still distributing server-side changes to all players, but no longer accepting blueprint mutations from player clients.

Key requirements (from collaboration):
- All admin functionality/privileges must be through `/admin`.
- Use the existing admin code as the authentication secret:
  - WebSocket `/admin`: authenticate with the admin code.
  - HTTP `/admin/*`: admin code used as a “secret” checked against `ADMIN_CODE`.
- Players must **not** be able to modify blueprints via `/ws` anymore.
- Server → players propagation of blueprint/entity changes must continue to work.
- Uploads must be **admin-only** and handled by the new layer.
- `/admin` connections **do not** spawn player entities.
- Admins may still join the world via `/ws` like anyone else; their powers are via `/admin`.
- App-server should no longer require a browser client connection; it pushes changes directly to the world via `/admin`.
- App discovery/linking must be automated from world state (no “click to link” in the browser).
- App-server should support spawning (initial positions chosen by CLI).

Non-goals (explicit):
- Versioning refactor is out of scope; keep current version rules.
- Future “admin without player entity + free camera” is out of scope (but keep design extensible).

## Current Architecture (Relevant Pieces)

### Player networking (`/ws`)
- Route: `src/server/index.js` registers Fastify WS `GET /ws`.
- Server handler: `src/core/systems/ServerNetwork.js`:
  - Auth via `authToken` JWT in query.
  - Creates a `Socket` (`src/core/Socket.js`) and **spawns a player entity** on every connection (`ServerNetwork.onConnection()`).
  - Receives player messages mapped by `src/core/packets.js` into `onX()` methods.
  - Accepts and applies world mutations from builder players:
    - `onBlueprintAdded`, `onBlueprintModified`
    - `onEntityAdded`, `onEntityRemoved`
    - `onSettingsModified`, `onSpawnModified`
- Client: `src/core/systems/ClientNetwork.js`:
  - Sends mutations from in-world tooling (`world.network.send(...)`).
  - Uploads assets via `apiUrl` (`/api/upload-check`, `/api/upload`).

### Public uploads (`/api/upload*`)
- Routes: `src/server/index.js` defines:
  - `POST /api/upload`
  - `GET /api/upload-check`
- No authorization currently (any connected user can upload).

### Dev app-server (current)
- `app-server/server.js` + `src/core/systems/AppServerClient.js`:
  - Browser client connects to local dev server, links apps, and relays changes to the world via `/ws`.
  - Requires a browser client to be online for hot reload.

## Target Architecture

### `/ws` (player plane)
Responsibilities:
- Player simulation + gameplay networking.
- Receiving server snapshots and server-initiated world updates.
- Continues to *receive*:
  - `snapshot`, `blueprintAdded`, `blueprintModified`, `entityAdded`, `entityModified`, `entityRemoved`, etc.
- Must *not accept* world-authoring writes from player clients, especially blueprint mutation.

### `/admin` (control plane)
Responsibilities:
- All privileged world mutations:
  - Blueprint add/modify (required)
  - Entity add/remove/modify for world authoring (strongly recommended to fully separate concerns)
  - Settings/spawn writes (recommended; can be phased if needed)
- Moderation actions:
  - kick / mute
  - rank changes (`modifyRank`)
- Admin-only uploads:
  - Upload check
  - Upload file data
- Admin-protected world discovery reads (for app-server bootstrap)
- Supports app-server deployments and spawning without browser involvement.

Implementation shape:
- **WebSocket** endpoint at `GET /admin` for command messaging and optional server pushes (JSON messages).
- **HTTP** endpoints under `/admin/*` for uploads (multipart) and query-style operations.

## Authentication Model

### Source of truth
- `process.env.ADMIN_CODE`
- If `ADMIN_CODE` is empty/undefined, world is effectively unprotected (match current “everyone is admin” behavior).

### WebSocket `/admin`
- Must authenticate using the admin code before any privileged messages are processed.
- Recommended handshake:
  1. Client connects `ws(s)://<host>/admin`
  2. First message must be:
     ```json
     { "type": "auth", "code": "<ADMIN_CODE>", "networkId": "<optional ws user id>" }
     ```
  3. Server responds:
     - `{"type":"auth_ok"}`
     - or `{"type":"auth_error","error":"invalid_code"}` and closes.
- `networkId` is optional and should be used by *browser admins* to allow “ignore echo” semantics (see below).
- App-server can omit `networkId` (it has no `/ws` connection).

### HTTP `/admin/*`
- Use admin code as a shared secret.
- Require header: `X-Admin-Code: <ADMIN_CODE>` (or `Authorization: Bearer <code>`; pick one consistently).
- If `ADMIN_CODE` unset, accept requests without header.

Security notes:
- Avoid logging the admin code in access logs, query strings, or error messages.
- Prefer constant-time comparison for the secret check.

## Server Implementation Plan

### 1) Introduce `/admin` routes (new server module)

Add new module:
- `src/server/admin.js` (Fastify plugin)

Register it in:
- `src/server/index.js` (near `fastify.register(worldNetwork)`), passing references to:
  - `world`
  - `assets` (already initialized)

In `src/server/admin.js` implement:
- `GET /admin` (websocket: true)
  - Manages per-connection auth state.
  - Dispatches authenticated JSON messages to handlers.
- `GET /admin/upload-check?filename=...` (HTTP)
  - Auth via admin secret header.
  - Calls `assets.exists(filename)` and returns `{ exists }`.
- `POST /admin/upload` (HTTP multipart)
  - Auth via admin secret header.
  - Streams file, constructs `File`, calls `assets.upload(file)`.
  - Returns status payload (e.g., `{ ok: true, filename }`).

### 2) Refactor world mutation logic into internal “apply” functions

Problem: If `/admin` calls `world.blueprints.modify()` directly, blueprints will update in memory but **won’t be persisted** because `ServerNetwork.dirtyBlueprints` isn’t touched. Same for entities (`dirtyApps`) and spawn/settings persistence.

Solution:
- In `src/core/systems/ServerNetwork.js`, factor the current write handlers into reusable internal methods that:
  - apply mutation to world state
  - broadcast to `/ws` clients
  - mark dirty sets / persist config when applicable

Add internal methods (naming suggestion):
- `applyBlueprintAdded(blueprint, { ignoreNetworkId } = {})`
- `applyBlueprintModified(change, { ignoreNetworkId } = {})`
  - Should preserve existing version gate behavior:
    - allow if `change.version > current.version`
    - else: send revert (`blueprintModified` with full blueprint) to `ignoreNetworkId` (if provided) and return `{ ok:false, error:"version_mismatch" }`
- `applyEntityAdded(entityData, { ignoreNetworkId } = {})`
- `applyEntityModified(entityChange, { ignoreNetworkId } = {})`
- `applyEntityRemoved(entityId, { ignoreNetworkId } = {})`
- `applySettingsModified({ key, value }, { ignoreNetworkId } = {})` (optional in phase 1)
- `applySpawnModified(opOrData, { ignoreNetworkId } = {})` (optional in phase 1)

Then:
- Keep existing `/ws` methods as thin wrappers (or turn them into “reject” stubs; see next step).
- `/admin` handlers should call these `apply*` methods.

### 3) Disable blueprint mutation from `/ws`

Hard requirement: players cannot modify blueprints via regular systems.

In `src/core/systems/ServerNetwork.js`:
- Change `onBlueprintAdded` and `onBlueprintModified` to reject unconditionally (or gate behind a “legacy” flag if needed for transition).
  - Recommended behavior:
    - log a short warning
    - optionally send a `chatAdded` or `command` failure event (not required)
    - do **not** apply mutation
    - do **not** broadcast
- Do *not* remove `blueprintAdded`/`blueprintModified` from `src/core/packets.js` (server → client still needs them).

Recommended (for true separation of admin concerns; can be phased):
- Similarly disable from `/ws`:
  - `onEntityAdded`, `onEntityRemoved`, `onSettingsModified`, `onSpawnModified`
  - and move their functionality to `/admin` instead.

This yields: `/ws` only handles player-state and gameplay messages (chat, entityEvent, etc), while `/admin` handles world-authoring writes.

### 4) Move uploads to `/admin` and make them admin-only

In `src/server/index.js`:
- Remove `POST /api/upload` and `GET /api/upload-check`, or replace them with:
  - `401/403` responses pointing to `/admin/*` (optional).
- Ensure no other code path exposes upload without admin auth.

Client snapshot/env considerations:
- Today `ClientNetwork.upload()` uses `snapshot.apiUrl` which is `PUBLIC_API_URL` (defaults to `http://localhost:3000/api`).
- After moving upload endpoints, introduce a distinct admin base URL:
  - Add env: `PUBLIC_ADMIN_URL=http://localhost:3000` (or `.../admin` if preferred)
  - Include it in snapshot: `adminUrl`
  - Keep `apiUrl` for any remaining public endpoints (or keep but unused)

### 5) Add `/admin` world-authoring endpoints and message protocol

Minimum JSON message types over `/admin` WS:
- `auth`
- `blueprint_add`
- `blueprint_modify`
- `entity_add`
- `entity_modify`
- `entity_remove`
- `settings_modify` (optional in phase 1)
- `spawn_modify` (optional in phase 1)
- `kick`
- `mute`
- `modify_rank`

Phase 3 also adds admin-protected read APIs (HTTP) for discovery/bootstrap:
- `GET /admin/snapshot` (minimum)

Each message should allow:
- `networkId` (optional): `/ws` socket id to ignore echo and to target revert responses.
  - Server uses this for `ignoreNetworkId` on broadcasts.

Example: blueprint modify
```json
{
  "type": "blueprint_modify",
  "networkId": "player-socket-id",
  "change": { "id": "bpId", "version": 12, "script": "asset://..." }
}
```

Server responses:
- Ack: `{"type":"ok","requestId": "...", "result": {...}}` (if you add requestIds)
- Error: `{"type":"error","error":"version_mismatch","current": { ...blueprint } }`

Tip: add an optional `requestId` to every message so app-server can correlate acks; browser UX can ignore it.

## Client Implementation Plan (Browser World)

### 1) Add a client-side `/admin` transport system

Add new system:
- `src/core/systems/AdminClient.js` (client-only)

Responsibilities:
- Maintain a WS connection to `/admin`.
- Store admin code (in `src/core/storage.js`, similar to `authToken`).
- Provide high-level methods used by authoring UI:
  - `admin.upload(file)` → uses `adminUrl` + `/admin/upload-check` + `/admin/upload`
  - `admin.blueprintAdd(blueprint, { ignoreNetworkId })`
  - `admin.blueprintModify(change, { ignoreNetworkId })`
  - `admin.entityAdd(entityData, { ignoreNetworkId })`
  - `admin.entityModify(change, { ignoreNetworkId })`
  - `admin.entityRemove(id, { ignoreNetworkId })`
- Provide state flags:
  - `connected`, `authenticated`, `error`
  - so UI can gate authoring tools

World integration:
- Register it in `src/core/World.js` for client worlds only (or in `createClientWorld` setup).
- Connect on world ready if admin code is present in storage.

### 2) Remove blueprint mutation from regular client systems

Replace any direct `/ws` blueprint mutation sends with `/admin` calls:
- `src/client/components/Sidebar.js`:
  - `changeModel()` currently:
    - hashes file, uploads via `world.network.upload`
    - `world.blueprints.modify(...)`
    - `world.network.send('blueprintModified', ...)`
  - New flow:
    - require admin session
    - hash + `world.admin.upload(file)`
    - optimistic local `world.blueprints.modify(...)`
    - send `blueprint_modify` via `/admin` with `networkId=world.network.id`
- `src/client/components/ScriptEditor.js`:
  - same change (script upload + blueprint modification goes through `/admin`)
- Any other UI that calls `world.network.send('blueprintModified'| 'blueprintAdded')` must be migrated similarly.

Also update:
- `src/core/systems/ClientBuilder.js`:
  - blueprint creation + entity spawning should use `/admin` rather than `/ws`.
  - preserve current UX by optimistic local add + ignore echo using `networkId`.

Important: because `/ws` no longer accepts blueprint writes, leaving any old call sites will break authoring.

### 3) Uploads become admin-only

Replace `world.network.upload(file)` usage with `world.admin.upload(file)` in authoring paths, including:
- `src/core/systems/ClientBuilder.js` (models/avatars)
- `src/client/components/Sidebar.js` (model change, prop file uploads if any)
- `src/client/components/ScriptEditor.js`
- `src/core/systems/AppServerClient.js` (likely deprecated; see below)

For non-admins:
- disable UI affordances, or show a clear error (“Admin required to upload assets”).

### 4) Preserve server → player propagation

No changes required to the client receive path:
- `ClientNetwork.onBlueprintAdded/onBlueprintModified` already applies server broadcasts.
- This is how admin-driven updates reach all players.

## World Discovery + Local Mapping (for App-Server Automation)

Goal: app-server can connect to a world with *no* pre-existing local state (empty folder) and automatically bootstrap a local workspace for every app in that world.

First-principles approach:
- The world’s authoritative state is already present in `{ entities, blueprints }`.
- “Linking” for app-server is therefore *local mapping* from `blueprint.id` → local folder, derived from that state (no browser relay, no manual “click to link”, and no required in-world dev metadata).
- Optional future extension: add a `dev` object on blueprints to aid filtering/stable naming. Not required to satisfy “empty folder → link everything”.

Local state:
- `world.json` is the source-of-truth link map for the app-server workspace.
  - Keys by `blueprint.id`, values point to local app folders and last-seen versions.
  - Folder naming can remain human-friendly even if blueprint names change over time.

Server support needed (admin-protected reads, no `/ws` join):
- `GET /admin/snapshot` (HTTP, auth via `X-Admin-Code`)
  - returns `{ assetsUrl, settings, spawn, blueprints, entities }` (same shape as `/ws` snapshot minus player-only fields)
  - does **not** spawn a player entity
- Admin WS server pushes (for active pull):
  - `blueprintAdded`, `blueprintModified`
  - `entityAdded`, `entityModified`, `entityRemoved`
- Optional (nice-to-have):
  - `GET /admin/blueprints/:id` (single blueprint fetch)
  - `GET /admin/entities?type=app` (filtered entities)

## App-Server Plan (Direct `/admin`, World-First Sync)

### Goal
- App-server connects directly to the world via `/admin` (no browser relay, no localhost dependency).
- First run with an empty working directory auto-imports and “links” *all* world blueprints (apps + unused + `$scene`) into local `apps/`.

### 1) Configuration (env-first)
App-server should read:
- `WORLD_URL` (base world URL, e.g. `http://localhost:3000`)
- `ADMIN_CODE` (optional if the world is unprotected)
- Optional: `APPS_DIR` (default `./apps`)

### 2) Connect directly to `/admin`
- WS: `ws(s)://<WORLD_URL>/admin`
  - send `{ "type": "auth", "code": "<ADMIN_CODE>" }`
- HTTP uploads/reads:
  - `X-Admin-Code: <ADMIN_CODE>` on `/admin/*` requests

### 3) First-run bootstrap: empty folder → import everything
Trigger condition (first connect):
- `apps/` is missing or empty.

Import algorithm:
1. Fetch `GET /admin/snapshot`.
2. Determine the “blueprints to import” set (per goal):
   - Import **all** blueprints from `snapshot.blueprints`, including unused blueprints and `$scene`.
   - Also union in any blueprint IDs referenced by `snapshot.entities` where `type === "app"` (sanity check; should already be covered).
3. Initialize `world.json` (new source-of-truth mapping), keyed by `blueprint.id`.
   - Example shape:
     ```json
     {
       "worldUrl": "http://localhost:3000",
       "assetsUrl": "http://localhost:3000/assets",
       "blueprints": {
         "$scene": { "appName": "The Grid", "version": 12 },
         "8c9d...": { "appName": "My App", "version": 3 }
       }
     }
     ```
4. For each blueprint:
   - Choose a human-friendly local folder name:
     - Prefer `apps/<sanitized blueprint.name>/`
     - If a collision occurs, append a deterministic suffix (e.g. `__<idPrefix>`) to keep names readable.
   - Write/update `world.json` entry `{ appName, version }` for this `blueprint.id`.
   - Create `apps/<appName>/` with:
     - `blueprint.json` containing defaults used for deploy (`name`, `model`, `props`, flags, etc)
     - `index.js` containing script code:
       - if `blueprint.script` is `asset://<hash>.js`, download from `assetsUrl` and write it
       - if missing, write a stub script (still deployable)
   - Download referenced assets (match current app-server behavior):
     - model (`blueprint.model`)
     - props file URLs (`blueprint.props.*.url`)
     - image (if stored as an asset URL)
     - any other `asset://...` fields used by deploy
     - save into the central `assets/` folder with stable, human-ish names where possible (as today)
     - update `blueprint.json` defaults to point at the local `assets/...` paths (as today)
5. Do not overwrite existing local files unless `--force` (or a dedicated `sync` command).
6. Bootstrap should be read-only with respect to the world: it should *not* create/modify blueprints/entities just to establish links.

### 4) Continuous sync (no browser required)
After bootstrap (or on any normal run), app-server should keep itself in sync in both directions.

World → local (active pull):
- Connect to `/admin` WS and receive server pushes for blueprint/entity changes.
  - When a blueprint changes, update `world.json` version, update `apps/<appName>/blueprint.json`, and download any newly referenced `asset://...` content from `assetsUrl` (script/model/props/image), updating local files.
  - Mark these as “server-sourced” updates to avoid triggering a deploy loop from file watchers.

Local → world (deploy):
- Watch `apps/**/index.js`, `apps/**/blueprint.json`, and referenced local `assets/**`.
- On change:
  1. Upload new/changed assets via `/admin/upload-check` + `/admin/upload`.
  2. Send `/admin` mutations (`blueprint_modify`, and entity mutations if needed).
  3. If the server responds `version_mismatch`, treat local as source-of-truth:
     - fetch current blueprint (`GET /admin/blueprints/:id` or `/admin/snapshot`)
     - resend with `version: current.version + 1`, overwriting world with local state.

### 5) Creating/spawning still works (but no longer required for linking)
Add CLI actions that operate via `/admin`:
- `app-server create <appName>`: creates a local folder + creates a blueprint in-world (and optionally spawns an entity).
- `app-server spawn <appName> --pos x,y,z --yaw deg`: adds an entity instance for a linked blueprint.

### 6) Deprecate the browser relay path
Once direct-admin app-server is working:
- Remove/disable `src/core/systems/AppServerClient.js` and any “click to link” UI.
- Keep a temporary legacy flag only if needed for transition.

## Migration / Rollout Strategy

### Phase 1 (minimal, meets hard requirements)
- Add `/admin` WS + `/admin/upload*` HTTP with admin code auth.
- Add internal `applyBlueprint*` methods and mark dirty correctly.
- Disable `/ws` blueprint add/modify handlers.
- Update browser tooling (ScriptEditor + model change paths) to use `/admin` for blueprint updates and `/admin/upload*` for uploads.
- Add server → client reversion logic on version mismatch (via `/ws` targeted send).

Acceptance:
- Players cannot persist blueprint changes via `/ws`.
- Admin can modify blueprint via `/admin` and all connected players receive updates.
- Non-admin cannot upload (401/403).

### Phase 2 (complete separation for authoring)
- Move entity add/remove/modify, settings, spawn from `/ws` to `/admin`.
- Move moderation actions (kick/mute/modifyRank) from `/ws` to `/admin`.
- Update ClientBuilder and Add panel flows to use `/admin`.

Acceptance:
- `/ws` is “gameplay only”; authoring writes use `/admin`.

### Phase 3 (app-server direct deploy + auto-link)
- Add admin-protected read APIs for app-server bootstrap (`GET /admin/snapshot` minimum).
- Update app-server to connect directly to world `/admin` using `WORLD_URL` + `ADMIN_CODE` (no browser relay, no localhost coupling).
- On first run with an empty folder, auto-import and “link” *all* blueprints from the world (apps + unused + `$scene`) into local `apps/`, persisting mapping in `world.json` keyed by `blueprint.id`.
- Actively pull remote changes over `/admin` and keep the local workspace updated (including downloading referenced assets).
- Watch local files and deploy changes via `/admin` (upload + blueprint/entity mutations); on version conflict, local overwrites world.
- Remove/disable browser-side linking (`AppServerClient`) and any UI that exists only for relay.

Acceptance:
- Starting app-server with an empty folder produces local folders for every world blueprint (including `$scene`), with scripts/assets downloaded and `world.json` mapping persisted.
- Editing a local app updates the world via `/admin` with no browser client connected.
- Remote blueprint changes propagate to local files without a browser client connected.
- App-server does not need to connect to `/ws` (no player entity spawned) to function.

## Testing / Validation Checklist

Manual tests (recommended order):
1. Start server with `ADMIN_CODE=secret`.
2. Join world as normal player:
   - attempt to trigger any blueprint modification path → should fail (no persistence, or server rejects).
3. Attempt upload without admin secret:
   - `POST /admin/upload` → 401/403.
4. Connect admin client (browser) to `/admin` with correct code:
   - change script via ScriptEditor:
     - asset upload succeeds
     - blueprint version increments on server
     - other players receive `blueprintModified`
5. Version mismatch:
   - two admin clients edit same blueprint; one should receive a revert (current blueprint) and an admin error response.
6. App-server:
   - start app-server in direct mode
   - modify local `index.js` and verify players receive update without browser relay.

## Future Extensions (Not in Scope)
- Replace versioning semantics (server-assigned versions, conflict-free edits, etc).
- Replace admin-as-player with admin control connections that pilot a free camera and don’t create player entities.
