# App-server <-> Runtime Bidirectional Sync Migration Plan

## Context

The current system is optimized for a mostly one-way flow:

- Local project (`apps/`, `assets/`, `world.json`) is treated as the desired state.
- On startup, app-server pushes local blueprints and manifest state to runtime.
- Runtime changes are mirrored back to disk mainly as convenience sync.

This creates repeated overwrite behavior and weak conflict handling when both sides change state. The goal of this migration is to move to a true bidirectional model where both app-server and runtime are first-class writers.

## Goals

- Make sync semantics explicit and deterministic for two-way edits.
- Preserve user intent from both local edits and in-world edits.
- Replace implicit ID-derived scoping with explicit ownership/scope metadata.
- Support resumable, ordered sync through durable change cursors.
- Execute a fast cutover to bidirectional sync without maintaining legacy behavior modes.

## Non-goals

- Replacing `/admin` transport in this migration.
- Solving multi-user collaborative authoring semantics in one phase.
- Removing existing deploy lock/snapshot concepts immediately.
- Supporting legacy world schemas or ID conventions.

## Current Baseline Assumptions To Retire

1. Startup is always local -> runtime apply.
2. `world.json` is always canonical layout state.
3. Version conflicts resolve as local overwrite.
4. Blueprint lock/snapshot scope is inferred from blueprint ID format.
5. Directory layout (`apps/<app>`) is equivalent to object identity.
6. Event stream is sufficient without resume/cursor support.
7. No durable sync baseline is required between sessions.

## Target Model

### Sync Roles

- Runtime: authoritative for accepted world state and ordered change log.
- App-server: authoritative for local file intent and reconciliation policy.
- Neither side blindly overwrites; both produce ops against a shared baseline.

### Identity

- Introduce stable object IDs independent of folder/file naming.
- Add explicit metadata fields for scope/ownership instead of deriving from `id` string structure.

### Reconciliation

- Use three-way merge for mutable objects:
  - `base` = last synced state
  - `local` = filesystem state
  - `remote` = runtime current state
- Apply merge policy per field and per object type.

### Durability

- Runtime exposes ordered changefeed with cursor.
- App-server stores sync cursor + object baselines locally.

## Phased Migration

## Phase 0: Cutover Guardrails

### Deliverables

- Add minimal feature flags:
  - `BIDIRECTIONAL_SYNC=true|false`
  - `SYNC_STRICT_CONFLICTS=true|false`
- Enable new changefeed endpoints directly in the cutover branch (no legacy toggle matrix).
- Add telemetry counters for overwrite/conflict paths in current code.

### Acceptance

- Metrics visible for startup overwrites, version mismatches, lock failures.
- Cutover can be disabled only as an emergency rollback switch (`BIDIRECTIONAL_SYNC=false`).

## Phase 1: Data Model and Metadata Stabilization

### Runtime schema additions

Add fields to blueprint/entity records (or companion metadata table):

- `uid`: stable UUID (non-derivative identity).
- `scope`: explicit lock/deploy scope.
- `managedBy`: `local|runtime|shared`.
- `updatedAt`, `updatedBy`, `updateSource`.
- `lastOpId` (optional, if operation log stores this globally).

### App-server local metadata

Create `.lobby/sync-state.json`:

- `worldId`
- `cursor`
- per-object baseline hashes and last synced revisions
- last conflict snapshots

### Acceptance

- All blueprint/entity rows in target environments contain required sync metadata before cutover enablement.
- No lazy backfill path is required at runtime.

## Phase 2: Runtime Changefeed + Cursor API

### API additions

- `GET /admin/changes?cursor=<cursor>&limit=<n>`
- response includes ordered operations, monotonically increasing cursor.
- operation envelope:
  - `opId`
  - `ts`
  - `actor`
  - `source`
  - `kind` (`blueprint.add`, `blueprint.update`, `entity.update`, etc.)
  - `objectUid`
  - `patch` or full object snapshot

### Semantics

- At-least-once delivery with idempotent op IDs.
- Cursor replay supported after disconnect/restart.

### Acceptance

- App-server can reconnect and catch up exactly once logically.
- Event-stream-only sync no longer required for correctness.

## Phase 3: Explicit Scope and Locking Refactor

### Changes

- Stop deriving lock scope from blueprint `id` format.
- Lock and snapshot endpoints accept explicit `scope` and validate against object metadata.
- Reject ambiguous operations where object scope is unknown.

### Acceptance

- Scope comes only from explicit metadata and never from ID parsing.
- Deploy snapshots operate on true object scope sets.

## Phase 4: Startup Handshake Redesign

Replace current startup apply-all behavior with handshake:

1. Fetch runtime snapshot + current cursor.
2. Read local project state + local sync baseline.
3. Compute diff sets:
   - local-only changes
   - remote-only changes
   - concurrent changes
