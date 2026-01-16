# `lobbyws` Branch Plan (plat-based + WebView + Fly)

## Context

We ran two parallel rewrites of the “world developer experience” (DX):
- `plat` has the correct world-authoring UX (project-based CLI + app-server sync workflow).
- `lobbyws-staging` has desired runtime features (notably `WebView`), but also contains an alternate DX rewrite we **do not** want to adopt (e.g. local apps/collections/.hyp world format).

Goal: create a new branch `lobbyws` **from `plat` HEAD** and port **non-DX** features from `lobbyws-staging`, while keeping the `plat` DX intact.

Branches involved:
- Base: `plat` (HEAD)
- Source of features: `lobbyws-staging` (commits of interest: `51fb4619` WebView, `f6474b22` UIInput, `3e48b6ff` iframe interaction/reticle, parts of `a86f8d5c` Fly deploy workflow only)

---

## Scope

### Must-have (port into `lobbyws`)

1) **WebView node**
- World-space CSS3D iframe embedding with proper depth occlusion (WebGL cutout plane).
- Screen-space overlay mode.
- Pointer unlock on click (world-space), except in build mode.
- Acceptable that WebViews do not render in immersive XR.

2) **UIInput node**
- World-space CSS3D text input with focus/blur/change/submit callbacks.
- Pointer unlock on click, except in build mode.

3) **Iframe interaction fixes**
- WebGL canvas configured to allow DOM interaction with CSS3D layers (pointer-events + alpha compositing).

4) **Script runtime `URL` global**
- Expose `URL` as a real class inside the scripting sandbox (as in `lobbyws-staging`).

5) **Prim raycast behavior change**
- Adopt `lobbyws-staging` behavior: `Prim` with `opacity === 0` is **not raycastable** (no octree hit item).

6) **Fly.io deployment integration**
- Add a new `hyperfy fly …` command into `bin/hyperfy.mjs`.
- Include GitHub Action workflow for Fly deploy on pushes to `main`.
- Use `fly secrets` for secrets (no hardcoded secrets in `fly.toml`).
- Persistence on Fly is **optional** (default off), toggled via CLI flag.

### Explicitly out-of-scope (do NOT port)

These are treated as “alternate DX rewrite” and should not be merged into `lobbyws`:
- `src/server/localApps.js`, `src/core/systems/Collections.js`, `src/server/collections.js`
- `.hyp` world/collection format + related assets under `src/world/**`
- `docs/supported-files/hyp-format.md`
- “agentic developer workflow” changes that restructure world authoring around server-side local apps

---

## Notes on `plat` World Authoring UX (baseline to preserve)

On `plat`:
- “World projects” are folders containing `./.env`, `./apps/**`, `./assets/**`, `./world.json`.
- `hyperfy start` (`bin/hyperfy.mjs`) chooses:
  - **Local world**: runs world server with `WORLD=~/.hyperfy/<WORLD_ID>` then runs app-server sync agent against `/admin`.
  - **Remote world**: runs only the app-server sync agent against the remote `/admin`.
- Builders do layout/instance props in-world; app-server writes changes to `world.json`.
- Developers edit app scripts/templates locally and deploy via app-server, with optional `DEPLOY_CODE` and multi-targets in `.hyperfy/targets.json`.

The `lobbyws` branch must keep this DX intact.

---

## Technical Design (porting WebView/UIInput safely into `plat`)

### CSS3D Rendering Layer (ClientCSS system)

Port `ClientCSS` from `lobbyws-staging`:
- Add `src/core/systems/ClientCSS.js` (manages a CSS3D scene + renderer).
- Register it in both:
  - `src/core/createClientWorld.js`
  - `src/core/createAdminWorld.js`
- Add a dedicated DOM element (a “css layer”) in both clients:
  - `src/client/world-client.js`
  - `src/client/admin-client.js`
- Pass it into `world.init({ cssLayer, … })`.

Rendering order:
- `ClientGraphics.render()` must call `world.css?.render()` before WebGL rendering so CSS sits “behind” the WebGL canvas.

WebGL renderer requirements:
- Create the `THREE.WebGLRenderer` with `alpha: true` so the canvas can composite over the CSS layer while allowing the CSS to show through in “cutout” regions.
- Set `renderer.domElement.style.pointerEvents = 'none'` so pointer interactions can reach iframes/inputs behind the canvas.

### WebView node

Port `src/core/nodes/WebView.js` from `lobbyws-staging` with these expectations:
- **World space**:
  - Creates a transparent WebGL plane mesh that writes to depth (the occlusion “cutout”).
  - Creates a `CSS3DObject` holding an iframe (or `srcdoc`) and attaches it via `world.css.add()`.
  - Uses a “hover enables pointer-events” approach for desktop stability.
- **Screen space**:
  - Creates an absolutely positioned iframe container appended to `world.pointer.ui`.
  - **Important fix to include while porting**: update DOM positioning on transform changes (see “Known bug to fix” below).
- Pointer unlock on click:
  - `onPointerDown` should unlock pointer only if not in builder mode.
