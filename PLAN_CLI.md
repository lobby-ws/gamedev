# Hyperfy CLI Paradigm Shift (Plan / Handoff)

## Summary
We are moving from “run Hyperfy world server in the current folder” to a **project-based CLI**:

- The **project directory** is the folder where the user runs `hyperfy …` and contains user-editable files (`./apps`, `./assets`, `./world.json`, `./.env`).
- The **world runtime directory** for **local worlds** lives at `~/.hyperfy/<WORLD_ID>` and is used as the Hyperfy world server’s `WORLD` folder.
- The CLI decides whether to run the **local world server** + the **app-server sync agent**, or **only** the app-server sync agent for remote worlds.

This plan includes:
- Fix for the current `window is not defined` crash.
- CLI commands, behavior, and env var contract.
- Local world lifecycle (create/start/wipe/list).
- Refactor approach to reuse the existing `app-server/cli.js` functionality in the new CLI.

## Current Problem: `window is not defined` on `npx @drama.haus/hyperfy`
Observed error:
`SES_UNCAUGHT_EXCEPTION: ... window is not defined at .../build/world-node-client.js`

### Root cause
`bin/hyperfy.mjs` imports `index.node.js`, and `index.node.js` currently has:
- `export { createNodeClientWorld } from './build/world-node-client.js'`

In ESM, re-exporting pulls that module into the import graph even when consumers only import `{ server }`. This causes Node to evaluate `build/world-node-client.js`, which includes browser-leaning code paths and references `window`.

### Required fix (pre-req before CLI work)
Make `index.node.js` safe to import without evaluating node-client/browser code.

Recommended approach (minimizes breaking changes to `server()`):
1. **Remove** the eager re-export from `index.node.js`:
   - Delete: `export { createNodeClientWorld } from './build/world-node-client.js'`
2. Add a **new explicit export path** for the node-client:
   - Create `index.node-client.js` that re-exports `createNodeClientWorld` from `./build/world-node-client.js`.
   - Update `package.json#exports` to add:
     - `"./node-client": "./index.node-client.js"`
3. Keep `index.node.js#nodeClient()` as an `async` dynamic import helper (already present), or keep only `server()` if preferred.

Acceptance check:
- `node -e "import { server } from './index.node.js'; console.log('ok')"` must not import `world-node-client` or throw `window` errors.

## Glossary / Components
**World server**
- The Hyperfy server (Fastify + websockets) started from `build/index.js` (built from `src/server/index.js`).
- Requires many env vars (`PORT`, `JWT_SECRET`, `PUBLIC_WS_URL`, etc.) and a `WORLD` directory.

**App-server (sync agent)**
- The existing `app-server/server.js` which starts `DirectAppServer` from `app-server/direct.js`.
- Connects to `WORLD_URL` and syncs `/admin` snapshot to local `./apps`, `./assets`, `./world.json`.
- Runs forever (no HTTP port), watches local changes and deploys back to world.

**Project directory (cwd)**
- User editable. Contains:
  - `./apps/**`
  - `./assets/**`
  - `./world.json`
  - `./.env` (project configuration)

**World runtime directory**
- Only for **local worlds**. Location:
  - `~/.hyperfy/<WORLD_ID>`
- Used as the world server’s `WORLD` directory (set by the CLI at runtime, not stored in `.env`).

## Desired CLI UX
- `hyperfy` (no args): prints help.
- `hyperfy start`: starts:
  - local world server + app-server sync agent (local mode), OR
  - only app-server sync agent (remote mode).
- Running in an empty folder initializes a new local project by generating `.env`.
- Running in a non-empty folder assumes an existing project and attempts to connect & sync (fails with instructions if `.env` invalid/missing).

## Modes: Local vs Remote
The CLI determines “local world” using BOTH:
- `WORLD_URL` host is “local”:
  - `localhost`, `127.0.0.1`, `::1`, or LAN IPs:
    - `10.0.0.0/8`
    - `192.168.0.0/16`
    - `172.16.0.0/12`
- `WORLD_ID` starts with `local-`

If either condition fails => **remote mode**:
- Start only the app-server sync agent, pointing at `WORLD_URL`.

## Env Contract (`.env`)
### Required keys (all projects)
- `WORLD_URL`
  - The base HTTP URL of the world server (e.g. `http://localhost:5000`).
- `WORLD_ID`
  - Local worlds: `local-<id>`, where `<id>` is generated via `uuid()` (10-char nanoid) from `src/core/utils.js`.
  - Remote worlds: any non-`local-` identifier (user-provided).
- `ADMIN_CODE`
  - For local worlds: generated random secret.
  - For remote worlds: user-provided if the remote world is protected.

### Required keys (local worlds; used by world server)
These must exist in `.env` for local mode; if missing, `hyperfy start` fails with instructions.
- `PORT`
  - Must match `WORLD_URL`’s port (or `WORLD_URL` must be updated).
