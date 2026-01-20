# Dev Server App Bundling (Code Splitting) Plan

This plan describes the new **dev server → runtime** paradigm for Hyperfy world projects (content-only folders) and adds first-class **TypeScript + bundling** for app scripts so developers can split code across multiple files (and `node_modules`) while still deploying **one JS file per app** to the runtime sandbox.

It is written as a **tracked checklist** and organized into **PR-sized steps** for handoff.

---

## Goals

- Support **code splitting** for scripts:
  - Multiple source files → **bundled into one JS file per app script**.
  - Artifacts saved to `dist/` and kept alongside source.
- Support **TypeScript**:
  - `apps/<app>/index.ts` is the primary entry (fallback to `index.js`).
  - Built-in app scripts are authored as `index.ts` in the project (with `// @ts-nocheck` ok).
- Support **imports**:
  - **Local imports** must be **relative** (`./` / `../`).
  - **Bare specifiers** allowed for **`node_modules`**.
  - Allow importing JSON and text assets into bundles.
  - Forbid importing from **other apps** (`apps/<otherApp>/...`).
  - Forbid Node built-ins (e.g. `fs`, `path`, `crypto`, and `node:*`) at build time.
- Keep the app folder layout style:
  - Entry stays `apps/<app>/index.(js|ts)`.
- No sourcemaps required; runtime can show built script.
- Establish a clear **dev vs prod** operational model:
  - Dev server is safe for development; prod deploy should be explicit and avoid world layout sync.
- Remove default “fetch scripts from runtime” behavior:
  - By default, dev server does not download script code from the world.
- Provide an escape hatch: `gamedev world export --include-built-scripts`.

---

## Non-goals (for this plan)

- Runtime module loading (no ESM in sandbox); bundling is required.
- Sourcemaps/debugger mapping to source.
- Path aliases (only relative imports for local code).
- Making arbitrary npm packages work in the sandbox; build-time errors for Node builtins is intentional.
- Changing the runtime sandbox API surface.

---

## Current System (Relevant Facts)

- Runtime executes app scripts as **raw JS text** inside an SES `Compartment`, wrapped as a function:
  - `src/core/systems/Scripts.js` inserts script text into `wrapRawCode(...)`.
  - This means runtime cannot execute ESM `import`/`export` directly.
- App-server (dev server) today:
  - Pushes scripts/blueprints/assets to `/admin` via deploy lock (`app-server/direct.js`, `src/server/admin.js`).
  - Also pulls scripts on bootstrap and on remote blueprint changes (`app-server/direct.js#_downloadScript`).
  - Applies `world.json` ↔ world bidirectional sync (layout changes are disruptive in prod).
- Local blueprint config schema is intentionally script-less:
  - `app-server/direct.js#_blueprintToLocalConfig` writes blueprint JSON without `script`.

---

## Proposed World Project Layout

```
.
├─ apps/
│  ├─ Model/
│  │  ├─ Model.json
│  │  └─ index.ts
│  ├─ Image/
│  │  ├─ Image.json
│  │  └─ index.ts
│  ├─ ...
│  └─ $scene/
│     ├─ $scene.json
│     └─ index.ts
├─ assets/                 # user assets referenced by blueprint configs (optional at init)
├─ dist/
│  └─ apps/
│     ├─ Model.js
│     ├─ Image.js
│     └─ ...
├─ world.json              # layout + per-instance overrides
└─ hyperfy.app-runtime.d.ts
```

Artifacts policy:
- `dist/apps/<appName>.js` is always the **latest** build output for that app.
- Bundles are **not minified**.

---

## Build System Spec (Apps)

Use `esbuild` programmatically (separate from the repo’s existing build scripts, which build the engine/runtime).

### Entry + Output
- Entry: `apps/<appName>/index.ts` if it exists, else `apps/<appName>/index.js`.
- Output: `dist/apps/<appName>.js` (single file).

### Output format
- Must be compatible with runtime’s “raw code inserted into a wrapper function”.
- Use `format: 'iife'` so the output has **no ESM imports/exports**.

### Key esbuild options (baseline)
- `bundle: true`
- `format: 'iife'`
- `platform: 'browser'` (helps avoid Node assumptions)
- `target: 'es2020'` (adjust if Hyperfy supports older browsers)
- `minify: false`
- `sourcemap: false`
- `outfile: <project>/dist/apps/<appName>.js`
- `absWorkingDir: <projectRoot>`

### Loaders
- Allow JSON imports:
  - `.json: 'json'`
