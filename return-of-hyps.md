Goal

  - Re-add .hyp app portability (export + import) in lobbyws, without reintroducing collections, using world.admin.* for all server mutations/uploads.

  Reference (Old Implementation)

  - Use git show e7bfc5fb^:src/core/extras/appTools.js (codec), git show e7bfc5fb^:src/core/systems/ClientBuilder.js (drop/import), and git show
    e7bfc5fb^:src/client/components/MenuApp.js (Download UI) as a starting point, then adapt to current world.admin.* flows.

  Step 1 — Restore the .hyp Codec

  - Add src/core/extras/appTools.js:1 with exportApp(blueprint, resolveFile) + importApp(file).
  - Keep file format identical:
      - [headerSize:uint32 LE][header JSON UTF-8][asset bytes concatenated...]
      - Header shape: { blueprint, assets:[{type,url,size,mime}] }
  - Update codec vs old version:
      - Handle blueprint.props == null safely (treat as {}).
      - Include blueprint.image?.url asset (icon).
      - Infer missing type for file refs that only have {url} (current scene seed has this), using extension mapping:
          - .hdr → hdr, .mp4 → video, .mp3 → audio, .js → script, .vrm → avatar, .glb → model, image ext (png/jpg/jpeg/webp) default → texture.
      - Optional but recommended: sanitize filename (${blueprint.name}.hyp) to avoid OS-illegal chars.

  Step 2 — Re-add UI “Download .hyp”

  - Update src/client/components/MenuApp.js:65:
      - Import exportApp from ../../core/extras/appTools.
      - Add a menu item near Metadata / Delete (src/client/components/MenuApp.js:104) like:
          - MenuItemBtn label='Download' hint='Download this app as a .hyp file' onClick={download}
      - Implement download() using existing loader + downloader:
          - const file = await exportApp(app.blueprint, world.loader.loadFile)
          - downloadFile(file)
      - Error UX: world.emit('toast', 'Export failed') on catch.

  Step 3 — Re-add Drag/Drop .hyp Import

  - Update src/core/systems/ClientBuilder.js:1021:
      - Import importApp from ../extras/appTools.
      - In onDrop, add if (ext === 'hyp') this.addApp(file, transform).
      - Size check adjustment: current code rejects based on the dropped file’s size; for .hyp, do per-asset checks after parsing (since uploads
        happen per-asset).
  - Add async addApp(file, transform) (place near addModel / addAvatar, e.g. after onDrop):
      - const info = await importApp(file) → { blueprint, assets }.
      - Pre-cache locally for instant load: world.loader.insert(asset.type, asset.url, asset.file) for each asset.
      - If info.blueprint.scene:
          - Confirm replace (same UX as old).
          - Build change = { id: '$scene', version: scene.version+1, ...fieldsFromImportedBlueprint }.
          - Upload all assets via await Promise.all(assets.map(a => world.admin.upload(a.file))).
          - Apply: world.blueprints.modify(change) then world.admin.blueprintModify(change, { ignoreNetworkId: world.network.id, lockToken }).
      - Else (normal app):
          - Create new blueprint with id: uuid(), version: 0, ...importedFields.
          - Register locally: world.blueprints.add(blueprint); send server: world.admin.blueprintAdd(blueprint, { ignoreNetworkId: world.network.id,
            lockToken }).
          - Spawn entity with uploader: world.network.id (so others see loading), then world.admin.entityAdd(...).
          - Upload assets; on success call app.onUploaded(), on failure destroy entity + optionally remove blueprint.
      - Toasts: “Imported app”, “Import failed”, “Deploy lock required” (see Step 4).

  Step 4 — Make Import Work With Deploy Locks (Scripts)
  .hyp often includes scripts; current admin pipeline enforces deploy locks for script-bearing ops.

  - Update src/core/systems/AdminClient.js:95 (adminAuth payload) to optionally include deployCode:
      - Persist in storage (e.g. key deployCode) and send deployCode in adminAuth so capabilities.deploy can be true when DEPLOY_CODE is set server-
        side.
  - Add deploy-lock HTTP helpers to src/core/systems/AdminClient.js:1:
      - acquireDeployLock(): POST /admin/deploy-lock with headers:
          - X-Admin-Code if present (works when DEPLOY_CODE is not set).
          - X-Deploy-Code when provided (required when DEPLOY_CODE is set).
      - releaseDeployLock(token): DELETE /admin/deploy-lock with { token }.
      - Store the acquired token in-memory on world.admin during an import session.
  - Extend command senders to pass lock tokens:
      - Update src/core/systems/AdminClient.js:172 to accept { lockToken } and include lockToken in the payload.
      - Update src/core/systems/AdminClient.js:180 similarly.
  - In .hyp import (ClientBuilder.addApp), before any blueprint op that includes/changes script:
      - Acquire lock; if lock fails due to existing lock, abort import and toast “Deploy locked”.

  Step 5 — Compatibility: Rewrite URLs to Content-Hash (Recommended)
  Avoid broken imports if .hyp contains non-hash filenames.

  - In ClientBuilder.addApp (or inside importApp), for each extracted asset:
      - Compute hash = await hashFile(file), ext from filename/url.
      - Rename file to ${hash}.${ext} and remap URL to asset://${hash}.${ext}.
      - Rewrite all blueprint references (model, script, image.url, any props[*].url) using the old→new URL map.
  - This ensures uploads land at the same URLs the blueprint references.

  Step 6 — Docs (Optional but good handoff completeness)

  - Add docs/supported-files/hyp-format.md:1 (restore from old, update asset-type list + mention drag/drop + Menu export).
  - Add a short note in docs/supported-files/models.md:1 or relevant doc linking .hyp.

  Step 7 — Tests / Validation

  - Add a unit/integration test that round-trips exportApp→importApp and asserts:
      - Header parsing works; blueprint fields preserved; asset byte sizes preserved.
      - Type inference for {url} props (e.g. .hdr, .webp) produces expected asset types.
      - URL rewrite (if implemented) updates blueprint references consistently.
  - Manual QA checklist:
      - Export any app via Menu → Download, re-import via drag/drop, verify it spawns and works.
      - Import a .hyp that includes a script, verify deploy-lock flow succeeds (or errors clearly).
      - Scene .hyp import prompts and replaces $scene.

  Acceptance Criteria

  - Export: MenuApp shows “Download” and produces a valid .hyp.
  - Import: Drag/drop .hyp spawns app (or replaces scene) and uploads assets via world.admin.upload.
  - No collections codepaths added back.
  - Script-bearing imports either succeed with deploy lock or fail with an explicit, actionable message.