4. Apply policy:
   - fast-forward local from remote for remote-only
   - push local ops for local-only
   - run 3-way merge/conflict resolver for concurrent
5. Persist new baseline and cursor atomically.

### Acceptance

- Restart with unchanged state produces zero writes.
- One-sided edits apply without unnecessary overwrite.

## Phase 5: Reconciliation Engine

### Object-level policy

Define merge policy per object class:

- Blueprints:
  - script fields
  - metadata fields
  - props defaults
- Entity instances:
  - transform fields
  - instance props
  - state blobs (likely runtime-authoritative unless flagged)
- World settings/spawn:
  - explicit ownership policy per key

### Conflict handling

Conflict output includes:

- object UID and type
- base/local/remote values
- auto-resolution if safe
- manual-resolution artifact in `.lobby/conflicts/`

### CLI support

- `gamedev sync status`
- `gamedev sync conflicts`
- `gamedev sync resolve <id> --use local|remote|merged`

### Acceptance

- Conflicts are explicit and recoverable.
- No silent local-wins fallback in bidirectional mode.

## Phase 6: File Layout Decoupling from Identity

### Changes

- Treat filesystem path as projection, not identity.
- Keep stable `uid` + explicit `id` mapping in metadata index.
- Allow file rename/move without object recreation.

### Acceptance

- Renaming a local app folder does not recreate runtime objects.
- Filesystem projection is stable without inferred identity fallbacks.

## Phase 7: Direct Cutover Rollout

### Rollout strategy

1. Ship schema/API/reconciliation changes to staging.
2. Run burn-in with production-like fixtures and strict conflict mode.
3. Enable bidirectional sync in canary environments.
4. Enable bidirectional sync globally.

## Phase 8: Post-cutover Cleanup

### Cleanup

- Remove one-way startup apply paths immediately after cutover validation.
- Remove any ID-format-derived scope logic.
- Delete obsolete one-way sync codepaths and commands.

### Acceptance

- Bidirectional sync is the only supported mode.
- Emergency rollback switch remains available only for operational safety, not product behavior.

## Concrete Code Touchpoints

These are the primary places that need refactor as part of migration:

- `app-server/direct.js`
  - `start()` startup flow
  - `_deployAllBlueprints()` / `_applyManifestToWorld()` startup assumptions
  - version mismatch overwrite behavior
  - watcher-triggered push semantics
- `src/server/admin.js`
  - deploy lock scope derivation
  - snapshot scope validation
  - add changefeed endpoints
- `src/core/systems/ServerNetwork.js`
  - operation emission metadata (`actor`, `source`, revision)
- `app-server/WorldManifest.js`
  - represent partial/owned layout instead of global desired state
- CLI (`bin/gamedev.mjs`, `app-server/commands.js`)
  - sync status/conflict commands and mode toggles

## Testing Plan

### Unit

- Scope resolution from explicit metadata.
- 3-way merge behavior per field type.
- Conflict serialization/deserialization.

### Integration

- Startup no-op with identical local/remote state.
- Local-only, remote-only, and concurrent edits.
- Cursor resume after disconnect/restart.
- Rename/move file without identity loss.

### End-to-end

- Multi-app world with mixed explicit scopes and non-derivative IDs.
- Long-running session with in-world edits + local git edits.
- Rollback from conflicts and replay from baseline.

## Observability and Ops

Track metrics:

- `sync.ops.local_to_remote`
- `sync.ops.remote_to_local`
- `sync.conflicts.total`
- `sync.conflicts.auto_resolved`
- `sync.overwrites.prevented`
- `sync.cursor.lag`
- `sync.handshake.duration_ms`

Add structured logs with world ID, object UID, op ID, and resolution mode.

## Cutover Preconditions

- All target environments are non-legacy and can accept schema/API breaking changes.
- Required metadata (`uid`, `scope`, ownership fields) is pre-seeded before cutover day.
- Operational runbook is prepared for emergency rollback switch use.

## Risks and Mitigations

- Risk: Increased complexity in sync engine.
  - Mitigation: strict phase gating with hard acceptance criteria before cutover.
- Risk: Merge bugs causing data drift.
  - Mitigation: baseline snapshots, conflict artifacts, replayable changefeed.
- Risk: Broad blast radius from direct cutover.
  - Mitigation: canary rollout, runtime kill switch, and clear rollback runbook.

## Definition of Done (Program-level)

- Bidirectional sync works without blind overwrite in production-like worlds.
- Restart behavior is idempotent and minimal-change.
- Conflicts are explicit, reviewable, and resolvable.
- ID naming style no longer determines correctness.
- One-way sync assumptions are removed from startup and steady-state code paths.
