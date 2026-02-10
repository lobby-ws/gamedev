# World Projects

Hyperfy world projects are normal Node projects that contain only game code and assets. They are synced to a running world via the app-server and can be deployed explicitly for staging/production.

## Quick Start

```bash
# Scaffold a new project
npx gamedev init

# Install dependencies
npm install

# Start local world + continuous sync
npm run dev
```

The scaffolded `package.json` includes `gamedev` and `typescript` as devDependencies.
Built-in apps and a default `$scene` entry are included in `apps/` and `world.json`.

World projects are meant to live in their own repository (no engine source). The CLI syncs your files to a world server:
- If `WORLD_URL` points at localhost/127.0.0.1, `gamedev dev` starts a local world server and the app-server.
- If `WORLD_URL` is remote, `gamedev dev` skips the world server and only runs app-server sync.
- Use `.env` or `.lobby/targets.json` to point at different worlds.

## Project Layout

```
apps/                       App scripts + blueprint JSON (defaults)
assets/                     Local assets referenced by blueprints
shared/                     Shared script modules (import via @shared/ or shared/)
world.json                  World layout + per-instance overrides
tsconfig.json               TypeScript config (points at `gamedev` types)
.nvmrc                      Node version for this project
.env                         Local world/app-server config (gitignored)
.env.example                Shareable template for env vars
.lobby/targets.json         Local-only deploy targets (gitignored)
.lobby/targets.example.json  Shareable template for targets
.claude/skills/             Claude Code skill docs for app scripting
```

## What to Edit

- `apps/<AppName>/index.js` for entry scripts.
- `apps/<AppName>/**/*.js` for module helpers.
- `shared/**/*.js` for shared modules used by multiple apps.
- `apps/<AppName>/*.json` for blueprint defaults (props, model, flags, `scriptFormat`).
- `world.json` for layout and per-instance overrides.
- `assets/` for local files referenced by props/blueprints.

## What Not to Edit

- `.lobby/<worldId>/` is local runtime state.
- `.claude/settings.local.json` is per-developer.

## Authoring Mods

World-project mods live under `mods/`:

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

Authoring contracts:

- `mods/core/server/**`: server systems, loaded on world-server boot.
- `mods/core/client/**`: client systems, loaded before `world.init(...)`.
- `mods/core/shared/**`: bundled for both server and client loaders.
- `mods/client/components/**`: UI components (default export component).
- `mods/client/sidebar/**`: sidebar modules (named exports for button + pane).

Deploy and order control:

- Use `gamedev mods deploy --target <name>` for explicit deploys.
- Use `gamedev mods deploy --dry-run` to preview uploads/manifest changes.
- Use `gamedev mods order set ...` / `gamedev mods order clear` for DB override order.
- Server/shared mod deploys require a world-server restart to apply server-side changes.

## Mods Manifest Schema

When you run `gamedev mods deploy`, the deployer uploads bundled modules and writes a persisted mods manifest to the target world.

Root shape:

```json
{
  "version": 1,
  "deployedAt": "2026-02-09T00:00:00.000Z",
  "deployNote": "optional note",
  "modules": [],
  "loadOrder": {
    "order": ["core.shared.example", "core.server.example"],
    "before": {},
    "after": {}
  }
}
```

Module entry kinds:

- `system`:
  - `id` (string, unique)
  - `scope` (`server` | `client` | `shared`)
  - `serverUrl` / `clientUrl` (`asset://...`, required by scope)
  - optional `systemKey`, `sourcePath`
- `component`:
  - `id`
  - `clientUrl` (`asset://...`)
  - optional `exportName` (defaults to `default`)
- `sidebar`:
  - `id`
  - `clientUrl` (`asset://...`)
  - optional `buttonExport` (defaults to `Button`)
  - optional `paneExport` (defaults to `Pane`)

Order rules:

- Effective load-order precedence:
  1. DB override order (`mods_load_order_override`) when present and valid
  2. Deployed manifest `loadOrder`
  3. Deterministic fallback (sorted module ids)
- `loadOrder` supports either:
  - array form: `["mod.a", "mod.b"]`
  - object form:
    - `order`: sequence constraints
    - `before`: `{ "mod.a": ["mod.b"] }`
    - `after`: `{ "mod.b": ["mod.a"] }`
- Unknown ids, duplicates, and cyclic relations are rejected.

## Claude Code

The scaffold includes `.claude/skills/hyperfy-app-scripting/SKILL.md` to guide app scripting tasks. Commit the skill folder, and keep local Claude settings in `.claude/settings.local.json` (gitignored).

## Targets and Deploys

- Use `.lobby/targets.json` for local targets (dev/staging/prod).
- Commit `.lobby/targets.example.json` as the shareable template.
- Use `gamedev dev` for continuous sync (dev only).
- Use `gamedev app-server` for sync only (no local world server).
- Use `gamedev apps deploy <app>` for explicit staging/prod deploys.
- Use `gamedev mods deploy` for explicit mods deploys (separate from apps).

## Existing Worlds

If you need to pull an existing world into a local project (including scripts):

```bash
gamedev world export
#
# Add this for legacy single-file scripts:
gamedev world export --include-built-scripts
```

## Migration Notes

- Bundling is removed. Use `scriptFormat` to control how the entry is interpreted.
- Tag existing apps with `gamedev scripts migrate --legacy-body` (keep classic body scripts) or `gamedev scripts migrate --module` (convert to ESM default export).

## Scripting Reference

Use the scripting docs for runtime APIs and lifecycle:

- `docs/scripting/README.md`
- `docs/scripting/app/App.md`
- `docs/scripting/world/World.md`
