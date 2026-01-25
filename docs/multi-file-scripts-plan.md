# Multi-File App Scripts + Two-Way Sync (Plan)

Status: draft
Last updated: 2026-01-24

## Goals

- Support multi-file app scripts authored as real ES modules (`import ... from './helpers.js'`).
- Preserve full source structure on the server so worlds can be exported/imported with original file layout.
- Enable two-way sync of script sources between:
  - app-server (local filesystem) and
  - connected runtime(s) (client-side authoring/AI + server-side engine)
- Remove bundling from app-server for module-mode apps (no esbuild bundle step; only file upload + metadata updates).
- Maintain backward compatibility with legacy single-file `blueprint.script` apps during transition.

## Non-goals (v1)

- Supporting `node_modules` bare imports in app scripts (requires a dependency distribution story).
- Supporting arbitrary URL imports (`https://...`) from scripts.
- Guaranteeing automatic conflict-free merges when app-server and in-world editor modify the same file concurrently.

## Key Constraints From Current System

- Assets are stored content-addressed as `asset://<sha256>.<ext>`; filenames are not preserved (see `src/server/AssetsLocal.js`).
- Runtime today loads a single script URL (`blueprint.script`) and evaluates it as *function-body code*, not as an ESM module (`src/core/systems/Scripts.js`).
- Deploy lock / capabilities currently treat “script change” as a change to the `script` field (`src/server/admin.js`).
- Server-side cleanup currently only keeps `blueprint.script` (single asset) and does not understand multi-file script graphs (`src/server/cleaner.js`).

## Proposed Data Model (Blueprint Fields)

Add optional fields to blueprint JSON:

- `script`: string (existing field, kept)
  - Always the entry script asset URL (`asset://...`) for both legacy and module-mode apps.
  - Legacy single-file apps only set `script` and omit the module fields below.
  - Module-mode apps keep `script` pointing at the entry file so existing tooling expectations remain valid.
- `scriptEntry`: string
  - App-relative module path (POSIX separators) within `apps/<AppName>/`.
  - Examples: `index.js`, `index.ts`, `src/index.js`.
- `scriptFiles`: { [relPath: string]: string }
  - Map from app-relative module path to the canonical asset URL containing that module source.
  - Example: `"helpers/math.js": "asset://<hash>.js"`.
- `scriptFormat`: "module" | "legacy-body" (optional; default "legacy-body" for authoring ergonomics)
  - `module`: `scriptEntry` must export default `(world, app, fetch, props, setTimeout) => void`.
  - `legacy-body`: `scriptEntry` contains the existing “raw script body” style (may include imports); runtime compiles it into a default-export function to preserve current authoring style.
- `scriptRef`: string (optional)
  - Blueprint id that owns the shared `scriptFiles/scriptEntry/scriptFormat` for this app.
  - Use this to avoid duplicating a large `scriptFiles` map across blueprint variants (`App__Variant`).
  - Portability rule: exports (`.hyp`) should inline the resolved script mapping so the bundle is self-contained (i.e., avoid external `scriptRef` dependencies inside a `.hyp`).

Validation rules (enforced on server + app-server + runtime):

- If a blueprint is module-mode:
  - `scriptEntry` must exist as a key in `scriptFiles` (after resolving `scriptRef` if present).
  - `script` must equal `scriptFiles[scriptEntry]` (tools should enforce; runtime may derive if missing/mismatched for resiliency).
- `scriptFiles` keys must be normalized, app-relative POSIX paths:
  - no leading `/`
  - no `..` segments
  - no backslashes
- `scriptFiles` values must be `asset://...` URLs.

## Runtime Module Resolution Design

We need stable module specifiers that preserve source paths, while loading content-addressed assets.

- Determine the "script root" blueprint for an app instance:
  - if `blueprint.scriptRef` is set, use that referenced blueprint id
  - else, if this blueprint has `scriptFiles`, use itself
  - else, optional fallback: try the base blueprint id for the app (derived from `parseBlueprintId(blueprint.id).appName`) and use it if it has `scriptFiles`
  - otherwise treat as legacy single-file script

- Runtime uses SES modules (`Compartment.import`) with:
  - `resolveHook(importSpecifier, referrerSpecifier)`:
    - only allow relative specifiers (`./` and `../`) and exact `app://...` internal specifiers
    - reject bare imports (`react`, `lodash-es`, etc.) in v1
  - `importHook(moduleSpecifier)`:
    - parse `app://<scriptRootBlueprintId>@<scriptRootBlueprintVersion>/<relPath>`
    - look up `<relPath>` in `blueprint.scriptFiles`
    - fetch module source from the mapped `asset://...` URL

Cache invalidation:

- Include `@<blueprintVersion>` in the internal module specifier to ensure any blueprint update (including script file remaps) yields a fresh module graph.
- If we later want to avoid reloading on non-script blueprint edits, introduce a `scriptGen` field that only changes when scriptFiles/scriptEntry/scriptFormat change.

