# Plan: Remove “portable artifacts” (Collections + `.hyp` import/export)

## Goals
- Remove **collections** as a first-class engine/server concept (no `world.collections`, no snapshot field, no server-side collection install/copy).
- Remove **`.hyp`** as an import/export mechanism:
  - No `.hyp` file format support in runtime.
  - No exporting apps as `.hyp` from UI.
  - No drag/drop or URL-drop `.hyp` import.

## Non-goals
- Backwards compatibility with existing world DBs or previously exported `.hyp` files.
- Preserving the exact UX of the old “collections” system (but we should keep an “Add” panel equivalent so world authoring remains usable).

---

## High-level approach
1. **Delete the collections pipeline** end-to-end (server init, core system, client UI assumptions, network snapshot).
2. **Delete `.hyp` import/export** end-to-end (file format utilities, UI actions, drag/drop path).
3. Replace what those features provided **internally**:
   - Keep a default `$scene` by shipping its assets as normal built-in assets and creating a scene blueprint directly in DB migration.
   - Replace “default collection apps” (Model/Image/Video/Text) with **hardcoded built-in blueprint templates** (client-side only), backed by built-in assets (models/scripts/icons/placeholder media) copied from repo assets.

This preserves authoring workflows (spawn scene, add starter apps) without any portable packaging format.

---

## Phase 1 — Remove Collections (engine + networking + server)

### 1.1 Delete core collections system
- Remove `src/core/systems/Collections.js`.
- Update `src/core/World.js`:
  - Remove `import { Collections } ...`
  - Remove `this.register('collections', Collections)`.

Expected fallout: any `world.collections` usage must be removed/rewired.

### 1.2 Remove collections from snapshot protocol
- Update `src/core/systems/ServerNetwork.js`:
  - In snapshot payload, remove `collections: this.world.collections.serialize()`.
- Update `src/core/systems/ClientNetwork.js`:
  - Remove `this.world.collections.deserialize(data.collections)`.

### 1.3 Remove server-side “collections installer”
- Delete `src/server/collections.js`.
- Update `src/server/index.js`:
  - Remove import `collections`.
  - Remove `await collections.init({ rootDir, worldDir })`.
  - Remove `collections: collections.list` from `world.init(...)`.

### 1.4 Update cleaner (currently depends on server collections)
- Update `src/server/cleaner.js`:
  - Remove `import { collections }...`
  - Remove the “append all collection blueprints so we keep all their assets” logic.
  - Consider keeping a “built-in assets” allowlist later (see Phase 4/5).

**Acceptance for Phase 1**
- `rg "world\\.collections|Collections\\b" src` returns nothing except maybe comments/docs you intentionally keep.
- Server boots without any mention of collections and snapshot still works.

---

## Phase 2 — Remove `.hyp` import/export feature set

### 2.1 Remove `.hyp` utilities
- Remove `src/core/extras/appTools.js` entirely (it only exists for `.hyp` import/export).
- Update all imports that reference it:
  - `src/client/components/MenuApp.js` (download)
  - `src/client/components/Sidebar.js` (download)
  - `src/core/systems/ClientBuilder.js` (import)

### 2.2 Remove `.hyp` drag/drop import path
- Update `src/core/systems/ClientBuilder.js`:
  - In `onDrop`, remove the `if (ext === 'hyp') this.addApp(file, transform)` branch.
  - Remove the entire `addApp(file, transform)` method.
  - Remove any `.hyp`-specific logging/messages (e.g. “failed to upload .hyp assets”).

Optional UX: If `ext === 'hyp'`, show a chat toast like “.hyp not supported”.

### 2.3 Remove `.hyp` export/download from UI
- Update `src/client/components/MenuApp.js`:
  - Remove `download` handler calling `exportApp`.
  - Remove “Download” menu item (`<MenuItemBtn label='Download' ...>`).
- Update `src/client/components/Sidebar.js`:
  - Remove the download icon/button and handler that calls `exportApp`.

### 2.4 Remove `.hyp` documentation + build artifacts
- Delete `docs/supported-files/hyp-format.md`.
- Update any docs referencing `.hyp` (search `rg "\\.hyp"`), especially:
  - `CHANGELOG.md` entries (optional cleanup).
- Update `scripts/build.mjs`:
  - Remove “copy built-in world collections” step.
  - Remove “copy built-in scene.hyp” step.

**Acceptance for Phase 2**
- No `.hyp` code paths remain (`rg "\\.hyp|importApp\\(|exportApp\\("` is empty in `src/` and `scripts/`).
- UI has no “download .hyp” affordances.
- Drag/drop `.hyp` does nothing or shows an “unsupported” message.

---

## Phase 3 — Replace default scene provisioning (remove `scene.hyp` dependency)

Currently DB migration reads `build/world/scene.hyp` and `importApp(...)`. That must be replaced.

### 3.1 Extract scene assets from `src/world/scene.hyp` into built-in assets

