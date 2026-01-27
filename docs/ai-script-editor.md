# AI Script Editor Workflow (Scaffolding)

This doc describes the client-side hooks for AI-assisted edits in the Script pane
(multi-file module editor). It does not wire any AI provider; it defines the
integration points and review flow.

## Workflow

1. AI proposes changes to one or more existing script files.
2. The Script pane applies the proposed file contents to in-memory models and marks them dirty.
3. The user reviews a diff overlay in the Script pane (unless auto-apply is enabled).
4. The user applies or discards the proposal. If auto-apply is enabled, the proposal
   is committed immediately without a confirmation step. Apply uploads all changed files
   under one deploy lock and updates the script-root blueprint once.

## Internal API

### Proposal payload

Emit an event or call the UI hook with a patch set (full file contents):

- `scriptRootId` (required): script-root blueprint id for the target app.
- `summary` (optional): short description shown in the Script pane.
- `source` (optional): AI provider or agent label.
- `autoPreview` (optional, default true): open the diff overlay immediately.
- `autoApply` (optional, default false): commit the proposal immediately without prompting.
- `files` (required): list of `{ path, content }` entries, where `path` is a valid script path
  and `content` is the full file text. Paths may reference new files to create.

### Event hook

```js
world.emit('script-ai-proposal', {
  scriptRootId: '<blueprint-id>',
  summary: 'Add hover states to buttons',
  source: 'assistant',
  autoPreview: true,
  files: [
    { path: 'index.js', content: '...' },
    { path: 'ui/buttons.ts', content: '...' },
  ],
})
```

### UI hook

When the Script pane is open, the UI exposes:

- `world.ui.scriptEditorAI.proposeChanges(patchSet)`
- `world.ui.scriptEditorAI.openPreview()`
- `world.ui.scriptEditorAI.closePreview()`
- `world.ui.scriptEditorAI.togglePreview()`
- `world.ui.scriptEditorAI.commit()`
- `world.ui.scriptEditorAI.discard()`

These methods operate on the currently selected app's script root.

## Telemetry (dev-only)

Set `PUBLIC_DEBUG_AI_SCRIPT=true` to log AI sync events to the console and emit
`script-ai-sync` on `world` for additional tooling.

## Notes

- Proposals may include new script files; on apply they are added to `scriptFiles`.
- If a target file has unsaved edits, the proposal is rejected; save or discard first.
- Applying a proposal uses a single deploy lock and increments the script-root version once.
- If the script root version changed on the server, refresh before applying a proposal.
