# World Seed Manifest + Blueprint Library Paradigm (Handoff Plan)

This document is a detailed implementation plan for shifting Hyperfy’s project/app-server paradigm to:

- `world.json` is a **seed manifest** (entities + settings + spawn) and is **live-synced**.
- “Templates” are **the world’s registered blueprints** (including unspawned ones), not a hardcoded client list.
- Local apps support **multiple blueprints per shared script** (a.k.a. “brother apps” / variants).
- Safety against “wrong WORLD_URL” comes from a **persistent `worldId` stored in the world DB**, matched against `.env WORLD_ID`.
- Cleaner no longer deletes blueprints; assets referenced by **any blueprint** are retained.

---

## Goals

1) `world.json` becomes the **authoritative world layout** for a project:
   - Includes: **app entities**, **world settings**, **spawn**.
   - Excludes: blueprint data (blueprints come from `apps/**`).
   - Is updated automatically from world state and can be edited locally to drive world changes (exact sync).

2) Registered blueprints become the **authoring “template library”**:
   - Client “Add” UI lists world blueprints (excluding `scene: true`) and spawns entities from those.
   - Blueprints can exist without any spawned entities.

3) Local app folder can define multiple blueprints:
   - `apps/<appName>/index.js` is the shared script.
   - Every `apps/<appName>/*.json` is a blueprint definition for that script (e.g. `zombie.json`, `skeleton.json`).

4) Safety: app-server must refuse to sync/deploy if connected to the wrong world:
   - The world server persists `worldId` in DB config.
   - app-server compares DB `worldId` vs local `.env WORLD_ID`.

5) Cleaning:
   - Cleaner does **not** delete blueprints.
   - Cleaner keeps assets referenced by **all blueprints** (spawned or unspawned), plus user/settings assets.

---

## Non-goals (for this iteration)

- Full in-world blueprint editing UI (editing is “through app-server” first).
- Renaming blueprint IDs in-place (entity references make this non-trivial); migration path is export/import into a new/wiped world.
- Multi-project sharing of a single world (the handshake is explicitly designed to prevent accidental cross-writes).

---

## Glossary

- **Project directory**: user workspace folder containing `apps/`, `assets/`, `world.json`, `.env`.
- **World server runtime directory**: e.g. `~/.hyperfy/<WORLD_ID>` for local worlds; contains DB, storage, assets cache.
- **Blueprint**: the template/config for an app entity (stored in DB; represented locally as JSON files under `apps/**`).
- **App entity**: a spawned instance in the world; references a blueprint by ID.
- **App-server**: the sync agent connecting to `/admin` (no browser relay).

---

## Local File Layout (Project)

```
.env
world.json
apps/
  model/
    index.js
    model.json
  mob/
    index.js
    zombie.json
    skeleton.json
assets/
  ...
```

### Blueprint file conventions

- Script: `apps/<appName>/index.js` (or `index.ts` if supported; current app-server supports both).
- Blueprint definitions: **any** `apps/<appName>/*.json` (directly under the folder) are considered blueprint configs.
  - Reserve/exclude a small denylist to avoid accidentally treating tool config files as blueprints:
    - `package.json`, `tsconfig.json`, `jsconfig.json` (extend only if necessary).

### Blueprint ID derivation (canonical)

Given:
- `appName` = folder name under `apps/`
- `fileBase` = json filename without extension

Rules:
- If `fileBase === appName`, then `blueprint.id = fileBase` (e.g. `apps/model/model.json` → id `model`).
- Else `blueprint.id = ${appName}__${fileBase}` (e.g. `apps/mob/zombie.json` → id `mob__zombie`).

Derived display name:
- `blueprint.name = fileBase` (exactly; no humanization).

Parsing blueprint IDs back to local paths:
- If `id` contains `__`: `appName = prefix`, `fileBase = suffix`.
- Else: `appName = id`, `fileBase = id`.
- Special case: `$scene` is a reserved blueprint ID and uses the “no `__`” rule:
  - Stored on disk as `apps/$scene/$scene.json` with `index.js` in the same folder.

---

## `world.json` Manifest Schema (v2)

`world.json` is **live-synced** and is treated as **authoritative** when edited locally.