Create a one-off extraction script (see Appendix) that writes each asset to:
- `src/world/assets/builtin/…`

Recommended: keep the original asset filenames (hash-based) but put them under `builtin/` to avoid being treated as “uploaded assets” by the cleaner.

From `src/world/scene.hyp`, assets are:
- `asset://1aa2381f0fb25ba2fe9941b62eb2cad1fe2c77afa0316df8828ba5eba5d3d374.glb`
- `asset://3d64ad66587920f17ac09164b42c4e441d5fc1320bc597bd1e6fd0b7a3631994.js`
- `asset://179d71586e675efc4af04185e1b2d3e6b7f4a5b707f1ef5e9b6497c5660ecab7.webp`
- `asset://62db0ffbcea86b5e9ba23fb5da739b160e8abfd3b390235fed5ac436750e1e2e.hdr`

Write them as:
- `src/world/assets/builtin/1aa2381f0f…d374.glb` etc.

### 3.2 Replace the scene migration in `src/server/db.js`

Because there are **no existing servers**, it’s acceptable to *edit* the existing “migrate or generate scene app” migration (even though the file warns against it), otherwise new DB creation will break once `.hyp` is removed.

Update that migration to:
- Create `$scene` blueprint **directly** (no `.hyp` import).
- Reference the built-in asset URLs using the `builtin/` prefix, e.g.:
  - `model: "asset://builtin/1aa238…d374.glb"`
  - `script: "asset://builtin/3d64ad…1994.js"`
  - `props.sky.url: "asset://builtin/179d71…cab7.webp"`
  - `props.hdr.url: "asset://builtin/62db0f…1e2e.hdr"`
- Insert blueprint row and a single scene entity row (same as today).

Also ensure `props` is a real object (not `null`) since the default scene script likely reads them.

### 3.3 Remove `src/world/scene.hyp`
- Delete `src/world/scene.hyp`.
- Ensure build pipeline no longer copies it (Phase 2.4).
- Ensure `build/world/assets` still contains the extracted assets via the existing “copy `src/world/assets`” behavior.

**Acceptance for Phase 3**
- Fresh server boot creates `$scene` without reading any `.hyp`.
- Clients load the default scene model/script/sky/hdr successfully.

---

## Phase 4 — Replace “Add from collection” UX with built-in templates

Removing collections breaks `Sidebar -> Add` which currently reads `world.collections.get('default')`.

### 4.1 Introduce built-in blueprint templates (client-side constant/module)

Create a new module, e.g.:
- `src/client/builtinApps.js`

Export:
- `BUILTIN_APP_TEMPLATES: Array<{ name, image, model, script, props, ...flags }>` where each entry is a *blueprint template*.

Use the existing default “collection” apps, but now as plain templates. Recommended to reference assets under `asset://builtin/...` (stored in `src/world/assets/builtin/`).

Templates to include (from the old `.hyp` headers):
- **Model**
  - model: `97fc7289…2530.glb`
  - script: `448d8658…f0aa.js`
  - image: `39ad1b40…4c86.png`
  - props: `{ collision: true }`
- **Image**
  - model: `70f1cabc…f868.glb`
  - script: `378774dc…a81f.js`
  - image + placeholder: `daaace2f…3803.png`
  - props: `{ width:0, height:2, fit:"cover", image:null, transparent:false, lit:false, shadows:true, placeholder:{...} }`
- **Video**
  - model: `2faa49a0…ba69.glb`
  - script: `3fb3a43c…068b.js`
  - image: `2fecd213…15af.png`
  - placeholder: `8fab0105…ff44.mp4`
  - props: `{ width:0, height:2, ..., placeholder:{ type:"video", ... } }`
- **Text**
  - model: `e7cfd8f9…3a5c.glb`
  - script: `5298877b…8ba5.js`
  - image: `a737851a…7bcf.png`
  - props: `{ width:200, height:200, text:"Enter text...", ... }`

All asset URLs should be rewritten to include `builtin/`, e.g. `asset://builtin/<hash>.glb`.

Also set explicit flags for consistency with the rest of the codebase:
- `preload:false, public:false, locked:false, frozen:false, unique:false, scene:false, disabled:false`

### 4.2 Update Sidebar “Add” panel to use templates instead of collections
- Update `src/client/components/Sidebar.js` `Add(...)`:
  - Replace `const collection = world.collections.get('default')` with imported `BUILTIN_APP_TEMPLATES`.
  - Render using that list.
  - When spawning: keep the existing logic that clones blueprint, assigns new `id` and `version:0`, adds blueprint, spawns entity.

**Acceptance for Phase 4**
- “Add” panel still shows starter tiles (Model/Image/Video/Text) with icons.
- Clicking spawns an app instance successfully.

---

## Phase 5 — Asset extraction + repo cleanup (remove all `.hyp` files)

