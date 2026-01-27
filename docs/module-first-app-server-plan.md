# Module-First Scripts + No-Build App-Server Plan

Status: complete
Last updated: 2026-01-25

## Goals
- Make module scripts the default for new apps (ESM `export default` entry).
- Keep legacy-body supported, but require an explicit opt-in.
- Remove the app-server build step entirely (no esbuild bundling).
- Auto-convert `.hyp` imports to module format when they are legacy or bundled.
- Modularize built-in apps (Model/Image/Video/Text/Webview/scene).

## Non-goals
- Support bare imports (`react`, `lodash`) in runtime scripts.
- Add automatic merge/conflict resolution for script file edits.
- Change the runtime SES module loader architecture.

## Decisions (Locked)
- Module is first-class; legacy-body is supported but not the default.
- `.hyp` drag-and-drop should always land as module format, even if the source was legacy.
- Built-ins are converted to module format and shipped as module blueprints.
- App-server no longer bundles or emits `dist/apps`.

## Current Baseline (Key References)
- Module runtime loader exists (`src/core/systems/Scripts.js`).
- App-server always uploads multi-file scripts (`app-server/direct.js`).
- Legacy bundling is removed; app-server no longer emits `dist/apps`.
- `.hyp` import/export is handled in `src/core/extras/appTools.js`.

## Implementation Checklist (PR-Sized)

### PR 01 - Modularize Built-Ins (Assets + Blueprints)
- [x] Convert built-in scripts to ESM default exports:
  - `src/world/assets/Model.js`
  - `src/world/assets/Image.js`
  - `src/world/assets/Video.js`
  - `src/world/assets/Text.js`
  - `src/world/assets/Webview.js`
  - `src/world/assets/scene.js`
- [x] Update built-in blueprint seeds to module fields (`scriptEntry`, `scriptFiles`, `scriptFormat: "module"`):
  - `src/server/db.js`
- [x] Update app-server scaffold templates to ship `scriptFormat: "module"` for built-ins:
  - `app-server/templates/builtins.js`
  - `app-server/scaffold.js`
- [x] Keep `script` pointing at the entry asset for backward compatibility.
- [x] Manual smoke test: fresh world bootstraps and built-ins run without legacy wrapper.

Dependency: none (can land first).

---

### PR 02 - Remove App Bundler + Always Upload Script Files
- [x] Remove esbuild bundler and watch path:
  - delete `app-server/appBundler.js`
  - remove build/watch logic in `app-server/direct.js`
- [x] Make app-server always use the multi-file upload path:
  - `_uploadScriptForApp` always calls `_uploadScriptFilesForApp`
  - stop writing/reading `dist/apps/*`
- [x] Determine script format for deploys:
  - If `scriptFormat` exists in blueprint JSON, use it.
  - If missing, default to `"module"` **only when entry exports default**; otherwise use `"legacy-body"` and emit a warning (do not auto-modify the JSON).
- [x] Update watchers to deploy on any `.js/.ts` change (no build step).
- [x] Remove CLI build/validate/clean commands and help text:
  - `app-server/commands.js`
  - `bin/gamedev.mjs` (if it references removed commands)
- [x] Update scaffolded `package.json` scripts to remove `build`:
  - `app-server/scaffold.js`

Dependency: should land after PR 01 so built-ins remain valid under module defaults.

---

### PR 03 - Module-First Defaults in Tooling + AI
- [x] Update `gamedev apps create` stub to ESM `export default` and set `scriptFormat: "module"`:
  - `app-server/commands.js`
- [x] Default script format to `"module"` in client authoring UI:
  - `src/client/components/ScriptFilesEditor.js`
  - `src/client/components/Sidebar.js`
- [x] Default script format to `"module"` in AI generation:
  - `src/core/systems/ServerAI.js`
  - `src/core/systems/ServerAIScripts.js`
  - `src/core/systems/ClientAI.js`

Dependency: independent, but best after PR 02 to avoid dangling build paths.

---

### PR 04 - `.hyp` Import: Auto-Convert Legacy to Module
- [x] Introduce a shared helper to wrap legacy-body source into a module source string:
  - new helper file under `src/core` (e.g. `src/core/legacyBody.js`)
  - refactor `compileLegacyBodyModuleSource` to reuse it
- [x] Update `.hyp` import conversion logic:
  - `src/core/extras/appTools.js`
  - If blueprint has no `scriptFiles`, create:
    - `scriptEntry: "index.js"` (or preserve original name)
    - `scriptFiles: { "<entry>": <new asset url> }`
    - `scriptFormat: "module"`
    - `script` updated to the new entry asset
  - If blueprint has `scriptFiles` and `scriptFormat` is missing or `legacy-body`:
    - Convert entry file only and update that asset URL
    - Set `scriptFormat: "module"`
  - Drop original legacy script asset from upload list if replaced.
- [x] Add tests or manual test steps:
  - `.hyp` import of legacy single-file app becomes module and runs.

Dependency: none, but this PR should land after PR 03 if defaults are changed in UI.

---

### PR 05 - Documentation + Migration Notes
- [x] Update docs to reflect module-first + no build step:
  - `docs/scripting/README.md`
  - `docs/App-server.md`
  - `docs/World-projects.md`
  - `docs/supported-files/hyp-format.md`
  - `project/docs/**` mirrors
- [x] Add migration guidance:
  - how to set `"scriptFormat": "legacy-body"` for old apps
  - how to convert an entry to module format
  - warning that bundling is removed

Dependency: after PR 02 and PR 04 so docs match behavior.

---

### PR 06 (Optional) - Migration Helper Script
- [x] Add a CLI helper to tag existing blueprints as `legacy-body` or convert to module:
  - e.g. `gamedev scripts migrate --legacy-body` or `--module`
- [x] Update docs to reference the helper.

Dependency: optional; can land any time after PR 02.