## Two-Way Sync Model (What Syncs)

- Local -> world: app-server uploads updated module source assets and updates the script-root blueprint `scriptFiles/scriptEntry/scriptFormat` (and sets `scriptRef` on variants).
- World -> local: app-server listens to `/admin` blueprint updates; when module fields change, it downloads all referenced module assets and writes them into `apps/<AppName>/...` preserving structure.

Conflicts:

- v1 policy: last-writer-wins at the blueprint/version level.
- app-server should surface conflicts clearly (e.g., “remote changed while you had local edits”) and optionally write conflicting versions to `apps/<AppName>/.conflicts/<timestamp>/...`.

## Work Breakdown (PR-Sized, Separately Landable)

Each PR below is intended to be reviewable and mergeable independently. Dependencies are explicitly called out.

### PR 01 - Blueprint Schema + Server Safeguards

- [x] Add new blueprint fields (`scriptEntry`, `scriptFiles`, `scriptFormat`) to documentation and internal conventions.
- [x] Add `scriptRef` to the blueprint conventions and document that variants should reference a shared script root.
- [x] Update admin deploy gating to treat changes to `scriptEntry/scriptFiles/scriptFormat/scriptRef` as deploy-protected (same as `script` today).
- [x] Update deploy lock scope derivation to cover module script updates consistently (scope should match current per-app behavior).
- [x] Update server cleaner to retain assets referenced by `blueprint.scriptFiles` (in addition to `blueprint.script`).
- [x] Add basic validation helpers in server-side blueprint application path (reject invalid paths / non-asset URLs).
- [x] Tests:
  - [x] unit: blueprint validation for `scriptFiles` path traversal prevention
  - [x] integration: admin `blueprint_modify` rejects module script changes without deploy capability / lock

Dependencies: none.

### PR 02 - `.hyp` Import/Export: Preserve Multi-File Sources

- [x] Extend `src/core/extras/appTools.js`:
  - [x] `exportApp`: if `scriptRef` is present, resolve the referenced blueprint and inline its `scriptFiles/scriptEntry/scriptFormat` into the exported blueprint so the `.hyp` is self-contained.
  - [x] `exportApp`: include every `scriptFiles` asset (and embed `scriptEntry/scriptFormat/scriptFiles` in the blueprint header).
  - [x] `importApp`: rewrite `scriptFiles` values to new `asset://<hash>.<ext>` URLs and keep the relative path keys intact (no `scriptRef` on imported blueprints).
  - [x] Extend URL rewrite logic to cover nested fields (`scriptFiles`).
- [x] Update `docs/supported-files/hyp-format.md` to reflect the new fields and multi-file scripts.
- [x] Tests:
  - [x] unit: round-trip import/export preserves file paths and rewrites asset URLs correctly

Dependencies: PR 01 (server accepts/stores new blueprint fields) is recommended but not strictly required for client-only `.hyp` round-trip tests.

### PR 03 - Runtime: Module Script Loader (SES)

- [x] Implement module loading in `src/core/systems/Scripts.js`:
  - [x] add `loadModuleScript({ blueprint })` that returns `{ exec, entryUrl, modules }` or similar
  - [x] add SES `Compartment` configured with `resolveHook/importHook/importMetaHook`
  - [x] implement fetch for `asset://...` in both client + server contexts (prefer shared helper; reuse existing loader fetch where possible)
  - [x] enforce import policy (relative-only; reject bare imports in v1)
- [x] Update `src/core/systems/ClientLoader.js` and `src/core/systems/ServerLoader.js` as needed to support “load text by asset url” with caching (optional in v1; acceptable to fetch directly in Scripts).
- [x] Tests:
  - [x] unit: resolveHook path normalization + traversal rejection
  - [x] integration: module graph loads and executes on server runtime (node test)

Dependencies: PR 01.

### PR 04 - Runtime: App Entity Executes Module Scripts

- [x] Update `src/core/entities/App.js`:
  - [x] resolve the script-root blueprint (via `scriptRef` / base blueprint fallback) and if it has `scriptFiles`, load/execute module script via `world.scripts.loadModuleScript(...)` instead of `world.loader.load('script', blueprint.script)`
  - [x] preserve legacy path if `blueprint.scriptFiles` is absent
  - [x] ensure script errors crash the app consistently in both modes
- [x] Update client preload logic (`src/core/systems/ClientNetwork.js`) to optionally preload module entry (can be deferred; document behavior if skipped).
- [x] Tests:
  - [x] integration: create a blueprint with `scriptFiles` and verify the app executes client + server (where applicable)

Dependencies: PR 03.

### PR 05 - Runtime: `legacy-body` Entry Compilation (Keep Implicit Authoring Style)

