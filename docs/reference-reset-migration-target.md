# Reference-Reset Migration Target

Status: Draft  
Owners: `runtime` + `world-service`  
Last Updated: 2026-02-10

## Goal

Define the canonical migration history after a **reset starting from the reference runtime migrations**, not a full greenfield rewrite.

Assumptions:
1. World-state reset is allowed.
2. We are moving to one schema per world.
3. `WORLD_ID` is canonical and immutable.
4. `deployment_id` compatibility can be removed from runtime world-state migrations.

## Baseline To Keep (Reference Chain)

Keep reference migrations `#1` to `#19` as the baseline (`reference/src/server/db.js`):
1. add users table
2. add blueprints & entities tables
3. add blueprint.version field
4. add user.vrm field
5. add blueprint.config field
6. rename user.vrm -> user.avatar
7. add blueprint.preload field
8. blueprint.config -> blueprint.props
9. add blueprint.public and blueprint.locked fields
10. add blueprint.unique field
11. rename config key to settings
12. add blueprint.disabled field
13. add entity.scale field
14. add blueprint.scene field
15. migrate or generate scene app
16. ensure settings exists with defaults
17. migrate roles to rank
18. add settings.customAvatars
19. change config.value to text

## Runtime: Post-Reference Migrations To Keep

From `runtime/src/server/db.js`, keep only migrations that represent active, non-bridge features:

1. old runtime `#22`: add `deploy_snapshots` table
2. old runtime `#26`: add durable `sync_changes` table (+ indexes)

Optional (recommended only if bidirectional sync metadata is required immediately after reset):
1. old runtime `#24`: backfill blueprint `createdAt` + `keep`
2. old runtime `#25`: backfill sync metadata on blueprint/entity JSON

## Runtime: Post-Reference Migrations To Remove

Remove these old runtime migrations from the new canonical chain:

1. old runtime `#20` (`persist worldId in config`)
Reason: world id can be ensured at runtime start; no historical migration needed.

2. old runtime `#21` (`seed default template blueprints`)
Reason: transition helper from old bootstrap behavior.

3. old runtime `#23` (`set built-in templates to unique=true`)
Reason: dependent on old seeded built-ins.

4. old runtime `#27` (`remove legacy built-in template blueprints`)
Reason: bridge cleanup for old built-in/scriptRef variants.

5. old runtime `#28` (`align schema fields with deployment_id support`)
Reason: deployment-scoped world-state migration is obsolete under per-world schema isolation.

## World-Service Migration Cleanup (For This Direction)

`world-service` migration chain to keep:
1. `20260128_001_initial.ts`
2. `20260128_002_user_worlds.ts`
3. `20260128_003_gameserver.ts`
4. `20260204_005_align_users_runtime.ts`

Candidate to remove/deprecate from new reset baseline:
1. `20260131_004_add_deployment_id.ts`
Reason: runtime tenancy is schema-per-world; canonical identity is `world.id`.

Note:
1. If `worlds.deployment_id` is temporarily retained as alias for compatibility, keep it out of runtime world-state coupling and keep it equal to `worlds.id`.

## Canonical Runtime Chain After Reset

Minimal recommended chain:
1. reference `#1` through `#19`
2. add `deploy_snapshots`
3. add `sync_changes`

Extended chain (if metadata backfill is needed immediately):
1. reference `#1` through `#19`
2. add `deploy_snapshots`
3. add blueprint `createdAt` + `keep` JSON fields
4. add sync metadata backfill for blueprints/entities
5. add `sync_changes`

## Mapping Table (Old Runtime -> New Plan)

1. `#1-#19`: keep (reference baseline)
2. `#20`: drop
3. `#21`: drop
4. `#22`: keep
5. `#23`: drop
6. `#24`: optional
7. `#25`: optional
8. `#26`: keep
9. `#27`: drop
10. `#28`: drop
