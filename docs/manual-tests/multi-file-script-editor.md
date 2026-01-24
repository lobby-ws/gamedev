# Manual Test: Multi-File Script Editor

## Prereqs

- Run the app-server with a module-mode app in `apps/<AppName>/` that produces `scriptFiles`.
- Connect as an admin client with deploy code access.

## Steps

1. Open the world and select an app that uses module scripts.
2. Open the Script pane and confirm the file tree lists module paths and the entry file.
3. Open a file, make a change, and click Save.
4. Confirm a success toast appears and the app reloads.
5. Verify the updated source was written to `apps/<AppName>/<relPath>` on disk.
6. Trigger a remote change to the same file (another client or app-server) and attempt Save.
7. Confirm the version conflict message appears, then click Refresh and Retry.
8. With a deploy lock held elsewhere, attempt Save and confirm the deploy lock error message is shown.