- Allow basic text imports:
  - `.txt: 'text'`, `.md: 'text'`, `.glsl: 'text'` (extend as needed)

### Import policy enforcement (esbuild plugins)
Implement a resolver plugin that:
- Allows relative local imports that resolve to files:
  - inside the project root, AND
  - NOT inside `apps/<otherApp>/...`.
- Allows bare imports (no `./` or `../`) **only** if they resolve via `node_modules`.
- Errors if a resolved path escapes the project root.
- Errors if the import path is a Node builtin or `node:*`.

Suggested behavior:
- When a dependency pulls in a Node builtin transitively, fail the build with a clear message:
  - `Disallowed node builtin import "fs" (scripts run in sandbox).`

---

## Dev vs Prod Operational Model

### Dev mode (default)
Use when actively developing. Safe assumptions:
- Dev server runs continuously and watches for changes.
- Dev server can apply `world.json` changes (layout sync).
- Dev server builds app bundles and deploys to runtime automatically.

### Prod mode (explicit deploy only)
Use for staging/prod worlds where gameplay may be in progress.
- Do **not** run the continuous dev server (world layout sync is disruptive).
- Use `gamedev apps deploy <app>` to update scripts/blueprints explicitly.
- Deploy remains protected by the existing deploy lock + snapshots (`src/server/admin.js`).

CLI UX guidance:
- Treat `gamedev dev` as a development workflow.
- For prod targets, require an explicit confirmation / opt-in to run continuous sync (similar to existing deploy confirmation).

---

## Bootstrap / Initialization Behavior

### `gamedev dev` in an empty project folder
Instead of pulling code from the runtime server, scaffold local state from built-in templates and then push to the runtime:

Create:
- `apps/` with built-in apps + `$scene`:
  - `Model`, `Image`, `Video`, `Text`, `Webview`, `$scene`
- `apps/<name>/index.ts` for each, based on package built-in scripts:
  - Source from the installed package’s `build/world/assets/*.js`
  - Add `// @ts-nocheck` header
  - Preserve JS code as-is
- Blueprint JSON files per app:
  - Match `app-server/direct.js#_blueprintToLocalConfig` schema (no `script` field)
  - `$scene` uses “The Meadow” defaults from `src/server/db.js` migration (model + props + flags)
  - Other builtins use definitions aligned with `src/client/builtinApps.js` (model/image/props/etc)
- `world.json` containing only the default scene entity at `[0,0,0]` and default settings/spawn:
  - Mirror the new-world migration expectations (one `$scene` entity)
- `hyperfy.app-runtime.d.ts`:
  - `/// <reference types="gamedev/app-runtime" />`

Then:
- Build bundles to `dist/apps/*.js`.
- Deploy blueprints + script bundles to the runtime via `/admin`.
- Apply `world.json` to the runtime (dev mode only).

### Starting against an existing world with an empty local project
Default behavior should be safe:
- Error with a message explaining that script code is not fetched from the world anymore.
- Provide the escape hatch:
  - `gamedev world export --include-built-scripts`

---

## `gamedev world export --include-built-scripts`

Purpose: migrate an existing world into a local project when you need the script code.

Behavior:
- Default `gamedev world export`:
  - exports `world.json`, blueprint JSON, and any referenced non-built-in assets
  - does **not** write `apps/<app>/index.*`
- With `--include-built-scripts`:
  - downloads built script assets from the world
  - writes them to `apps/<app>/index.ts` (with `// @ts-nocheck`)
  - (optional) also builds `dist/apps/<app>.js` so a subsequent deploy is deterministic

---

## Implementation Checklist (PR-sized)

### PR 1 — Add app bundler module (esbuild)
- [x] Add `app-server/appBundler.js` (or similar) that exposes:
  - `buildApp({ rootDir, appName }): { outfile, errors? }`
  - `createAppWatch({ rootDir, appName, onBuild }): disposer`
- [x] Implement esbuild config:
  - entry resolution: `apps/<app>/index.ts` else `index.js`
  - output: `dist/apps/<app>.js` (single file, not minified)
  - `format: 'iife'`, `bundle: true`, loaders for json/text
- [x] Add esbuild plugins:
  - forbid Node builtins (`fs`, `path`, `crypto`, `node:*`, etc)
  - forbid resolving into `apps/<otherApp>/...`
  - forbid resolving outside project root
  - allow bare imports only from `node_modules`
- [x] Add unit-ish coverage (if there’s a lightweight existing test harness) or a small scriptable repro under `test/` to validate:
  - local cross-app import fails
  - node builtin import fails
  - JSON/text import succeeds
  - `node_modules` import succeeds

