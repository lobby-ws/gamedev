# Recommended workflow

This is a practical split between builders (world layout) and developers (app code) that keeps changes predictable and easy to sync.

---

### Builders (admin client)

- Use the in-world admin UI to place, move, and configure instances.
- Edit per-instance props (the right-hand "Instance" column) for unique overrides.
- Avoid editing `apps/` or `world.json` directly.

When app-server is running, your instance edits are persisted into `world.json`, so developers can commit layout changes without manual export.

---

### Developers (app-server / CLI)

- Use app-server to sync local files to the world via `/admin`.
- Edit template defaults in `apps/<appName>/*.json` and scripts in `apps/<appName>/index.js`.
- Use `world.json` for layout and per-instance overrides when you want changes tracked in git.
- Use targets (`--target staging`, `--target prod`) for multi-environment deploys.

Recommended commands:

```bash
hyperfy dev --target dev
hyperfy apps deploy myApp --target staging --dry-run
hyperfy apps deploy myApp --target prod --note "release-1"
hyperfy apps rollback
```

---

### Working together

- Builders adjust layout and instance props in the admin UI.
- Developers pull or commit `world.json` changes and handle script/template updates.
- Script updates require `DEPLOY_CODE`, so coordinate with whoever owns deploy access.

This split keeps builders unblocked while ensuring script changes go through a controlled deploy path.
