### Prerequisites

- Run a world server with `/admin` enabled and an `ADMIN_CODE` set (or leave `ADMIN_CODE` unset for an unprotected world).
- Set these env vars for the app-server process:
  - `WORLD_URL` (e.g. `http://localhost:3000`)
  - `ADMIN_CODE` (must match the world server, if set)

---

### Start the local app server

```bash
# In an empty folder, this bootstraps local state from the world automatically.
WORLD_URL=http://localhost:3000 ADMIN_CODE=secret npx @drama.haus/app-server
```

Notes
- On first run, app-server creates:
  - `apps/` (one folder per world blueprint)
  - `assets/` (downloaded referenced assets)
  - `world.json` (mapping keyed by `blueprint.id`)
- No browser Dev Tools / localhost relay is required.

---

### What “linking” means now

- App-server derives linkage from world state and stores local mapping in `world.json` keyed by `blueprint.id`.
- On first connect with an empty workspace, it imports *all* world blueprints (apps + unused + `$scene`) into `apps/`.

---

### Common workflow

1) Edit your local file on disk: `apps/<appName>/index.js`.
2) App-server detects changes and deploys them directly to the world via `/admin` (uploads + blueprint mutations).

Result: Changes appear in‑world in ~1–2 seconds without page refresh.

What’s watched by the server
- `apps/<appName>/index.js` — script changes deploy via `/admin`
- `apps/<appName>/blueprint.json` — model/props/meta changes deploy via `/admin`
- `assets/**` — if referenced by any blueprint, changes trigger deploy

Tips
- On `version_mismatch`, app-server fast-forwards and reapplies local changes, overwriting world state.
- Downloaded assets are stored under the central `assets/` folder and referenced from `apps/<appName>/blueprint.json`.

---

### Minimal CLI you might use

```bash
# Start server (bootstraps from world, then syncs continuously)
WORLD_URL=http://localhost:3000 ADMIN_CODE=secret npx @drama.haus/app-server
```

---

### Troubleshooting

- Bootstrap didn’t happen: ensure you started app-server in an empty folder and `WORLD_URL` points at the running world server.
- Unauthorized: ensure `ADMIN_CODE` matches the world server `ADMIN_CODE`.
- Changes not appearing: confirm you are editing `apps/<appName>/index.js` and the app-server process is running and connected.