### PR 2 — Integrate bundler into deploy pipeline (CLI + app-server)
- [x] Update `app-server/direct.js#_uploadScriptForApp` to:
  - build (or ensure built) bundle for the app
  - read `dist/apps/<app>.js` as the upload content
  - upload hashed asset as today
- [x] Update `app-server/commands.js`:
  - `deploy` / `update` builds bundles before upload (same build output, not minified)
  - `validate` compares the **built** bundle hash vs world script hash
- [x] Ensure `dist/` is created automatically (`dist/apps` mkdir)

### PR 3 — Watch mode for code-split sources (dependency-aware)
- [x] Replace “watch only `index.(js|ts)`” behavior with esbuild watch per app:
  - `DirectAppServer` maintains a map `{ appName -> esbuildContext }`
  - On rebuild success: schedule deploy for that app
  - On rebuild error: log and suppress deploy until fixed
- [x] Keep existing watchers for blueprint JSON and `assets/` changes (still trigger deploy)
- [x] Ensure watchers are disposed on shutdown/restart reconnect loops

### PR 4 — New bootstrap behavior (scaffold builtins locally; push to world)
- [x] Add built-in templates data under `app-server/templates/builtins.js`:
  - include: Model/Image/Video/Text/Webview + `$scene`
  - include `$scene` “The Meadow” props as in `src/server/db.js`
- [x] Add helper that copies built-in script sources from the installed package:
  - read from `build/world/assets/{Model,Image,Video,Text,Webview,scene}.js`
  - write to `apps/<name>/index.ts` with `// @ts-nocheck`
- [x] Update `DirectAppServer.start()` bootstrap logic:
  - If project is empty (no `apps/` blueprints and no `world.json`), scaffold locally (do not export from world)
  - Generate `world.json` with only `$scene` entity at origin
  - Create `hyperfy.app-runtime.d.ts`
  - Deploy all and apply manifest
- [x] Add safety check: if connecting to a non-empty world with an empty local project, error and print the export escape hatch

### PR 5 — Stop downloading scripts by default; add export escape hatch
- [x] Update `app-server/direct.js#_writeBlueprintToDisk`:
  - remove default `_downloadScript` → `apps/<app>/index.js` behavior
  - keep downloading referenced assets as today
- [x] Extend `gamedev world export` (in `bin/gamedev.mjs`) to support:
  - `--include-built-scripts`
- [x] Thread the flag to `DirectAppServer.exportWorldToDisk({ includeBuiltScripts })`
  - when true: download script and write to `apps/<app>/index.ts` (`// @ts-nocheck`)
- [x] Update docs and CLI messages to reflect the new default behavior

### PR 6 — Dev vs prod safety + docs refresh
- [x] Add explicit language in docs that app-server is a **dev server**:
  - update `docs/App-server.md`
  - update `docs/Recommended-workflow.md`
- [x] Add `gamedev dev` messaging as the recommended entrypoint for continuous sync
- [x] Add guardrails for prod targets:
  - if target indicates prod (`confirm: true` or `HYPERFY_TARGET=prod`), require confirmation to run continuous sync
  - leave `gamedev apps deploy` as the recommended prod workflow

### PR 7 (Optional) — Quality-of-life commands
- [x] Add `gamedev apps build <app>` (build only; no deploy)
- [x] Add `gamedev apps build --all` (build all apps)
- [x] Add `gamedev apps clean` to remove `dist/apps/*` (optional; keep out of default flow since artifacts should be saved)

---

## Validation / Testing Plan (per PR)

- Bundler correctness:
  - Build a sample app with nested imports and `node_modules` dependency.
  - Verify `dist/apps/<app>.js` contains no `import`/`export`.
  - Verify Node builtin imports fail at build time.
  - Verify cross-app import fails at build time.
- Dev server correctness:
  - Edit a deep imported file and confirm:
    - bundle rebuild occurs
    - deploy occurs
    - runtime reflects changes
- Export behavior:
  - `gamedev world export` does not write `index.ts`
  - `gamedev world export --include-built-scripts` writes `apps/<app>/index.ts`
- Prod safety:
  - prod target refuses/asks confirmation for continuous sync
  - `gamedev apps deploy` remains explicit and works

---

## Notes / Open Extension Points

- If server-side patches ever require additional typings beyond the installed package, add a future admin-only endpoint and extend `hyperfy.app-runtime.d.ts` generation to merge or reference those.
- If dynamic `import()` becomes desired later, it must be converted to a bundler-time inclusion model (runtime cannot load modules).