### Shape

```jsonc
{
  "formatVersion": 2,
  "settings": {
    "title": null,
    "desc": null,
    "image": null,
    "avatar": null,
    "customAvatars": false,
    "voice": "spatial",
    "rank": 0,
    "playerLimit": 0,
    "ao": true
  },
  "spawn": {
    "position": [0, 0, 0],
    "quaternion": [0, 0, 0, 1]
  },
  "entities": [
    {
      "id": "A_ENTITY_ID",
      "blueprint": "mob__zombie",
      "position": [0, 0, 0],
      "quaternion": [0, 0, 0, 1],
      "scale": [1, 1, 1],
      "pinned": false,
      "state": {}
    }
  ]
}
```

### Notes

- `entities` includes **app entities only** (`type === "app"`), including the `$scene` app entity if present.
- Omit runtime-only fields from entities:
  - `mover`, `uploader` are not persisted in `world.json`.
- `settings` uses the same shape as `world.settings.serialize()` (`src/core/systems/Settings.js`).
- `spawn` uses `{ position, quaternion }` (matches server network spawn config).
- `formatVersion` enables safe migration from the old `world.json` link-map format.

---

## Safety Handshake: Persistent `worldId`

### Requirements

- `.env` contains `WORLD_ID` (project’s expected world ID).
- World DB contains `config.worldId` (persistent; stable across wipes if the same `.env WORLD_ID` is used).

### Enforcement

- app-server reads `worldId` from `/admin/snapshot` (add this field).
- app-server refuses to sync/deploy if:
  - `.env WORLD_ID` is missing, or
  - remote `snapshot.worldId !== process.env.WORLD_ID`.

This prevents accidental use of the same project folder against a different world.

---

## Sync Model (High Level)

app-server becomes a bidirectional sync agent:

### World → Disk

- Blueprints:
  - Download to `apps/**` (script to `index.js`, config to `*.json`).
  - Download referenced assets into `assets/` and rewrite blueprint config URLs to `assets/...`.
- App entities/settings/spawn:
  - Write to `world.json` continuously (live sync).

### Disk → World

- Blueprints:
  - For every local blueprint file, create/update the world blueprint (id/name derived from path).
  - Script is always the shared `apps/<appName>/index.js` uploaded to `asset://<hash>.js`.
  - Upload/resolve any referenced local `assets/...` paths to `asset://...`.
- World layout:
  - When `world.json` changes on disk, apply it to the world with **exact semantics**:
    - Create missing entities, update existing entities by `id`, remove world entities not in the manifest.
    - Apply settings and spawn to match the manifest.

### Loop prevention

- Maintain an internal “pendingWrites” set (existing pattern in `app-server/direct.js`) so that:
  - writes caused by remote sync do not trigger immediate deploy back to the world.

---

## Deterministic Startup Behavior (Avoid “Overwrite” Surprise)

To avoid overwriting an existing world when a project folder is empty/uninitialized:

1) Connect to world and validate `worldId` handshake.
2) Determine project readiness:
   - If **no `world.json` and no `apps/`**: treat as bootstrap-from-world:
     - Export world state to `world.json`
     - Export blueprints to `apps/**`
     - Download referenced assets to `assets/`
     - Do **not** write back to world.
   - If **`world.json` exists** (regardless of `apps/`): enable full bidirectional sync and allow `world.json` to drive the world.
   - If **`apps/` exists but `world.json` is missing**: refuse to start syncing with a clear error:
     - “`world.json` missing; cannot safely apply exact world layout. Run `hyperfy world export` to generate it from the world, or create `world.json` to seed a new world.”

Rationale:
- Exact world sync is destructive by design; requiring `world.json` avoids accidental deletion.

---

## Server Changes

### 1) DB migration: persist `worldId`

Add a new migration in `src/server/db.js` that:

- Reads `config.worldId`.
- If missing:
  - If `process.env.WORLD_ID` exists: set `config.worldId = WORLD_ID`.
  - Else generate a new random ID and persist it.

Recommended generation:
- reuse the CLI nanoid alphabet

Optional hardening (recommended):
- If `config.worldId` exists and `process.env.WORLD_ID` exists but differs:
  - Fail fast on server boot (or log loudly and refuse admin writes). This prevents misconfigured world runtime dirs.

