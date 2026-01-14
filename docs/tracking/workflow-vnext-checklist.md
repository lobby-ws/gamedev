# Workflow vNext Checklist (No Multi-Scene)

This is a tracked, PR-sized implementation checklist for the next authoring/deploy workflow.

## Scope

**In scope**
- Layout (“scene”) authoring happens primarily in the admin client and is live-visible when editing the active scene.
- Layout is also syncable to disk (`world.json`) for version control and automation (**bidirectional**).
- Code is **dev-server → runtime only** (admins can view code in runtime, but cannot edit it there).
- Templates (“blueprints”) are global to a runtime (shared across scenes; multi-scene itself is out of scope here).
- Add per-instance prop overrides so cloning/variation does not require duplicating templates.
- Dev-server UX + safety: multi-targets, deploy locks, rollback.

**Out of scope**
- “Single runtime ↔ multiple stored scenes with one active” (scene registry, switching, multi-scene files/folders).
- Platform identity (login, avatars, user sync) — pinned for later.

## Working Assumptions / Invariants

- **Terminology:** we’ll start saying “scene” in UX/docs, but internally we can keep existing identifiers (“world”, `world.json`) until the multi-scene work lands.
- **Templates are shared:** template edits affect all instances across the runtime.
- **Instance variation:** default editing target is *instance overrides*; template defaults are still editable but are a conscious mode switch.
- **Safety:** runtime must enforce permissions (UI-only restrictions aren’t enough).

## References (existing docs/plans)

- `docs/App-server.md` (current sync agent behavior)
- `docs/world-seed-manifest-plan.md` (`world.json` manifest + blueprint library model)
- `docs/admin-client-implementation-plan.md` (admin client + binary `/admin` WS)
- `PLAN_CLI.md` (project-based CLI direction)

## Recommended sequencing

- **A (instance props):** PR-A1 → PR-A2 → PR-A3 → PR-A4
- **B (code dev-only):** PR-B1 → PR-B2 → PR-B3
- **C (live flag):** PR-C1 → PR-C2
- **D (deploy safety):** PR-D1 → PR-D2 → PR-D3 → PR-D4 (optional)
- **E (docs):** PR-E1 should land incrementally (or at least once after A/B/D)

---

# PR Checklist

## Epic A — Per-instance prop overrides (and clone semantics)

### PR-A1: Instance override schema + runtime effective props (S)
- [x] Add `entity.props` (or `entity.overrides`) to app-entity data model (client+server).
- [x] Compute `effectiveProps = merge(blueprint.props, entity.props)` and pass to script exec.
  - Update `src/core/entities/App.js` to use `effectiveProps` instead of `blueprint.props`.
- [x] Ensure changing instance props triggers a rebuild (same UX as template prop edits today).
- [x] Acceptance: edit an instance prop and only that instance changes; template defaults remain unchanged.
- **Touches (likely):** `src/core/entities/App.js`
- **Manual test:** place 2 instances → override prop on one → confirm only one changes.

### PR-A2: Persist/sync instance props in server + app-server manifest (M)
- [x] Server: allow `entity_modify` to set/clear instance props for `type: "app"` (validate shape is JSON object).
- [x] Include instance props in `world.json` export/import:
  - Update `app-server/WorldManifest.js` schema + `fromSnapshot()` mapping.
  - Update `app-server/direct.js` manifest apply logic to round-trip instance props.
- [x] Acceptance: builder changes instance props → app-server writes them into `world.json`; editing `world.json` props applies back into runtime.
- **Touches (likely):** `src/core/entities/App.js`, `src/core/systems/ServerNetwork.js`, `app-server/WorldManifest.js`, `app-server/direct.js`
- **Manual test:** run app-server → edit instance props in admin → confirm `world.json` updates → edit `world.json` → confirm runtime updates.

### PR-A3: Builder/admin UI edits instance props by default (M)
- [x] Update field editors to read/write instance props (not template props):
  - `src/client/components/Sidebar.js` (`AppFields`)
  - `src/client/components/MenuApp.js` (`MenuItemFields`)
