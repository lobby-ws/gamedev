# World Project Mods Parity Plan

Status: Proposed  
Last Updated: 2026-02-09

## Locked Decisions

- Remote worlds must support mods.
- Hot reload for remote mods is not required.
- Mod deploy + world server restart is acceptable and expected.
- Behavior should match the old `.worktrees/mods` patch semantics.
- System mods are first-class systems (same lifecycle as native systems).
- Mod systems load after core systems.
- Mod-to-mod order is controlled by `mods/load-order.json` or DB override.
- Mods deployment is a separate command (not merged into apps deploy).
- Old UI mods are included (`components` + `sidebar` parity).

## Target World Project Layout

```text
mods/
  load-order.json
  core/
    server/
    client/
    shared/
  client/
    components/
    sidebar/
```

## Runtime Contract Summary

- Deploy command builds and uploads mod bundles as assets.
- Deploy command writes a versioned mod manifest + order metadata to world DB via `/admin`.
- Server loads server/shared mod systems on boot from stored manifest.
- Client fetches manifest at startup and loads client/shared systems and UI mod modules.
- Effective mod order priority:
1. DB override order (if present and valid)
2. `mods/load-order.json` from latest deploy manifest
3. Deterministic fallback (sorted module ids)

## PR Checklist (Independent Work Units)

### [x] PR-01: Manifest + Order Contracts

Scope:

- Define `mods` manifest schema and versioning.
- Define order resolution rules and validation behavior.
- Add shared parser/validator utilities used by CLI, app-server, and runtime.

Concrete steps:

- Add `src/core/mods/manifest.js` for schema validation and normalization.
- Add `src/core/mods/order.js` for order merge/validation utilities.
- Add tests for invalid manifests, duplicate ids, unknown ids, cyclic/missing order entries.
- Document schema in `docs/World-projects.md`.

Dependency notes:

- Depends on: none.

---

### [x] PR-02: Server Persistence + Admin API for Mods State

Scope:

- Persist mod manifest and optional load-order override in world DB.
- Expose admin endpoints to read/write mod state.
- Keep this separate from `settings` serialization.

Concrete steps:

- Add DB migration in `src/server/db.js` to persist:
  - `mods_manifest`
  - `mods_load_order_override`
- Add mod state read/write helpers (server-side service module).
- Add admin endpoints in `src/server/admin.js`:
  - `GET /admin/mods`
  - `PUT /admin/mods/manifest`
  - `PUT /admin/mods/load-order`
  - `DELETE /admin/mods/load-order`
- Reuse deploy lock semantics for mods updates.

Dependency notes:

- Depends on: PR-01 (shared schema/validation).

---

### [x] PR-03: App-Server Mod Packager/Uploader (No Watchers)

Scope:

- Build and upload mods from world project `mods/`.
- Generate and push manifest + order metadata to remote world.
- Explicit deploy flow only (no continuous sync for mods).

Concrete steps:

- Add `app-server/mods.js` to:
  - scan `mods/core/server`, `mods/core/client`, `mods/core/shared`
  - scan `mods/client/components`, `mods/client/sidebar`
  - read `mods/load-order.json`
  - bundle entries with esbuild
  - upload bundles via admin upload path
  - publish manifest through mods admin API
- Ensure bundle ids are deterministic and stable for diff/deploy output.
- Implement dry-run deploy plan output for mods.
- Print post-deploy restart requirement for server mods.

Dependency notes:

- Depends on: PR-01, PR-02.

---

### [x] PR-04: CLI Command `gamedev mods deploy`

Scope:

- Add dedicated mods command path in CLI.
- Keep command surface clearly separate from apps commands.

Concrete steps:

- Wire `mods` command parsing in `bin/gamedev.mjs`.
- Add command handlers in `app-server/commands.js` (or `app-server/mods-commands.js`).
- Support flags:
  - `--target <name>`
  - `--dry-run`
  - `--note <text>`
- Add help text in `docs/commands.md`.

Dependency notes:

- Depends on: PR-03.

---

### [x] PR-05: Server Runtime Mod Loader (Boot-Time)

Scope:

- Load server/shared mod systems from stored manifest at server start.
- Register mods after core systems and before world init/start loop.

Concrete steps:

- Add `src/core/mods/loadServerMods.js`.
- Update `src/core/createServerWorld.js` to support post-core mod registration.
- Update `src/server/index.js` startup flow:
  - fetch persisted mods manifest
  - resolve effective order
  - dynamic import + register systems
- Define failure policy:
  - invalid manifest/order => fail startup with explicit error
  - missing optional module => startup warning or fail (configurable; choose one and document)

Dependency notes:

- Depends on: PR-01, PR-02.
- Can be developed in parallel with PR-03/PR-04.

---

### [x] PR-06: Client Runtime System Mod Loader

Scope:

- Load client/shared system mods before `world.init`.
- Use manifest served by world server (not compile-time engine manifests).

Concrete steps:

- Add public mods manifest route in `src/server/index.js` (read persisted manifest).
- Add `src/core/mods/loadClientMods.js`.
- Update `src/client/world-client.js` to await system mod load before `world.init(config)`.
- Enforce same effective order logic as server for client-capable entries.

Dependency notes:

- Depends on: PR-01, PR-02.
- Can be developed in parallel with PR-03/PR-04.

---

### [x] PR-07: Old UI Mod Parity (Components + Sidebar)

Scope:

- Restore old patch behavior for UI mods in world-project form.
- Support `mods/client/components/*` and `mods/client/sidebar/*`.

Concrete steps:

- Extend manifest model with UI entries:
  - component modules
  - sidebar modules (button + pane)
- Add client UI mod loader (`src/core/mods/loadClientUIMods.js` or merged loader).
- Update `src/client/components/CoreUI.js` to mount loaded mod components.
- Update `src/client/components/Sidebar.js` to mount mod sidebar buttons/panes.
- Export stable sidebar primitives needed by sidebar mods.

Dependency notes:

- Depends on: PR-03 (UI bundle generation), PR-06 (client manifest loading).
- Cannot be fully completed before PR-03 + PR-06.

---

### [x] PR-08: Load Order Override End-to-End

Scope:

- Make order controls explicit and auditable.
- Support both world-project file order and DB override order.

Concrete steps:

- Validate `mods/load-order.json` during `mods deploy`.
- Persist deployed order in manifest payload.
- Add admin/API command path to set/clear DB override order.
- Apply precedence rules consistently in both loaders.
- Add logs that show final resolved order at server startup and client startup.

Dependency notes:

- Depends on: PR-02, PR-03, PR-05, PR-06.

---

### [x] PR-09: Asset Delivery Hardening for JS Module Imports

Scope:

- Ensure dynamic JS module imports work reliably for local and S3 assets.

Concrete steps:

- Add JS MIME types in `src/server/AssetsS3.js` (`js`, `mjs`, `cjs`).
- Ensure mod bundle uploads include JS mime type.
- Validate module loading with `ASSETS=local` and `ASSETS=s3` configurations.
- Document required CORS/content-type assumptions for remote clients.

Dependency notes:

- Depends on: PR-03, PR-06.

---

### [x] PR-10: Integration Tests + Operational Docs

Scope:

- Validate deploy/restart workflow and parity behavior.
- Publish operator and author documentation.

Concrete steps:

- Add integration tests covering:
  - deploy mods to remote world
  - restart server and verify server mods are active
  - client loads system mods + UI mods
  - order precedence (file order vs DB override)
- Add docs updates:
  - `docs/World-projects.md` (authoring mods)
  - `docs/App-server.md` (deploy semantics, restart requirement)
  - `docs/commands.md` (`gamedev mods deploy`)
  - troubleshooting section for manifest/order/mime failures

Dependency notes:

- Depends on: PR-04 through PR-09.

---

## Dependency Summary

- Required base path: PR-01 -> PR-02.
- Deploy command path: PR-01 -> PR-02 -> PR-03 -> PR-04.
- Runtime path: PR-01 -> PR-02 -> (PR-05 and PR-06 in parallel).
- UI parity path: PR-03 + PR-06 -> PR-07.
- Order override complete path: PR-02 + PR-03 + PR-05 + PR-06 -> PR-08.
- Hardening/tests/docs finish after feature paths: PR-09, PR-10.

## Notes on Unavoidable Dependencies

- Persisted manifest APIs (PR-02) are a hard dependency for both deploy and runtime loading.
- UI parity cannot be completed until both UI bundle deploy and client runtime loading exist.
- End-to-end order controls require both deploy-time order ingestion and runtime order application.