- `JWT_SECRET`
- `SAVE_INTERVAL`
- `PUBLIC_MAX_UPLOAD_SIZE`
- `PUBLIC_WS_URL` (must start with `ws://` or `wss://`)
- `PUBLIC_API_URL`
- `ASSETS` (`local` or `s3`; local worlds default to `local`)
- `ASSETS_BASE_URL`
- Optional but recommended to include (keep aligned with `.env.example` defaults):
  - `PUBLIC_PLAYER_COLLISION`
  - `DB_URI`, `DB_SCHEMA`
  - `CLEAN`
  - LiveKit vars
  - `PUBLIC_DEV_SERVER`

### Keys intentionally NOT stored in `.env`
- `WORLD`
  - The CLI sets this automatically at runtime to `~/.hyperfy/<WORLD_ID>`.

### `.env` generation (new project)
When creating a new local project (only when the project dir is considered empty):
- `WORLD_URL`: default `http://localhost:5000`
- `WORLD_ID`: `local-${uuid()}`
- `ADMIN_CODE`: safe random sequence (see below)
- `PORT`: `5000` (derived from `WORLD_URL`)
- `JWT_SECRET`: random, stable per world
- `PUBLIC_WS_URL`: derived from `WORLD_URL` => `ws://host:port/ws`
- `PUBLIC_API_URL`: derived from `WORLD_URL` => `http(s)://host:port/api`
- `ASSETS_BASE_URL`: derived from `WORLD_URL` => `http(s)://host:port/assets`
- `ASSETS=local`
- `SAVE_INTERVAL=60`
- `PUBLIC_MAX_UPLOAD_SIZE=12` (match `.env.example`)
- Other optional defaults copied from `.env.example` where reasonable.

**ADMIN_CODE generation**
- Must be cryptographically random and URL/CLI safe.
- Suggested implementation: `crypto.randomBytes(16).toString('base64url')` (22 chars).
  - Alternative for “typeability”: generate 12–16 chars from a restricted alphabet and format as `xxxx-xxxx-xxxx`.

**JWT_SECRET generation**
- Must be random and stable per local world.
- Suggested: `crypto.randomBytes(32).toString('base64url')`.

### Empty-folder detection
Treat “empty project” as:
- No files OR only ignorable entries (`.git`, `.DS_Store`, `README.md` if desired).
Keep the heuristic simple and deterministic; document it in help output.

## Folder Layout
Project (cwd):
```
.env
apps/
assets/
world.json
```

Local world runtime:
```
~/.hyperfy/<WORLD_ID>/
  db.sqlite
  assets/
  storage.json
  ... (any other server-created data)
```

Optional future (not required now):
- `~/.hyperfy/<WORLD_ID>/meta.json` with `createdAt`, `lastStartedAt`, `projectPaths[]`.

## CLI Commands (Proposed)
### Core
- `hyperfy start`
  - Validates `.env`.
  - Determines local vs remote mode.
  - Spawns child processes accordingly.
- `hyperfy help` / `--help`

### Apps (port from `app-server/cli.js`)
Namespace these to avoid collisions with future world commands:
- `hyperfy apps list`
- `hyperfy apps create <appName>`
- `hyperfy apps deploy <appName>` (alias `update`)
- `hyperfy apps validate <appName>`
- `hyperfy apps status`

All of these operate on the current project directory and connect to `WORLD_URL` using `ADMIN_CODE`.

### Project reset (existing behavior)
- `hyperfy project reset [--force|-f]`
  - Deletes local project artifacts:
    - `./apps` (recursive)
    - `./assets` (recursive)
    - `./world.json`
  - Does NOT delete `~/.hyperfy/<WORLD_ID>`.

### Local worlds
- `hyperfy worlds list`
  - Lists directories under `~/.hyperfy/` (no registry required).
- `hyperfy world wipe [--force|-f]`
  - Deletes the local world runtime dir `~/.hyperfy/<WORLD_ID>` for the current project.
  - Requires confirmation unless `--force`.
  - If the project is remote-mode (non-local `WORLD_URL` or non-`local-` WORLD_ID), refuse and explain.

## `hyperfy start` Detailed Flow
### 1) Load/validate `.env`
1. Resolve `projectDir = process.cwd()`.
2. If `.env` does not exist:
   - If project dir is “empty”: generate `.env` (local defaults) and continue.
   - Else: fail with instructions (print sample `.env` skeleton).
3. Parse `.env` (do not rely on `dotenv-flow/config` import timing).
4. Validate required keys:
   - Always: `WORLD_URL`, `WORLD_ID`, `ADMIN_CODE` (allow empty string, but warn).
   - If local mode: also validate the world-server required keys listed above.
5. Validate URL consistency:
   - `PORT` must match `WORLD_URL`’s port.
   - `PUBLIC_WS_URL`, `PUBLIC_API_URL`, `ASSETS_BASE_URL` should be consistent with `WORLD_URL` (warn or hard-fail; recommend hard-fail initially).
6. If `PORT` is already in use: fail with a clear message (no auto-pick yet).

### 2) Decide mode
- `isLocalUrl(WORLD_URL) && WORLD_ID.startsWith('local-')` => local mode
- Else => remote mode