- [x] Add “Template Defaults” mode (explicit toggle) for editing `blueprint.props`.
- [x] Add per-field actions:
  - Reset override → delete key from instance props.
  - Promote override → set blueprint default then delete override (optional; can be follow-up).
- [x] Acceptance: UI shows whether a field is overridden; reset returns to template default.
- **Touches (likely):** `src/client/components/Sidebar.js`, `src/client/components/MenuApp.js`
- **Manual test:** override a field → verify indicator → reset → verify it returns to default and removes override key.

### PR-A4: Clone/unlink UX: clone instance + overrides, not templates (M)
- [x] Change duplicate/clone to:
  - duplicate the entity
  - copy instance props into the new entity (decide separately whether `state` should clone or reset)
  - keep the same blueprint id (no template duplication).
- [x] Replace current “unlink (U)” behavior:
  - either remove it, or repurpose into explicit “Fork Template From Instance” (duplicates blueprint + assigns).
- [x] Deprecate/ignore `blueprint.unique` in the default UX path (keep compat only if needed).
- [x] Acceptance: cloning produces a visually identical copy, but changing props on one does not affect the other.
- **Touches (likely):** `src/core/systems/ClientBuilder.js`
- **Manual test:** clone instance → change override on clone → original unchanged; “fork template” (if kept) creates a new blueprint id.

---

## Epic B — Code is dev-only (runtime view-only)

### PR-B1: Separate deploy capability from builder admin (M)
- [x] Add a deploy credential distinct from `ADMIN_CODE` (suggested: `DEPLOY_CODE`).
- [x] Extend `/admin` auth to establish a session role/capabilities:
  - builder: layout + instance props + template metadata/flags (as allowed)
  - deploy: template script updates (and optionally template config updates)
- [x] Server enforcement:
  - reject `blueprint_modify` that changes `script` unless session has deploy capability.
  - return clear error (`deploy_required`) so clients can message correctly.
- [x] Update app-server to authenticate as deploy-capable for script updates.
- [x] Acceptance: admin client cannot modify scripts even if it tries; dev-server can still deploy scripts.
- **Touches (likely):** `src/server/admin.js`, `app-server/direct.js`, `app-server/commands.js`
- **Manual test:** admin client attempts script save → rejected; app-server deploy still succeeds.

### PR-B2: Make script UI view-only (S/M)
- [x] UI: make the code editor read-only and remove save/upload paths:
  - `src/client/components/ScriptEditor.js` (disable Ctrl/Cmd+S action, set editor `readOnly`)
  - remove “Save” affordances in `src/client/components/Sidebar.js` script pane header
  - update `src/client/components/MenuApp.js` “Code” hint to “View code”
- [x] UI copy: show “Code is managed by dev server” with optional “Copy” button.
- [x] Acceptance: you can open code, select/copy, but can’t persist any edits.
- **Touches (likely):** `src/client/components/ScriptEditor.js`, `src/client/components/Sidebar.js`, `src/client/components/MenuApp.js`
- **Manual test:** edit text in code view (should be blocked) + press Ctrl/Cmd+S (no-op) + copy still works.

### PR-B3: Dev-server UX for code deploy (M)
- [x] Add/standardize commands for code deploy:
  - one-shot deploy (`hyperfy apps deploy <app>`)
  - watch/sync (`hyperfy dev` or existing `app-server` entry)
- [x] Ensure deploy tool prints which target/world it is writing to (URL + worldId) before mutating.
- [x] Acceptance: code changes only travel via dev-server; runtime never edits code.

---

## Epic C — Admin client “live” flag (runtime overlays)

### PR-C1: Protocol: subscriptions vs `needsHeartbeat` (M)
- [ ] Replace/extend `needsHeartbeat` with explicit subscription options, e.g.:
  - `snapshot: true`
  - `players: boolean`
  - `runtime: boolean` (future: gameplay-driven entity/runtime updates)