- [x] Implement `scriptFormat: "legacy-body"` support:
  - [x] compile raw entry source into an ESM module exporting default `(world, app, fetch, props, setTimeout) => { ... }`
  - [x] preserve `const config = props` alias (deprecated) for backward compatibility
  - [x] provide a `shared` object equivalent to today’s wrapper semantics
  - [x] enforce and document constraints: imports must be top-level (header) ESM; body must not contain `export`
- [x] Add clear runtime errors for invalid entry format (helpful messages surfaced in-world).
- [x] Tests:
  - [x] unit: compilation preserves imports and wraps body
  - [x] integration: legacy-body + helpers module executes

Dependencies: PR 03 + PR 04.

### PR 06 - app-server: Upload Multi-File Scripts (No Bundling) + Deploy

- [x] Add script file discovery for each `apps/<AppName>/`:
  - [x] include `index.(js|ts)` and any imported/adjacent `.js/.ts` modules (v1 simplest: include all `.js/.ts` under the app folder; ignore `.json`)
  - [x] normalize to POSIX relPaths for `scriptFiles`
- [x] Implement `_uploadScriptFilesForApp(appName)`:
  - [x] upload each module source to hashed `asset://...`
  - [x] produce `scriptFiles` mapping + `scriptEntry` + `scriptFormat`
- [x] Update deploy pipeline in `app-server/direct.js`:
  - [x] for module-mode apps, stop calling esbuild bundler (`app-server/appBundler.js`)
  - [x] keep blueprint `script` set to the entry script asset URL (legacy + module-mode)
  - [x] include `scriptFiles/scriptEntry/scriptFormat` on the script-root blueprint only
  - [x] include `scriptRef` on variant blueprints to reference the script-root blueprint
- [x] Update watchers to trigger deploy on any `.js/.ts` change inside an app folder.
- [x] Tests:
  - [x] integration: app-server deploy updates blueprint fields and assets, and runtime loads new module script

Dependencies: PR 01 + PR 03/04 (so runtime can actually run what app-server deploys).

### PR 07 - app-server: World -> Disk Sync For Script Sources (Preserve Structure)

- [x] Extend `app-server/direct.js` remote blueprint handler:
  - [x] when a blueprint is a script-root (has `scriptFiles`) OR references one (has `scriptRef`), download the resolved script-root's assets and write to `apps/<AppName>/<relPath>`
  - [x] delete local files that are no longer present in the resolved `scriptFiles` (optional v1; can move to conflicts/trash folder)
  - [x] keep blueprint JSON writing behavior unchanged
- [x] Update `gamedev world export --include-built-scripts` behavior:
  - [x] export module sources by default when present
  - [ ] optionally keep `--include-built-scripts` as legacy-only and add a new flag like `--include-script-sources`
- [x] Tests:
  - [x] integration: remote blueprint update results in local file tree update

Dependencies: PR 01.

### PR 08 - Client Authoring: Minimal Multi-File Script Editor + Deploy (Non-AI)

- [x] Add a minimal UI for editing `scriptFiles`:
  - [x] file tree for `apps/<AppName>` module paths
  - [x] monaco editor per file (reusing existing editor component patterns)
  - [x] “save” action uploads changed module, updates script-root blueprint `scriptFiles/scriptEntry/scriptFormat`, acquires deploy lock, and calls admin `blueprint_modify`
- [x] Add guardrails:
  - [x] show deploy lock errors cleanly
  - [x] show version mismatch conflicts and allow refresh/retry
  - [x] validate path constraints on client before sending
- [x] Tests:
  - [x] manual test script in docs for end-to-end (client edit -> server update -> app-server writes to disk) (`docs/manual-tests/multi-file-script-editor.md`)

Dependencies: PR 01 + PR 03/04 (and ideally PR 07 for visible two-way sync).

### PR 09 - Client Authoring: AI Integration Hook Points (Scaffolding)

- [x] Define an internal API for “AI proposes changes to N files”:
  - [x] apply patch set to in-memory file models
  - [x] preview diff
  - [x] commit uploads as one deploy lock session
- [x] Add telemetry/logging hooks for debugging sync (dev-only).
- [x] Document the intended AI workflow in `docs/ai-script-editor.md`.

Dependencies: PR 08.

### PR 10 - Documentation + Migration Guide

- [ ] Update `docs/App-server.md` and scripting docs to explain module-mode scripts and multi-file layouts.
- [ ] Add a migration section:
  - [ ] legacy single-file `script` remains supported
  - [ ] how to convert to `scriptFiles` with `scriptFormat: legacy-body` or `module`
- [ ] Update project scaffolding defaults (optional):
  - [ ] decide whether scaffolded built-ins remain legacy-body or switch to module format

Dependencies: PRs 01-08 (as applicable).

## Decisions Locked

- `scriptFiles` are shared across blueprint variants via `scriptRef` (no duplication).
- `blueprint.script` remains the entry script asset URL in both legacy and module mode.
- `legacy-body` requires imports at the top of the entry file (no parser-based import extraction in v1).