### 2) Include `worldId` in `/admin/snapshot`

Modify `src/server/admin.js` `/admin/snapshot` response to include:

- `worldId`: value from `config.worldId`

This is required for app-server handshake.

### 3) Add “set spawn explicitly” admin operation

`world.json` stores explicit spawn; current WS op `spawn_modify` supports `set`/`clear` but not explicit coordinates.

Implement:

- `ServerNetwork.applySpawnSet({ position, quaternion })`:
  - Validates arrays.
  - Sets `this.spawn = { position, quaternion }`.
  - Upserts `config.spawn = JSON.stringify(this.spawn)`.
  - Broadcasts `spawnModified` appropriately (admin broadcast, plus `/ws` if needed).

Expose via admin API (pick one; HTTP is easiest for app-server):

- `PUT /admin/spawn` body `{ position, quaternion }` → calls `applySpawnSet`.

### 4) Blueprint deletion API (admin-only)

Needed for “trash icon” in the Add/templates UI.

Implement:

- `ServerNetwork.applyBlueprintRemoved({ id })`:
  - Reject if blueprint not found.
  - Reject if any app entity references `blueprint === id` (`error: in_use`).
  - Remove blueprint from `world.blueprints.items`.
  - Delete row from DB `blueprints` table.
  - Broadcast `blueprintRemoved` (new packet) to admins/clients so UIs update.

Expose via `/admin`:

- WS message type `blueprint_remove` (consistent with existing WS ops), and/or
- `DELETE /admin/blueprints/:id` (HTTP).

Add packet types:
- Add `blueprintRemoved` to `src/core/packets.js` allowlist and client handlers.

### 5) Cleaner changes (`src/server/cleaner.js`)

Update cleaning policy:

- Do **not** delete unreferenced blueprints.
- When computing `assetsToKeep`, include assets referenced by **all blueprints in DB**, not only those referenced by entities.
  - Keep existing retention for user avatars and settings assets.

This ensures:
- Unspawned templates are retained.
- Their referenced assets are retained.

---

## App-server Changes (Direct `/admin`)

### 1) Replace old `world.json` semantics

Today: `world.json` is a blueprintId→folder link map.

New: `world.json` is a versioned manifest (`formatVersion: 2`) for:
- settings
- spawn
- app entities

Implementation:
- Add a `WorldManifest` helper in `app-server/` that:
  - Reads/writes `world.json`.
  - Validates schema.
  - Detects old format and errors with migration instructions (or auto-migrates via export).

### 2) Index local blueprints

Build an in-memory index from disk:

- Enumerate `apps/<appName>/index.js|index.ts`.
- Enumerate blueprint files: `apps/<appName>/*.json` excluding denylist.
- For each blueprint file:
  - `fileBase = basename(file)`
  - `id = deriveBlueprintId(appName, fileBase)`
  - `name = fileBase`
  - `configPath = .../fileBase.json`
  - `scriptPath = .../index.js|ts`

### 3) Deploy local blueprints to the world (create/update ALL)

For each local blueprint:

1) Compute script asset:
   - Hash script content → `asset://<hash>.js`.
   - Upload via `/admin/upload-check` + `/admin/upload` (already implemented).

2) Build world blueprint payload:
   - `id` from rules above.
   - `name = fileBase`.
   - `script = asset://<hash>.js`.
   - Load config JSON and copy allowed blueprint fields:
     - `model`, `image`, `props`, `preload`, `public`, `locked`, `frozen`, `unique`, `scene`, `disabled`, `author`, `url`, `desc`.
   - Resolve any local `assets/...` URLs to `asset://...` by uploading.

3) Upsert logic:
   - If blueprint does not exist → `blueprint_add` with `version: 0`.
   - If exists:
     - Compare computed payload (excluding `version`) to remote.
     - If different, `blueprint_modify` with `version = remote.version + 1`, handle `version_mismatch` by refetching and retrying.

Script sharing behavior:
- When `apps/<appName>/index.js` changes, redeploy **all** blueprints under that folder (they share the script).
- When `apps/<appName>/<fileBase>.json` changes, redeploy only that blueprint (but the script hash is still used for its `script` field).

