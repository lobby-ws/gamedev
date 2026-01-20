---
name: hyperfy-app-scripting
description: Hyperfy world-project app scripting workflow and constraints. Use when editing or debugging app scripts and blueprints (apps/**), world layout (world.json), assets, or deploy/dev commands in gamedev/Hyperfy projects.
---

# Hyperfy App Scripting

## Scope

- Work in `apps/<AppName>/index.ts` (or `index.js`) and `apps/<AppName>/*.json`.
- Edit `world.json` only when changing layout or per-instance overrides.
- Keep `assets/` for user files referenced by blueprints and props.

## Workflow

1. Identify the target app(s) and update the entry script at `apps/<AppName>/index.ts`.
2. Update blueprint defaults in `apps/<AppName>/*.json` (model, props, flags).
3. Keep per-instance overrides in `world.json`.
4. Use `gamedev dev` for continuous sync; use `gamedev apps build --all` and `gamedev apps deploy <app>` for explicit deploys.

## Runtime Constraints

- Scripts run in an SES sandbox: no Node builtins, no filesystem access.
- Imports must be relative or from `node_modules`; cross-app imports are blocked.
- Use `world.isServer` / `world.isClient` and store shared state in `app.state`.

## Lifecycle

- Script executes once per build in each environment; top-level code is init.
- Subscribe to `app.on('update'|'fixedUpdate'|'lateUpdate'|'animate')` only when needed.
- Clean up with `app.on('destroy')`, remove listeners, and release controls.

## Types

- `hyperfy.app-runtime.d.ts` references `gamedev/app-runtime`.
- Prefer `index.ts`; avoid Node globals/types in app scripts.

## Guardrails

- Do not edit `dist/` (build output).
- Do not edit `.lobby/*` except `targets.json` (local only).
