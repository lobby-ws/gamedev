# App-server <-> Runtime Bidirectional Sync Manual Testing Guide

## Scope
This guide validates the end-to-end bidirectional sync experience through **Phase 6** in `docs/App-server-runtime-bidirectional-migration-plan.md`.

It covers:
- startup handshake behavior
- local and runtime edit reconciliation
- conflict detection and resolution
- cursor durability and replay
- explicit scope + deploy lock behavior
- file-layout decoupling from identity

It does not cover:
- Phase 7 rollout/canary operations
- Phase 8 post-cutover cleanup/removal of legacy codepaths

## Implementation Status Checkpoint (End of Phase 6)
Current repo state supports the Phase 0-6 implementation set.

Evidence:
- Phase-focused integration suite passes:
  - `test/integration/sync-phase1.test.js`
  - `test/integration/sync-phase2.test.js`
  - `test/integration/deploy-scope.test.js`
  - `test/integration/sync-phase4.test.js`
  - `test/integration/sync-phase5.test.js`
  - `test/integration/sync-phase6.test.js`
- CLI sync tooling exists:
  - `gamedev sync status`
  - `gamedev sync conflicts`
  - `gamedev sync resolve <id> --use local|remote|merged`

Note:
- Program-level work is not fully complete until Phase 7 and Phase 8 are done.

## Test Environment
Use 3 terminals.

- `T1`: world server
- `T2`: app-server
- `T3`: QA commands / file edits

### Prerequisites
- Node `22.11.0`
- `npm install` already run in runtime repo
- `jq` installed (optional, but recommended)

### Variables
Set these in `T3` (adjust paths):

```bash
export RUNTIME_DIR=/home/peezy/repos/github/lobby/runtime
export QA_ROOT=/tmp/bidi-qa
export PROJECT_DIR=$QA_ROOT/project
export WORLD_DATA_DIR=$QA_ROOT/world-data
export WORLD_URL=http://127.0.0.1:3000
export WORLD_ID=local-bidi-qa
export ADMIN_CODE=qa-admin
```

### Create Clean QA Workspace

```bash
rm -rf "$QA_ROOT"
mkdir -p "$PROJECT_DIR" "$WORLD_DATA_DIR"
cat > "$PROJECT_DIR/.env" <<ENV
WORLD_URL=$WORLD_URL
WORLD_ID=$WORLD_ID
ADMIN_CODE=$ADMIN_CODE
BIDIRECTIONAL_SYNC=true
SYNC_STRICT_CONFLICTS=true
ENV
```

### Start World Server (T1)

```bash
cd "$RUNTIME_DIR"
npm run build
WORLD="$WORLD_DATA_DIR" WORLD_URL="$WORLD_URL" WORLD_ID="$WORLD_ID" ADMIN_CODE="$ADMIN_CODE" PORT=3000 npm start
```

### Start App-server (T2)

```bash
cd "$PROJECT_DIR"
source .env
node "$RUNTIME_DIR/app-server/server.js"
```

Expected first-run behavior:
- `apps/`, `assets/`, `world.json`, and `.lobby/` are created in `$PROJECT_DIR`
- app-server logs `Connected ... (/admin)`

### Useful QA Commands (T3)

```bash
cd "$PROJECT_DIR"
source .env

# Sync status and conflicts
node "$RUNTIME_DIR/bin/gamedev.mjs" sync status
node "$RUNTIME_DIR/bin/gamedev.mjs" sync conflicts

# Runtime snapshot and cursor
curl -sS -H "x-admin-code: $ADMIN_CODE" "$WORLD_URL/admin/snapshot" | jq '.worldId, (.blueprints|length), (.entities|length)'
curl -sS -H "x-admin-code: $ADMIN_CODE" "$WORLD_URL/admin/changes" | jq '.cursor, .headCursor, (.operations|length)'

# Local sync artifacts
cat .lobby/sync-state.json
cat .lobby/blueprint-index.json
```

## Test Matrix