- [ ] Server: maintain separate subscriber sets so “non-live” admin sessions:
  - still receive authored state + edits
  - do not receive player streams (and later: runtime overlays).
- [ ] App-server should use a minimal subscription (no players, no runtime overlays).
- [ ] Acceptance: admin client can connect in non-live mode and does not receive player updates.
- **Touches (likely):** `src/server/admin.js`, `src/core/systems/AdminNetwork.js`, `app-server/direct.js`
- **Manual test:** connect admin client in non-live → confirm no `playerUpdated` packets processed; live mode shows players.

### PR-C2: Admin UI toggle for live mode (S/M)
- [ ] Add UI toggle (persisted in local storage) controlling the connection subscription.
- [ ] On toggle, reconnect or send a subscription update message (choose simplest first).
- [ ] Acceptance: toggling live on/off starts/stops player overlays without breaking building/editing.
- **Touches (likely):** `src/client/components/CoreUI.js` (or wherever best), `src/core/systems/AdminNetwork.js`
- **Manual test:** toggle live while connected → players appear/disappear; building continues to work.

---

## Epic D — Safer deploys (multi-targets, locks, rollback)

### PR-D1: Multi-target config (M)
- [ ] Add a repo-local config format for targets (suggested: `.hyperfy/targets.json`):
  - named targets: `dev`, `staging`, `prod`
  - `worldUrl`, `worldId`, `adminCode`, `deployCode` (as applicable)
- [ ] Add `--target <name>` to dev-server/app-server CLI and `hyperfy` wrapper commands.
- [ ] Acceptance: same project can deploy to different targets without editing `.env`.
- **Touches (likely):** `app-server/commands.js`, `app-server/cli.js`, (optional) `bin/hyperfy.mjs`
- **Manual test:** define 2 targets → run deploy with `--target staging` → confirms correct URL/worldId printed.

### PR-D2: Deploy lock/session (M)
- [ ] Server: add deploy lock primitives (HTTP or WS):
  - acquire lock → returns token + ttl
  - renew lock
  - release lock
  - status (owner + age)
- [ ] Enforce lock on deploy-capable blueprint changes (at least `script` updates).
- [ ] App-server: acquire lock before deploy; fail fast with a helpful message if locked.
- [ ] Acceptance: two deploy agents cannot silently last-writer-wins; second one gets a clear “locked” error.
- **Touches (likely):** `src/server/admin.js`, `app-server/direct.js`, `app-server/commands.js`
- **Manual test:** start two deploy processes → first acquires lock → second gets “locked”; releasing allows second to proceed.

### PR-D3: Lightweight rollback (M)
- [ ] Implement “snapshot before deploy”:
  - store previous blueprint records (and any other mutated data) under a deploy snapshot id.
  - include optional metadata: target name, timestamp, note.
- [ ] Implement “rollback last snapshot” endpoint/command.
- [ ] Acceptance: deploy script change → rollback restores previous script refs/config in runtime.
- **Touches (likely):** `src/server/db.js` (new table/migration), `src/server/admin.js`, `app-server/commands.js`
- **Manual test:** deploy change → verify snapshot created → rollback → verify blueprint points back to previous script hash.

### PR-D4 (Optional): Deploy diff / dry-run / confirmation (M)
- [ ] Add a diff summary (local vs remote) before deploy.
- [ ] Add `--dry-run` and/or confirmation gate for `prod` targets.
- [ ] Acceptance: operators can see what will change before it changes.

---

## Epic E — Docs and polish

### PR-E1: Documentation pass (S/M)
- [ ] Update `docs/App-server.md` to reflect:
  - code is dev-only
  - instance overrides vs template defaults
  - multi-target, lock, rollback
- [ ] Add a short “Recommended workflow” doc for builders vs developers (admin client vs dev-server).
- [ ] Acceptance: a new user can understand “what edits happen where” without tribal knowledge.