### 4) Export remote blueprints to disk

On bootstrap-from-world and on remote blueprint changes:

- Determine local destination from blueprint ID:
  - `appName/fileBase` derived from ID parse rules.
  - Ensure folder exists, and ensure `index.js` exists.
- Write blueprint config file omitting:
  - `id`, `version`, `script`, `name`
- Download referenced assets into `assets/` and rewrite URLs to `assets/...` (reuse existing asset download logic in `direct.js` but adjust output format).
- Download script:
  - If `asset://...`, download from `assetsUrl` and write to `apps/<appName>/index.js`.
  - If inline, write inline string.

Handling “multiple blueprints share same script” for world→disk:
- Primary grouping is implicit in the ID scheme (namespace prefix before `__`).
- Legacy IDs without `__` group to `apps/<id>/`.
- If you encounter a non-conforming ID but shared script URL suggests grouping, do not attempt to re-home automatically in v1; keep ID-derived folder to avoid surprises.

### 5) Live-sync `world.json` from world state (app entities/settings/spawn)

Subscribe to admin WS events:
- `entityAdded`, `entityModified`, `entityRemoved`
- `settingsModified` (if applicable in admin channel)
- `spawnModified` (if applicable in admin channel)

Maintain a cached snapshot of current world state:
- Filter to app entities only.
- Write `world.json` (debounced) to match:
  - `settings` (serialized)
  - `spawn`
  - `entities` (only fields: `id`, `blueprint`, `position`, `quaternion`, `scale`, `pinned`, `state`)

### 6) Apply `world.json` edits to the world (EXACT)

Watch `world.json` for changes (and ignore writes initiated by app-server itself).

When changed and valid:

1) Apply settings:
   - Diff `manifest.settings` vs `snapshot.settings`.
   - For each changed key, send admin WS `settings_modify` `{ key, value }`.

2) Apply spawn:
   - If manifest differs from snapshot, call explicit spawn set:
     - `PUT /admin/spawn` with `{ position, quaternion }`.

3) Apply entities EXACT:
   - Desired: map by `id` from `manifest.entities`.
   - Current: app entities from snapshot.
   - For each desired entity:
     - If missing → `entity_add` with `type: "app"` and required fields.
     - If present → `entity_modify` with only changed fields.
   - For each current entity not in desired → `entity_remove`.

Order constraint:
- Ensure blueprints are present/up-to-date before adding entities that reference them.

Conflict rule:
- Local `world.json` is authoritative; last-writer-wins.

### 7) `hyperfy world export/import` (reusing app-server logic)

Expose explicit commands in the CLI to:

- `hyperfy world export`:
  - Pull snapshot.
  - Export `world.json` + `apps/**` + assets.
- `hyperfy world import`:
  - Push `apps/**` blueprints (create/update ALL).
  - Apply `world.json` EXACT.

Even with auto-apply enabled, these commands provide an explicit workflow for users and help with migration.

---

## Client Changes (Templates = Blueprints)

### 1) Replace hardcoded templates list

Remove `src/client/builtinApps.js` usage from `src/client/components/Sidebar.js` Add pane.

New behavior:

- Show templates = all blueprints where `scene !== true`.
- Clicking a template:
  - Spawn a new app entity referencing that blueprint ID.
  - Do **not** create a new blueprint.

### 2) Delete template (blueprint) UI

Add a “Trash mode” toggle in the Add pane:

- When enabled, clicking a blueprint opens a confirmation dialog:
  - “Delete blueprint `<name>`? This cannot be undone.”
- On confirm:
  - Call new admin operation `blueprint_remove`.
  - If server returns `in_use`, show error: “Cannot delete blueprint: there are spawned entities using it.”

### 3) In-world duplication for `unique` blueprints (ID scheme)

Currently, duplicating a `unique` blueprint generates a UUID id. This must change.

Update blueprint duplication in:
- `src/core/systems/ClientBuilder.js` (duplicate + unlink paths)
- Any other blueprint cloning call sites

New ID generation:

- Parse source blueprint ID into `{ namespacePrefix, base }`:
  - If `id` contains `__`: `namespacePrefix = "<appName>__"`, `base = "<fileBase>"`
  - Else: `namespacePrefix = ""`, `base = id`