| ID | Priority | Phase Coverage | Scenario |
| --- | --- | --- | --- |
| BIDI-01 | P0 | 1,2,4 | Startup no-op and baseline files |
| BIDI-02 | P0 | 4 | Remote-only edit fast-forwards to disk |
| BIDI-03 | P0 | 4 | Local-only edit pushes to runtime |
| BIDI-04 | P0 | 5 | Concurrent non-overlapping changes auto-merge |
| BIDI-05 | P0 | 5 | Strict conflict detection + artifact + manual resolve |
| BIDI-06 | P0 | 6 | Folder rename on startup does not recreate runtime object |
| BIDI-07 | P0 | 6 | Live folder rename does not recreate runtime object |
| BIDI-08 | P0 | 2 | Cursor catch-up after app-server restart |
| BIDI-09 | P1 | 3 | Multi-scope snapshot requires global scope lock |
| BIDI-10 | P1 | 3 | Script blueprint without scope is rejected |
| BIDI-11 | P1 | 0 | Emergency rollback switch (`BIDIRECTIONAL_SYNC=false`) |
| BIDI-12 | P2 | 2 | Changefeed invalid cursor/limit handling |

## Detailed Test Cases

### BIDI-01: Startup No-op and Baseline Files
1. Ensure app-server is running (T2) and initial scaffold completed.
2. Record runtime head cursor:
   - `HEAD_BEFORE=$(curl -sS -H "x-admin-code: $ADMIN_CODE" "$WORLD_URL/admin/changes" | jq -r '.headCursor // .cursor')`
3. Stop app-server (Ctrl+C in T2), then restart it (same command in T2).
4. Record runtime head cursor again:
   - `HEAD_AFTER=$(curl -sS -H "x-admin-code: $ADMIN_CODE" "$WORLD_URL/admin/changes" | jq -r '.headCursor // .cursor')`
5. Inspect `.lobby/sync-state.json`.

Expected:
- `HEAD_AFTER == HEAD_BEFORE` (no writes on restart when unchanged)
- `.lobby/sync-state.json` exists with `formatVersion`, `worldId`, `cursor`, and object baselines
- `node "$RUNTIME_DIR/bin/gamedev.mjs" sync status` reports no errors

### BIDI-02: Remote-only Edit Fast-forwards to Disk
1. Keep app-server stopped.
2. Open the world in browser (`$WORLD_URL`), become admin (`/admin <code>` if needed), then modify one app blueprint field and one entity prop in-world.
3. Record head cursor before restarting app-server.
4. Restart app-server (T2).
5. Inspect local files in `$PROJECT_DIR/apps/.../*.json` and `world.json`.

Expected:
- Runtime head cursor does not increase during reconciliation restart
- Local files are updated to reflect runtime-only edits
- No conflict artifact is created for non-overlapping remote-only edits

### BIDI-03: Local-only Edit Pushes to Runtime
1. Keep app-server stopped.
2. Edit one blueprint JSON field locally (for example `desc`) and one entity prop in `world.json`.
3. Record head cursor before restart.
4. Restart app-server (T2).
5. Query `/admin/snapshot`.

Expected:
- Runtime reflects local changes
- Head cursor increases
- `.lobby/sync-state.json` updates cursor and hashes

### BIDI-04: Concurrent Non-overlapping Auto-merge
1. Keep app-server stopped.
2. Local change: edit blueprint field A (example `desc`).
3. Runtime change: edit different blueprint field B in-world (example `name`).
4. Restart app-server.
5. Verify local file and runtime snapshot both contain A + B.

Expected:
- Auto-merge succeeds
- No open conflict artifacts
- App-server starts normally

### BIDI-05: Strict Conflict + Manual Resolve
1. Confirm `.env` has `SYNC_STRICT_CONFLICTS=true`.
2. Keep app-server stopped.
3. Local change: edit blueprint field `desc` to value `local-conflict`.
4. Runtime change: edit same blueprint field `desc` to value `remote-conflict`.
5. Start app-server.

Expected on start:
- App-server fails startup with `Sync conflict detected ...`
- Conflict artifact exists in `.lobby/conflicts/*.json`

Resolve:
1. List conflicts:
   - `node "$RUNTIME_DIR/bin/gamedev.mjs" sync conflicts`
2. Resolve one conflict using remote:
   - `node "$RUNTIME_DIR/bin/gamedev.mjs" sync resolve <conflict-id> --use remote`
3. Re-run `sync conflicts`.
4. Re-start app-server.

Expected after resolve:
- Artifact status changes to `resolved`
- Local file matches chosen resolution
- App-server starts successfully

### BIDI-06: Startup Rename Does Not Recreate Runtime Object
1. Keep app-server stopped.
2. Rename app folder, for example:
   - `mv apps/myapp apps/myapp-renamed`
3. In renamed blueprint JSON, remove explicit `id` and `uid` fields if present.
4. Record runtime head cursor.
5. Start app-server.
6. Query `/admin/snapshot` and `.lobby/blueprint-index.json`.

