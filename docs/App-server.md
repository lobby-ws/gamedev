# App-server

App-server is the dev server that syncs local files to a world via `/admin`. It is intended for development only and can overwrite world state, so avoid running it against prod targets. For prod/staging, prefer explicit deploys (`gamedev apps deploy`).

---

### Prerequisites

- Run a world server with `/admin` enabled.
- Set these env vars for the app-server process:
  - `WORLD_URL` (e.g. `http://localhost:3000`)
  - `WORLD_ID` (must match the target worldId)
  - `ADMIN_CODE` (must match the world server, if set)
  - `DEPLOY_CODE` (required for script updates when configured)

---

### Start the app-server

```bash
# In an empty folder, this scaffolds built-ins locally and deploys them.
WORLD_URL=http://localhost:3000 WORLD_ID=dev-world ADMIN_CODE=secret DEPLOY_CODE=deploy-secret node app-server/server.js
```

Notes
- On first run, app-server creates:
  - `apps/` (built-in templates + $scene)
  - `assets/` (downloaded referenced assets)
  - `world.json` (world layout + per-entity overrides)
- If you want to pull script code from an existing world, use:
  - `gamedev world export --include-built-scripts`
- `gamedev dev` is the recommended entrypoint for continuous sync and will ask for confirmation on prod targets.
- No browser Dev Tools / localhost relay is required.

---

### Multi-target config

Define targets in `.lobby/targets.json` and pass `--target <name>` to the CLI or app-server.

```json
{
  "dev": {
    "worldUrl": "http://localhost:3000",
    "worldId": "dev-world",
    "adminCode": "secret",
    "deployCode": "deploy-secret"
  },
  "prod": {
    "worldUrl": "https://world.example.com",
    "worldId": "prod-world",
    "adminCode": "secret",
    "deployCode": "deploy-secret",
    "confirm": true
  }
}
```

```bash
node app-server/server.js --target dev
gamedev dev --target dev
gamedev apps deploy myApp --target prod
```

---

### Template defaults vs instance overrides

- Blueprint files in `apps/<appName>/*.json` define template defaults (what new instances start with).
- Per-instance overrides live in `world.json` under `entities[].props` and are applied to the running world.
- Editing instance props in the admin UI updates `world.json` when app-server is running.
- Editing `world.json` while app-server is running applies the change back into the world.

Use blueprint JSON for defaults, and use `world.json` for per-instance tweaks.

---

### Common workflow

1) Edit `apps/<appName>/index.ts` (or `index.js`) and/or `apps/<appName>/*.json`.
2) App-server bundles scripts, detects changes (including imports), and deploys via `/admin`.

Result: Changes appear in-world in ~1–2 seconds without page refresh.

What’s watched by the server
- `apps/<appName>/index.(js|ts)` and imports — script changes deploy via `/admin`
- `apps/<appName>/*.json` — model/props/meta changes deploy via `/admin`
- `assets/**` — if referenced by any blueprint, changes trigger deploy

Tips
- On `version_mismatch`, app-server fast-forwards and reapplies local changes, overwriting world state.
- Downloaded assets live in the shared `assets/` folder and are referenced from blueprint JSON.

---

### Deploy safety (locks, snapshots, rollback)

- App-server acquires a deploy lock before applying script changes. If another deploy agent holds the lock, you will see a "locked" error.
- Deploy locks are scoped per app; global locks still block all scopes. `.hyp` imports lock by blueprint id (or `$scene`).
- Each deploy creates a snapshot of the affected blueprints. Rollback restores the last snapshot (or a specific snapshot id).

```bash
gamedev apps deploy myApp --dry-run
gamedev apps deploy myApp --note "fix font sizing"
gamedev apps rollback
gamedev apps rollback <snapshotId>
```

For prod targets, the CLI asks for confirmation unless you pass `--yes`.

---

### Troubleshooting

- Bootstrap didn’t happen: ensure the target world is empty/default or run `gamedev world export --include-built-scripts`.
- Unauthorized: ensure `ADMIN_CODE` matches the world server `ADMIN_CODE`.
- Script updates rejected: ensure `DEPLOY_CODE` matches and the deploy lock is free.
- WORLD_ID mismatch: set `WORLD_ID` to match the target world id.
- Changes not appearing: confirm `apps/<appName>/index.ts` (or blueprint JSON) is being edited and app-server is connected.
