# App-server <-> Runtime Bidirectional Sync: Low-Intensity User-Action Test Guide

## Purpose
This is a lightweight manual guide for validating bidirectional sync through normal workflows only.

Allowed actions in this guide:
- browser client actions
- app-server start/stop
- local file edits in project files
- `gamedev sync` CLI commands

Not used in this guide:
- direct `/admin` API calls
- database inspection
- low-level backend instrumentation

For deeper coverage, use `docs/App-server-runtime-bidirectional-manual-testing-guide.md`.

## Quick Setup
Use 3 terminals.

- `T1`: world server
- `T2`: app-server
- `T3`: local edits + sync commands

### 1) Prepare env
In your project folder (example: `/tmp/bidi-light/project`), create `.env`:

```bash
WORLD_URL=http://127.0.0.1:3000
WORLD_ID=local-bidi-light
ADMIN_CODE=qa-admin
BIDIRECTIONAL_SYNC=true
SYNC_STRICT_CONFLICTS=true
```

### 2) Start world server (T1)

```bash
cd /home/peezy/repos/github/lobby/runtime
npm run build
WORLD=/tmp/bidi-light/world WORLD_URL=http://127.0.0.1:3000 WORLD_ID=local-bidi-light ADMIN_CODE=qa-admin PORT=3000 npm start
```

### 3) Start app-server (T2)

```bash
cd /tmp/bidi-light/project
source .env
node /home/peezy/repos/github/lobby/runtime/app-server/server.js
```

Expected:
- app-server connects successfully
- project gets scaffolded (`apps/`, `assets/`, `world.json`, `.lobby/`)

### 4) Open client
Open `http://127.0.0.1:3000` in browser and become admin if required:

```text
/admin qa-admin
```

## Lightweight Test Cases

### LITE-01: Startup Smoke Test
1. Start app-server.
2. Wait for `Connected ... (/admin)` log.
3. Run in `T3`:
   - `node /home/peezy/repos/github/lobby/runtime/bin/gamedev.mjs sync status`

Expected:
- command succeeds
- no startup conflict error
- `.lobby/sync-state.json` exists

### LITE-02: Client -> App-server (Remote-only edit while app-server is down)
1. Stop app-server (Ctrl+C in `T2`).
2. In client, move to a different place and run:
   - `/spawn set`
3. Start app-server again in `T2`.
4. In `T3`, open `world.json` and check `spawn` values changed to the new location.

Expected:
- app-server starts cleanly
- local `world.json` reflects the client-side spawn update

### LITE-03: App-server -> Client (Local-only edit)
1. Stop app-server.
2. Edit `world.json` manually and set `spawn.position` to a very obvious value (example `[0, 10, 0]`).
3. Start app-server.
4. In client, rejoin the world.

Expected:
- player spawns at/near the edited local spawn value
- local change is pushed into runtime

### LITE-04: Conflict Detection and User Resolution
This case validates strict conflict UX using a field users can change from both sides (`spawn`).

1. Ensure `.env` still has `SYNC_STRICT_CONFLICTS=true`.
2. Stop app-server.
3. Local change: edit `world.json` `spawn.position` to value A (example `[0, 2, 0]`).
4. Client change: in browser, move somewhere else and run `/spawn set` (value B).
5. Start app-server.

Expected:
- app-server startup fails with sync conflict message

Resolve:
1. List conflicts:
   - `node /home/peezy/repos/github/lobby/runtime/bin/gamedev.mjs sync conflicts`
2. Resolve one conflict:
   - remote wins: `... sync resolve <id> --use remote`
   - local wins: `... sync resolve <id> --use local`
3. Restart app-server.
4. Rejoin client and verify spawn matches the chosen resolution.

Expected:
- conflict can be listed and resolved from CLI
- app-server starts after resolution

### LITE-05: Restart Catch-up
1. Keep app-server running.
2. Note current cursor quickly:
   - `node /home/peezy/repos/github/lobby/runtime/bin/gamedev.mjs sync status`
3. Stop app-server.
4. In client, run `/spawn set` again at a new location.
5. Restart app-server.
6. Run `sync status` again.

Expected:
- app-server catches up after restart
- status remains healthy

### LITE-06: Phase 6 Rename Smoke (Optional)
1. Stop app-server.
2. Rename one app folder under `apps/`.
3. Start app-server.
4. Run `sync status` and watch logs for errors.

Expected:
- no crash
- no obvious duplicate/recreate behavior in normal client usage

## QA-like Negative Checks (Low Effort)

- Wrong `WORLD_ID` in `.env`:
  - expected: app-server exits with world-id mismatch protection.
- Wrong `ADMIN_CODE` in `.env`:
  - expected: app-server fails to connect/authorize.
- Strict conflict disabled:
  - set `SYNC_STRICT_CONFLICTS=false` and repeat `LITE-04`.
  - expected: startup continues with warning instead of hard fail.

## Pass Criteria for This Light Guide
Treat this run as good if all are true:
- startup works repeatedly without unexpected failures
- client-side edits are pulled to local when app-server was offline
- local edits are pushed to runtime on next startup
- conflict path is user-visible and resolvable with `gamedev sync resolve`
- reconnect/restart catch-up behaves consistently

## Notes
- This is intentionally low-intensity and user-workflow-oriented.
- It is a smoke/acceptance pass, not a replacement for the full manual or integration test suite.