Expected:
- No new runtime blueprint is created from rename
- Existing blueprint/entity IDs remain stable
- Head cursor unchanged by startup reconciliation
- `.lobby/blueprint-index.json` updates projection path to renamed folder

### BIDI-07: Live Rename Does Not Recreate Runtime Object
1. Start app-server and keep it running.
2. Rename an app folder while app-server is live.
3. Wait ~2-3 seconds for watcher processing.
4. Query runtime head cursor and snapshot.

Expected:
- No remove/add churn for the renamed app object
- No duplicate blueprint appears
- Existing UID/identity remains stable

### BIDI-08: Cursor Catch-up After Restart
1. Start app-server and capture local cursor:
   - `jq '.cursor' .lobby/sync-state.json`
2. Stop app-server.
3. Make runtime edits in-world.
4. Restart app-server.
5. Check local cursor again.

Expected:
- Cursor increases after reconnect
- Local state catches up with runtime operations
- No replay duplication side effects

### BIDI-09: Multi-scope Snapshot Requires Global Scope Lock
1. Create or ensure two blueprints exist with different `scope` values.
2. Acquire scoped lock (`scope-a`) and attempt snapshot for both IDs.
3. Acquire global lock and retry snapshot.

Example commands:

```bash
# scoped lock
SCOPE_TOKEN=$(curl -sS -H "x-admin-code: $ADMIN_CODE" -H 'content-type: application/json' \
  -d '{"owner":"qa","scope":"scope-a"}' "$WORLD_URL/admin/deploy-lock" | jq -r '.token')

# should fail with multi_scope_not_supported
curl -sS -H "x-admin-code: $ADMIN_CODE" -H 'content-type: application/json' \
  -d "{\"ids\":[\"ScopeA\",\"ScopeB\"],\"lockToken\":\"$SCOPE_TOKEN\",\"scope\":\"scope-a\"}" \
  "$WORLD_URL/admin/deploy-snapshots" | jq
```

Expected:
- scoped request fails with `multi_scope_not_supported`
- global-scope lock succeeds for mixed-scope snapshot

### BIDI-10: Script Blueprint Without Scope Is Rejected
1. Attempt to add/modify a script blueprint without scope metadata (via admin tooling).
2. Ensure lock token is valid for request.

Expected:
- Operation rejected with `scope_unknown`

### BIDI-11: Emergency Rollback Switch (`BIDIRECTIONAL_SYNC=false`)
1. Set in `.env`:
   - `BIDIRECTIONAL_SYNC=false`
2. Restart app-server.
3. Perform startup and one edit cycle.

Expected:
- App-server uses legacy one-way startup behavior
- Use this only as emergency fallback, not normal validation mode

### BIDI-12: Changefeed Input Validation
Run:

```bash
curl -sS -i -H "x-admin-code: $ADMIN_CODE" "$WORLD_URL/admin/changes?cursor=abc"
curl -sS -i -H "x-admin-code: $ADMIN_CODE" "$WORLD_URL/admin/changes?cursor=0&limit=0"
```

Expected:
- invalid cursor -> HTTP `400` + `{"error":"invalid_cursor"}`
- invalid limit -> HTTP `400` + `{"error":"invalid_limit"}`

## Additional QA-like Regression Cases
Run these after P0:

- Toggle strict conflicts off (`SYNC_STRICT_CONFLICTS=false`) and verify startup logs warning + skips unresolved objects instead of hard-failing.
- Validate `WORLD_ID` mismatch protection by intentionally setting wrong local `WORLD_ID` and confirming startup error.
- Verify `gamedev sync status` still works after conflict resolve and restart.
- Verify `.lobby/conflicts/` retains historical resolved artifacts with status transitions.
- Verify deploy lock ownership checks: wrong token should return `not_owner`.

## Sign-off Checklist
A build is ready for rollout validation when all are true:
- All P0 cases pass.
- No unexpected runtime object recreation during folder rename/move.
- Conflicts are explicit, inspectable, and resolvable through CLI.
- Restart with unchanged state is a no-op.
- Cursor replay and reconnect catch-up are reliable.
- Scope + lock validation rejects ambiguous operations.

## Suggested Evidence to Capture
For each failed or flaky case attach:
- `app-server` logs (startup + reconciliation section)
- output of `node "$RUNTIME_DIR/bin/gamedev.mjs" sync status`
- relevant `.lobby/conflicts/*.json` artifact
- `/admin/changes` response showing cursor and recent operations