### 5.1 Extract collection app assets into `src/world/assets/builtin/`

Use the same extraction script to dump assets from:
- `src/world/collections/default/Model.hyp`
- `src/world/collections/default/Image.hyp`
- `src/world/collections/default/Video.hyp`
- `src/world/collections/default/Text.hyp`

Assets to extract (by URL/filename; store under `builtin/`):
- Model:
  - `97fc7289…2530.glb`, `448d8658…f0aa.js`, `39ad1b40…4c86.png`
- Image:
  - `70f1cabc…f868.glb`, `378774dc…a81f.js`, `daaace2f…3803.png`
- Video:
  - `2faa49a0…ba69.glb`, `3fb3a43c…068b.js`, `2fecd213…15af.png`, `8fab0105…ff44.mp4`
- Text:
  - `e7cfd8f9…3a5c.glb`, `5298877b…8ba5.js`, `a737851a…7bcf.png`

### 5.2 Delete collections source folder
- Delete `src/world/collections/` entirely (including `manifest.json`).
- Ensure build script no longer copies it (Phase 2.4).
- Delete any `build/world/collections` remnants if they’re checked in (usually they aren’t, but verify).

### 5.3 Ensure cleaner won’t delete built-in template assets

If assets live under `assets/builtin/` (subdirectory), current `AssetsLocal.list()` will ignore them (it only lists top-level files). That’s ideal. Confirm S3 cleaner behavior similarly:
- `AssetsS3.list()` only considers keys whose “filename” prefix before `.` is length 64; `builtin/<hash>` won’t match, so it also won’t be deleted.

**Acceptance for Phase 5**
- No `.hyp` files remain in repo or build output.
- Built-in templates and scene still work via extracted assets.

---

## Phase 6 — Final cleanup + verification

### 6.1 Ripgrep sanity checks
Run:
- `rg -n "\\.hyp\\b|importApp\\(|exportApp\\(" .`
- `rg -n "\\bcollections\\b|world\\.collections" src`

Expect: no runtime references.

### 6.2 Manual runtime verification
1. `npm install`
2. `npm run dev`
3. Open world in browser.
4. Confirm:
   - World boots into default scene.
   - Sidebar “Add” shows Model/Image/Video/Text and spawning works.
   - Script editor and prop editing still work.
   - Drag/drop `.glb` and `.vrm` still work.
   - Drag/drop `.hyp` shows “unsupported” (if implemented) and does not change world.

### 6.3 Optional: update docs/changelog
- Remove `.hyp`-related entries in `CHANGELOG.md` (purely housekeeping).
- Remove `.hyp` format doc file (already in Phase 2.4).

---

## Appendix A — One-off `.hyp` asset extraction script (recommended)

Create `scripts/extract-hyp-assets.mjs` (temporary; delete after use), which:
- Reads a `.hyp` file as `Buffer`
- Parses:
  - `headerSize = uint32LE(buf[0..4])`
  - `headerJson = JSON.parse(buf[4..4+headerSize])`
  - Iterates `headerJson.assets`, slicing each asset’s bytes from the concatenated blob
- Writes each asset to:
  - `src/world/assets/builtin/<filename-from-asset-url>`
  - where `<filename-from-asset-url>` is `assetInfo.url.replace("asset://", "")`
- Deduplicates by `assetInfo.url` (Image.hyp lists the same PNG twice under different types).

Suggested usage:
- Extract scene assets:
  - `node scripts/extract-hyp-assets.mjs src/world/scene.hyp`
- Extract template assets:
  - `node scripts/extract-hyp-assets.mjs src/world/collections/default/Model.hyp`
  - etc.

After extraction:
- Update code to reference `asset://builtin/<filename>` URLs.
- Delete `.hyp` sources.

---

## Appendix B — Exact scene blueprint config to embed in migration

From current `scene.hyp` header (rewrite URLs to include `builtin/`):
- `name`: `The Meadow`
- `model`: `asset://builtin/1aa2381f0fb25ba2fe9941b62eb2cad1fe2c77afa0316df8828ba5eba5d3d374.glb`
- `script`: `asset://builtin/3d64ad66587920f17ac09164b42c4e441d5fc1320bc597bd1e6fd0b7a3631994.js`
- `props`:
  - `hour: 4`
  - `period: "pm"`
  - `intensity: 1`
  - `sky.url: asset://builtin/179d71586e675efc4af04185e1b2d3e6b7f4a5b707f1ef5e9b6497c5660ecab7.webp`
  - `hdr.url: asset://builtin/62db0ffbcea86b5e9ba23fb5da739b160e8abfd3b390235fed5ac436750e1e2e.hdr`
  - `verticalRotation: 40`, `horizontalRotation: 230`, `rotationY: 0`
  - `fogNear: 450`, `fogFar: 1000`, `fogColor: "#97b4d3"`

Everything else can be `null/false` with `preload:true, scene:true` and `version:0`.