- XR:
  - No special handling required (known limitation accepted).

**Known bug to fix while porting (screen-space positioning)**
`lobbyws-staging` screen-space WebView calculates `left/top/transform/zIndex` only in `buildScreen()`.
If `position` changes later, the DOM element does not move.

Fix:
- In `WebView.commit(didMove)`, when `this.container && this._space === 'screen' && didMove`, recompute and apply:
  - `left`, `top`, `transform`, and `zIndex`.

### UIInput node

Port `src/core/nodes/UIInput.js` from `lobbyws-staging`:
- Creates an occlusion plane + CSS3D input element.
- Uses the same interaction-stabilization idea (mark CSS object as `interacting` while focused/hovered).
- Stops pointerdown propagation on the input container to avoid accidental world pointer-lock logic.
- Pointer unlock on click:
  - Unlock pointer unless in builder mode or disabled.

### Script sandbox `URL`

Port the `lobbyws-staging` change:
- Update `src/core/systems/Scripts.js` to expose `URL` as a real class (not `URL.createObjectURL`).
- Update `docs/scripting/Utils.md` to document `URL`.

### Prim raycastability change

Adopt `lobbyws-staging` behavior:
- Update `src/core/nodes/Prim.js` so `opacity === 0` **does not insert** a stage/octree item.
- Implication: invisible prims will no longer block clicks or be selectable via raycast, reducing “invisible click-blocker” issues.

---

## Fly.io Integration Design (CLI-first, fits `plat` DX)

### Goals
- Make Fly deployment “project friendly”: generate config + guide the developer, without changing the `plat` authoring workflow.
- Do not hardcode secrets in repo files.
- Optional persistence (default off).

### CLI: `hyperfy fly …` (in `bin/hyperfy.mjs`)

Add a new top-level command:
```
hyperfy fly <subcommand> [options]
```

Recommended subcommands:

1) `hyperfy fly init`
- Purpose: generate `fly.toml` and optionally the GH workflow file.
- Inputs:
  - `--app <name>` (required): Fly app name (used to derive URLs).
  - `--region <code>` (optional, default `ams`).
  - `--persist` (optional, default false): include volume mount config.
  - `--world-id <id>` (optional, default `fly-<app>`).
  - `--target <name>` (optional): also create/update `.hyperfy/targets.json` entry with `worldUrl/worldId` (no secrets).
  - `--force` (optional): overwrite existing files.
- Outputs:
  - `fly.toml` written to project root, containing:
    - Non-secret `[env]` values:
      - `NODE_ENV=production`
      - `PORT=3000`
      - `WORLD=world`
      - `WORLD_ID=<worldId>`
      - `PUBLIC_WS_URL=wss://<app>.fly.dev/ws`
      - `PUBLIC_API_URL=https://<app>.fly.dev/api`
      - `ASSETS=local`
      - `ASSETS_BASE_URL=https://<app>.fly.dev/assets`
      - `PUBLIC_MAX_UPLOAD_SIZE=12`
      - `SAVE_INTERVAL=0` when `--persist` is off (default), otherwise `SAVE_INTERVAL=60`
    - `[http_service]` with `internal_port=3000` and `force_https=true`
    - If `--persist` is on:
      - `[[mounts]] source="data" destination="/app/world"` (and optional auto-extend settings)
  - Optional: `.github/workflows/fly-deploy.yml` if missing or `--force`:
    - Deploy on pushes to `main`
    - Uses `FLY_API_TOKEN` GitHub secret

2) `hyperfy fly secrets`
- Purpose: generate secrets and print the exact `fly secrets set …` commands to run.
- Inputs:
  - `--deploy-code` (optional, default true): generate `DEPLOY_CODE` as well.
  - `--target <name>` (optional): if provided, write `adminCode/deployCode` into that target entry locally for app-server use.
  - `--force` (optional): overwrite existing target codes.
- Behavior:
  - Generate:
    - `ADMIN_CODE` (base64url 16 bytes)
    - `JWT_SECRET` (base64url 32 bytes)
    - optionally `DEPLOY_CODE` (base64url 16 bytes)
  - Print:
    - `fly secrets set ADMIN_CODE=... JWT_SECRET=... DEPLOY_CODE=...`
  - If `--target` is set, update `.hyperfy/targets.json`:
    - `adminCode`, `deployCode`, and set `confirm: true` (optional safety).

3) (Optional) `hyperfy fly help`
- Prints usage and the recommended workflow.

### Recommended operator workflow (keeps `plat` DX)

1) Generate Fly config:
```
hyperfy fly init --app my-world --region ams --target prod
```

2) Generate secrets + set them on Fly:
```
hyperfy fly secrets --target prod
fly secrets set ADMIN_CODE=... JWT_SECRET=... DEPLOY_CODE=...
```

3) (If persistence desired) create a volume:
```
fly volumes create data --app my-world --region ams --size 10
```

4) Deploy:
- Via GitHub Actions on push to `main`, or manually:
```
fly deploy
```

