# SDK Bootstrap Flow (gamedev dev)

This describes how installing the `gamedev` package and running `gamedev dev` bootstraps a local world project into an empty directory. It explains which processes run, where files are created, and how ongoing sync works.

## Overview
- Install: add `gamedev` to a project (dev dependency or globally). The package exposes the `gamedev` CLI via the `bin` field.
- Run: from your project root, run `gamedev dev`.
- Result: a `project/` subfolder is created and initialized with a local “world project” (apps, assets, world.json, docs). This is the SDK install surface you edit locally.

## What `gamedev dev` does
- Ensures `.env` at your project root:
  - If missing, it writes defaults (local world at `http://localhost:3000`, generated IDs/secrets).
  - It validates base envs and derives URLs for the world and assets.
- Determines local vs remote world:
  - If `WORLD_URL` points to localhost/private IP, local mode is assumed; otherwise remote.
- Starts processes:
  - Local mode: spawns the world server (`build/index.js`) and waits for it to become healthy.
  - Always: spawns the app-server (`app-server/server.js`) in the working directory `./project/`.
- Uses `./project/` as the world project root:
  - The CLI creates `./project/` if it doesn’t exist and runs the app-server with `cwd` set to this folder.

## How the app-server bootstraps your project
When the app-server starts (with `cwd=./project`):
- It connects to the world’s admin API using the `.env` values passed from the parent process.
- It inspects the local project state in `./project`:
  - If both `world.json` is missing and there are no local `apps/`, and the target world snapshot is still the default, it bootstraps the local project.
- Bootstrapping writes the following (idempotently; existing files are skipped unless explicitly forced by other commands):
  - Base project files
    - `.gitignore` with sensible defaults
    - `package.json` with scripts:
      - `dev` → `gamedev dev`
      - `build` → `gamedev apps build --all`
      - `typecheck` → `tsc --noEmit`
    - `tsconfig.json` preconfigured to typecheck `apps/**` with `types: ["gamedev"]`
    - `.env.example` and `.lobby/targets.example.json`
    - `docs/` copied from the package’s docs templates (plus optional Claude docs if present)
  - Built-in apps and assets
    - `apps/<builtin>/` folders containing blueprint JSON files and an `index.ts` script per app
    - `assets/` files required by the built-in blueprints (copied from the package’s built assets/source)
  - World manifest
    - `world.json` seeded with a default scene entity so you can immediately preview and iterate

This scaffold comes from the package templates (not a blind copy of your current working dir). The structure mirrors the repository’s `project/` directory, but generation is done via the app-server’s scaffold utilities to remain stable across versions.

## Continuous sync (live dev)
After bootstrapping, the app-server keeps `./project` in sync with the world:
- Watches `apps/**` (JSON blueprints and `index.ts`/`index.js`):
  - Rebuilds scripts with esbuild, uploads new script bundles, and deploys blueprint changes over the admin channel.
- Watches `assets/**`:
  - Uploads newly referenced assets and rewrites local `asset://` references to the world’s asset URLs during deploy.
- Watches `world.json`:
  - Applies layout changes (entities, transforms, spawn) to the world.

All changes are debounced and applied incrementally. Errors are printed with build details to help you fix issues quickly.

## Related commands
- `gamedev init` — scaffolds a world project in the current folder (not under `./project`). Useful if you want the project root to be your world project.
- `gamedev app-server` — runs only the app-server sync against an existing local/remote world; still uses `./project` as the world project root.
- `gamedev world export|import` — exports/imports `world.json`, apps, assets between the world and disk. Use `--include-built-scripts` on export if you want to seed scripts from a populated world.

## Notes
- `.env` lives at the project root (beside where you run `gamedev`), while your editable SDK files live in `./project`.
- Update checks can be disabled by setting `GAMEDEV_DISABLE_UPDATE_CHECK=true` in your environment.
- The bootstrap only proceeds automatically if the target world is in its default state. If the world already contains content, use `gamedev world export` to pull it down first.