- Find the first available suffix:
  - `${namespacePrefix}${base}_2`, `_3`, … such that `world.blueprints.get(candidateId)` is null.
- Set:
  - `blueprint.id = candidateId`
  - `blueprint.name = baseWithSuffix` (without namespace prefix)

This ensures:
- No ID collisions.
- app-server can place the new blueprint JSON into the same folder as the original (shared script).

---

## CLI Changes

### 1) Local world detection

Decision: local vs remote mode is determined by `WORLD_URL` host only (no `WORLD_ID` prefix rules).

Update `bin/hyperfy.mjs`:
- `isLocalWorld(...)` should only check whether `WORLD_URL` points at a local/LAN host.
- Keep using `.env WORLD_ID` for world runtime directory `~/.hyperfy/<WORLD_ID>`.

### 2) Add world export/import commands

Add:
- `hyperfy world export`
- `hyperfy world import`

Both:
- Require `WORLD_URL`, `ADMIN_CODE` (if protected), and `WORLD_ID`.
- Validate remote `worldId` handshake.

---

## Backwards Compatibility / Migration Notes

### Old `world.json` format

Old app-server format:
```jsonc
{ "worldUrl": "...", "assetsUrl": "...", "blueprints": { "<id>": { "appName": "...", "version": 0 } } }
```

New format is incompatible.

Plan:
- Detect old format and refuse to run with clear instructions:
  - “Run `hyperfy world export` to regenerate `world.json` (formatVersion 2).”
- Optionally implement an automatic migration that:
  - Renames old file to `world.json.bak`
  - Exports the new manifest from the connected world

### Existing worlds with UUID blueprint IDs

This plan does not rename blueprint IDs in-place.

Migration path:
- Export from legacy world to disk, then import into a fresh/wiped world to get clean IDs (or keep legacy IDs as filenames, if acceptable).

---

## Acceptance Criteria (Manual)

1) **Fresh local world seed**
   - Wipe local world runtime directory.
   - Start `hyperfy start` in a project with configured `apps/**` and `world.json`.
   - Result: world DB is populated with all local blueprints, and entities/settings/spawn match `world.json` exactly.

2) **Existing world bootstrap (no overwrite)**
   - Start app-server in an empty project folder with `.env` pointing at a populated world (matching `WORLD_ID`).
   - Result: app-server writes `world.json` and downloads `apps/**` and `assets/**` from the world; does not apply writes back immediately.

3) **Wrong world protection**
   - Point a project at a different world URL with a different DB `worldId`.
   - Result: app-server refuses to sync/deploy and prints both IDs.

4) **Templates = blueprints**
   - In client UI Add pane, templates list equals all non-scene blueprints.
   - Adding spawns an entity referencing an existing blueprint (no new blueprint creation).

5) **Delete blueprint**
   - Attempt to delete a blueprint that is in use → error `in_use`.
   - Delete an unused blueprint → blueprint disappears from UI and DB row is removed.

6) **Variants / shared script**
   - `apps/mob/index.js` plus `zombie.json` and `skeleton.json` results in two blueprints with the same script asset.
   - Editing `index.js` redeploys both.
   - Editing `zombie.json` redeploys only `mob__zombie`.

7) **Cleaner retention**
   - With `CLEAN=true`, unspawned blueprints remain.
   - Assets referenced by unspawned blueprints remain.

---

## Suggested Rollout Phases

1) **Server foundations**
   - DB migration for `worldId`
   - `/admin/snapshot` includes `worldId`
   - Spawn explicit set endpoint
   - Blueprint remove endpoint + packet
   - Cleaner behavior changes

2) **App-server refactor**
   - New `world.json` manifest format + schema validation
   - Disk blueprint indexing (multi-blueprint per folder)
   - Full blueprint upsert from disk (create/update ALL)
   - World export to disk
   - Live sync `world.json` from entity/settings/spawn changes
   - Apply local `world.json` edits EXACT

3) **Client UI changes**
   - Add pane uses world blueprints, not builtin templates
   - Delete UI and wiring
   - Update unique duplication ID scheme

