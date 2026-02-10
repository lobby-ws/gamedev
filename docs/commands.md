# Commands

There are a few commands that can be used by entering them in the chat.

### `/admin <code>`

If your world has an admin code set, the only way to become an admin is to use this command with your code (see your .env file).

If your .env doesn't have an ADMIN_CODE set, then all players are treated as an admin.

### `/spawn set`

Sets the spawn point for all future players entering the world, to the current position and direction you are facing. Requires builder rank.

### `/spawn clear`

Resets the spawn point back to origin. Requires builder rank.

### `/name <name>`

Sets your player name.

### `/chat clear`

Clears all chat messages. Requires builder rank.

---

## Gamedev CLI

### `gamedev mods deploy`

Builds and deploys world-project mods from `./mods` to the configured world.

Usage:

```bash
gamedev mods deploy [--target <name>] [--dry-run] [--note <text>]
gamedev mods order show [--target <name>]
gamedev mods order set <id[,id...]> [--target <name>]
gamedev mods order clear [--target <name>]
```

Options:

- `--target <name>`: use a target from `.lobby/targets.json`
- `--dry-run`: print deploy plan without uploading/publishing
- `--note <text>`: attach a deploy note to the persisted mods manifest

### Mods Troubleshooting

- `invalid_mod_manifest`: check module shape in `mods/` and redeploy.
- `invalid_mod_load_order`: fix `mods/load-order.json`, or clear DB override with `gamedev mods order clear`.
- `mods_load_order_override_ignored:*`: DB override exists but is invalid for the deployed module ids.
- Browser import failures from S3: ensure uploaded `.js/.mjs/.cjs` assets are served as `text/javascript` with correct CORS.
- If `CLEAN=true`, stale `assets/mods/*` bundles are removed from persisted `mods_manifest`; `SAVE_INTERVAL` does not manage mods.
- `React is not defined` in mod UI: redeploy mods with current toolchain and restart client so UI bundles use host React runtime shims.