5) Deploy world content (apps/layout) from local machine using the existing `plat` tooling:
```
hyperfy world import --target prod
hyperfy apps deploy <appName> --target prod
```

This preserves the “app-server sync” authoring model while making production hosting straightforward.

---

## Implementation Steps (handoff checklist)

### 0) Branch setup
- Ensure working tree clean on `plat`.
- Create branch:
  - `git checkout plat`
  - `git pull` (if applicable)
  - `git checkout -b lobbyws`

### 1) Port CSS3D plumbing (shared by WebView + UIInput)
- Add `src/core/systems/ClientCSS.js` (from `lobbyws-staging`).
- Update `src/core/createClientWorld.js` to register `css: ClientCSS` before `graphics`.
- Update `src/core/createAdminWorld.js` to register `css: ClientCSS` before `graphics`.
- Update `src/client/world-client.js`:
  - Add `cssLayerRef` and a `.App__cssLayer` div.
  - Pass `cssLayer` into `world.init`.
  - Ensure layer ordering: css layer behind canvas; UI above.
- Update `src/client/admin-client.js` similarly (`.Admin__cssLayer`, `cssLayerRef`, pass `cssLayer`).
- Update `src/core/systems/ClientGraphics.js`:
  - `new THREE.WebGLRenderer({ antialias: true, alpha: true, … })`
  - `renderer.domElement.style.pointerEvents = 'none'`
  - Call `this.world.css?.render()` at the start of `render()`.

### 2) Port WebView node
- Add:
  - `src/core/nodes/WebView.js` (from `lobbyws-staging`, with the screen-space commit fix).
  - `docs/scripting/nodes/types/WebView.md`
- Update:
  - `src/core/nodes/index.js` to export `webview`.

### 3) Port UIInput node
- Add:
  - `src/core/nodes/UIInput.js`
  - `docs/scripting/nodes/types/UIInput.md`
- Update:
  - `src/core/nodes/index.js` to export `uiinput`.

### 4) Port script `URL` global + docs
- Update `src/core/systems/Scripts.js` to expose `URL` class (as per `lobbyws-staging`).
- Update `docs/scripting/Utils.md` to include `URL`.

### 5) Adopt Prim raycast change
- Update `src/core/nodes/Prim.js` to remove octree insertion when `opacity === 0`.

### 6) Fly.io integration
- Add `.github/workflows/fly-deploy.yml` (from `lobbyws-staging`, branch trigger = `main`).
- Implement `hyperfy fly …` in `bin/hyperfy.mjs`:
  - `fly init` generator for `fly.toml`
  - `fly secrets` generator + optional `.hyperfy/targets.json` update
- Ensure generated `fly.toml` never contains secrets.
- Persistence default off, `--persist` enables mounts + non-zero `SAVE_INTERVAL`.

### 7) Verification

Build-time:
- `npm run build` (or the repo’s build scripts) should succeed.

Runtime manual checks (local dev):
- WebView (world-space):
  - When pointer locked, clicking a WebView unlocks pointer.
  - Iframe becomes interactable; WebGL scene does not “eat” clicks.
  - Occlusion: place geometry in front of it; iframe is occluded.
  - Build mode: clicking WebView does not unlock pointer.
- WebView (screen-space):
  - Overlay appears and is interactive.
  - Updating `position` at runtime moves the overlay (verifies commit fix).
- UIInput:
  - Click unlocks pointer and focuses input.
  - Typing works; Enter triggers `onSubmit`; Escape blurs.
  - Build mode prevents unlocking.
- Admin client:
  - WebView/UIInput work the same way in `/admin`.
- XR:
  - No crashes when entering XR; WebViews may be absent (accepted).
- Prim:
  - A `prim` with `opacity=0` does not block raycasts/selection.

---

## File-Level Change List (expected)

Add:
- `src/core/nodes/WebView.js`
- `src/core/nodes/UIInput.js`
- `src/core/systems/ClientCSS.js`
- `docs/scripting/nodes/types/WebView.md`
- `docs/scripting/nodes/types/UIInput.md`
- `.github/workflows/fly-deploy.yml`

Update:
- `src/core/nodes/index.js`
- `src/core/createClientWorld.js`
- `src/core/createAdminWorld.js`
- `src/client/world-client.js`
- `src/client/admin-client.js`
- `src/core/systems/ClientGraphics.js`
- `src/core/systems/Scripts.js`
- `docs/scripting/Utils.md`
- `src/core/nodes/Prim.js`
- `bin/hyperfy.mjs`

---

## Sidebar: Confidence If Questions Were Unanswered

If the unanswered items were only around Fly details (persistence defaults, secrets handling, workflow triggers), implementation confidence would still be **high (~0.8)** because the core WebView/UIInput/CSS3D port is straightforward and self-contained.

The main “unknowns that could cause rework” would be:
- Exact desired Fly UX (whether to write targets/secrets automatically vs print commands only).
- Persistence semantics (SAVE_INTERVAL defaults, volume naming/creation guidance).

With the current answers, these uncertainties are resolved enough to implement cleanly.