### 3) Spawn child processes
Use `child_process.spawn` with `process.execPath` and absolute script paths.

**Environment passed to children**
- Base: `process.env` + parsed `.env` values (but do not leak unrelated vars if possible; keep it simple initially).
- Add `WORLD` ONLY for the world server child:
  - `WORLD = path.join(os.homedir(), '.hyperfy', WORLD_ID)`

**Local mode children**
1. World server:
   - `node <pkgRoot>/build/index.js`
   - env includes `WORLD=<~/.hyperfy/...>` and all world-server `.env` keys.
2. App-server sync agent:
   - `node <pkgRoot>/app-server/server.js`
   - env includes `WORLD_URL`, `ADMIN_CODE`, and anything else it needs (it mostly uses those).

**Remote mode children**
1. App-server sync agent only.

**Signal handling**
- On `SIGINT`/`SIGTERM`:
  - Forward signal to both children.
  - If they do not exit after timeout, kill forcibly.
  - Exit with the world server’s code if it died first; otherwise app-server’s.

**Failure coupling**
- If the world server exits unexpectedly, stop app-server and exit non-zero.
- If app-server fails to connect (auth error or unreachable), keep world server running? Recommended:
  - Exit non-zero and stop world server to avoid “running but not syncing” confusion.
  - Print instructions for fixing `WORLD_URL`/`ADMIN_CODE`.

## Reusing `app-server/cli.js` Functionality
Goal: keep the logic but deprecate the separate CLI entry in favor of the unified `hyperfy` CLI.

Recommended refactor:
1. Extract the `HyperfyCLI` class and helper functions from `app-server/cli.js` into a library module, e.g.:
   - `app-server/commands.js` (exports `create`, `list`, `deploy`, `validate`, `status`, `projectReset`)
2. Make `app-server/cli.js` a thin wrapper around `app-server/commands.js` for backwards compatibility (optional).
3. New `bin/hyperfy.mjs` imports `app-server/commands.js` for subcommands under `hyperfy apps …` and `hyperfy project reset`.

## New CLI Implementation Structure (Suggested)
- `bin/hyperfy.mjs`
  - Argument parsing / dispatch (minimal, no new deps required).
  - `.env` create/parse/validate.
  - Mode decision (local vs remote).
  - Process spawning & signal handling.
  - Delegates app subcommands to `app-server/commands.js`.

- `src/cli/env.js` (or `app-server/env.js`)
  - `readDotEnv(filePath)` (simple parser)
  - `writeDotEnv(filePath, keyValues, { preserveExistingComments?: boolean })` (initially can overwrite for generated `.env`)
  - `validateConfig(config)` returning actionable errors.

- `src/cli/local.js`
  - `isLocalWorldUrl(url)`
  - `getLocalWorldDir(worldId)`
  - `listLocalWorlds()`

Keep these modules small; avoid pulling in browser/client code into the CLI import graph.

## Acceptance Criteria
### Local mode (new project)
1. In an empty folder:
   - `hyperfy start` generates `.env` with `WORLD_URL`, `WORLD_ID=local-…`, `ADMIN_CODE`, and required world-server vars.
   - Starts world server + app-server.
   - World server uses `WORLD=~/.hyperfy/<WORLD_ID>` (no world data written to project dir).
   - App-server creates `./apps`, `./assets`, `./world.json` and syncs from `/admin`.

### Local mode (existing project)
1. In a non-empty folder with valid `.env`:
   - `hyperfy start` connects and reconciles without overwriting existing app files unnecessarily (current `DirectAppServer` behavior).

### Remote mode
1. If `WORLD_URL` is not local OR `WORLD_ID` does not start with `local-`:
   - `hyperfy start` does NOT start the world server.
   - Starts only the app-server sync agent and syncs apps to the project.

### Wipe/reset
- `hyperfy project reset` deletes only project artifacts.
- `hyperfy world wipe` deletes only the runtime dir for the current project’s local world.
- `hyperfy worlds list` lists `~/.hyperfy/*`.

### Regression
- `npx @drama.haus/hyperfy --help` works and does not throw `window is not defined`.

## Manual Test Checklist
1. **Smoke:** `node bin/hyperfy.mjs --help`
2. **Empty folder local init:** create temp dir, run `hyperfy start`, verify:
   - `.env` created
   - `~/.hyperfy/<WORLD_ID>` created and contains world db after start
   - `./apps` populated after app-server connect
3. **Remote mode:** set `.env` to a remote `WORLD_URL` and non-`local-` `WORLD_ID`, run `hyperfy start`, ensure no world runtime dir is created/used.
4. **Reset/wipe safety:** confirm prompts and `--force` behavior.

## Deferred Enhancements (Explicitly Out of Scope For First Pass)
- Auto-select an available port and rewrite `.env`.
- Metadata registry / pretty `worlds list` output (sizes, last used).
- `--detach` / background daemon mode.
- Interactive prompting for missing `ADMIN_CODE` on connection failure (could be added later).

