# Scripts

## IMPORTANT

As Hyperfy is in alpha, the scripting API is likely to evolve fast with breaking changes.
This means your apps can and will break as you upgrade worlds.
Once scripting is stable we'll move toward a forward compatible model, which will allow apps to be shared/traded with more confidence that they will continue to run correctly.

## Lifecycle

App scripts execute in every environment (server + each client). The top-level module code runs once per build in that environment, so treat it as initialization.

Use `world.isServer` and `world.isClient` to split logic, and store shared server state on `app.state` so late-joining clients can initialize correctly.

Update events:
- `app.on('fixedUpdate', ...)` for fixed timestep logic
- `app.on('update', ...)` for per-frame logic
- `app.on('lateUpdate', ...)` for post-frame logic
- `app.on('animate', ...)` for distance-based animation ticks

Cleanup:
- `app.on('destroy', ...)` fires when an app is rebuilt or removed. Unsubscribe events, release controls, and clear timers there.

## Apps

[Apps](./app/App.md) power Hyperfy's content. You can think of them as a combination of a model and a script. They can talk to eachother, and run both on the client and the server. Apps have a UI to configure [properties](./app/Props.md) in the scripts, and can load additional models inside of them.

## Nodes

Apps are made up of a hierarchy of [nodes](./nodes/Node.md) that you can view and modify within the app runtime using scripts.

The gltf model that each app is based on is automatically converted into nodes and inserted into the app runtime for you to interact with.

Certain node [types](./nodes/types/) can also be created and used on the fly using `app.create(nodeName)`.

## World

The [World](./world/World.md) API access methods and properties outside of the Apps, like players, networking or managing nodes outside of the local hierarchy. 

## Utils 

The [Utils](./utils.md) documentation provides a set of miscellaneous globals available in the scripting environment, like a random number generator and access to some `three.js` methods.

## Networking

Hyperfy [Networking](./Networking.md) happens inside of Apps, using methods from both the `App` and `World` APIs. You can either send events between the client and server on the same app, or send messages to external apps on the server. 

## Script Formats and Imports

App scripts are always uploaded as a folder of files (no bundling). The entry is `apps/<AppName>/index.js` or `index.js`, and `scriptFormat` tells the runtime how to interpret the entry file.

Entry formats:
- `module`: the entry file must `export default (world, app, fetch, props, setTimeout) => { ... }`.
- `legacy-body`: keep the classic body-style entry (no `export`). Imports must be at the top of the entry file. The runtime wraps it into `export default (...) => { ... }`.

If `scriptFormat` is missing, app-server infers it during deploy:
- `module` when the entry exports default.
- `legacy-body` otherwise (with a warning). The blueprint JSON is not modified.

Import rules (all formats):
- Relative imports only (`./` or `../`) inside the same app folder.
- No bare imports (`react`, `lodash`), no node builtins, no cross-app imports.

## Migration

Legacy single-file scripts remain supported without any changes. To opt into multi-file modules:

Legacy-body (minimal change):
1) Add `"scriptFormat": "legacy-body"` to your app's blueprint JSON (or run `gamedev scripts migrate --legacy-body`).
2) Keep your existing `index.js`/`index.js` body-style entry and move helpers into new `.js/.ts` files with relative imports.
3) Run app-server or `gamedev apps deploy <app>`.

Module (full ESM):
1) Add `"scriptFormat": "module"` to your app's blueprint JSON (or run `gamedev scripts migrate --module`).
2) Update `index.js`/`index.js` to `export default` a function with the same signature.
3) Move shared logic into modules and use relative imports.

Bundling is removed. If you relied on bare imports or node builtins, refactor to local modules.

## Globals

- [app](./app/App.md)
- [world](./world/World.md)
- [props](./app/Props.md)
- [utils](./utils.md)
