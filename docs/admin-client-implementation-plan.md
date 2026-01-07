# Admin Client Implementation Plan

## Overview

Move the builder experience to a separate admin-only client accessible at `localhost:5000/admin`. This client connects exclusively to the admin WebSocket (`/admin`), displays the world with live player visibility, and provides a free-cam navigation system instead of a player avatar.

## Key Decisions

| Aspect | Decision |
|--------|----------|
| World State Sync | Admin WS sends snapshot when `needsHeartbeat` flag is set |
| Live Players | Visible in admin client (positions streamed via admin WS) |
| Free Cam | WASD + mouse look, FPS-style noclip, starts at spawn point |
| App Structure | Separate React entry point (multi-page Vite config) |
| UI | Identical to current builder UI |
| Multi-Admin | Both can connect, don't see each other (future work) |
| Features | Full builder flow parity |
| Voice Chat | Disabled for admin client |
| Protocol | Binary (MessagePackr) for admin WS |
| Beam Origin | Camera position (center of screen) |

---

## Phase 1: Server-Side Changes

### 1.1 Convert Admin WebSocket to Binary Protocol

**File:** `src/server/admin.js`

**Changes:**
- Import `readPacket` and `writePacket` from `src/core/packets.js`
- Change message handling from JSON to binary MessagePackr format
- Add new packet types to `src/core/packets.js` for admin-specific messages

**New packet types to add in `src/core/packets.js`:**
```javascript
// Add to names array:
'adminAuth',        // Client -> Server: auth with code
'adminAuthResult',  // Server -> Client: auth success/failure
'adminCommand',     // Client -> Server: blueprint_add, entity_modify, etc.
'adminCommandResult', // Server -> Client: ok/error response
```

### 1.2 Add Snapshot Capability to Admin WebSocket

**File:** `src/server/admin.js`

**Changes:**
- Add `needsHeartbeat` flag to auth message payload
- When `needsHeartbeat=true`, send full snapshot after successful auth:
  ```javascript
  // After auth succeeds and needsHeartbeat is true:
  sendPacket(ws, 'snapshot', {
    serverTime: performance.now(),
    assetsUrl: process.env.ASSETS_BASE_URL,
    settings: world.settings.serialize(),
    blueprints: world.blueprints.serialize(),
    entities: world.entities.serialize(),
    players: serializePlayersForAdmin(), // New: current player states
  })
  ```
- Track subscribers that need heartbeat separately: `heartbeatSubscribers`

### 1.3 Stream Player Updates to Admin Subscribers

**File:** `src/server/admin.js`

**Changes:**
- Subscribe to player position updates from `ServerNetwork`
- Broadcast player state changes to `heartbeatSubscribers`:
  - Player joined (with initial position, avatar, name)
  - Player position/rotation updates (throttled to network rate)
  - Player left

**Integration with ServerNetwork:**
- Add event emitter or callback system in `ServerNetwork` for player state changes
- Or have admin module poll/observe the player entities

**New packet types:**
```javascript
'playerJoined',    // Server -> Admin: new player connected
'playerUpdated',   // Server -> Admin: player position/rotation update
'playerLeft',      // Server -> Admin: player disconnected
```

### 1.4 Relay All Entity/Blueprint Events

**File:** `src/server/admin.js`

**Current state:** Already broadcasts `entityModified`, `blueprintAdded`, etc. to subscribers

**Changes:**
- Ensure ALL entity events are forwarded to `heartbeatSubscribers`:
  - `entityAdded`
  - `entityModified`
  - `entityRemoved`
  - `blueprintAdded`
  - `blueprintModified`
  - `settingsModified`
  - `spawnModified`
- Convert broadcasts to binary packet format

---

## Phase 2: Vite/Build Configuration

### 2.1 Configure Multi-Page App

**File:** `vite.config.js`

**Changes:**
```javascript
import { resolve } from 'path'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/client/public/index.html'),
        admin: resolve(__dirname, 'src/client/public/admin.html'),
      },
    },
  },
})
```

### 2.2 Create Admin HTML Entry Point

**New file:** `src/client/public/admin.html`

**Content:**
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Hyperfy Admin</title>
  <link rel="stylesheet" href="/src/client/index.css" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/client/admin.js"></script>
</body>
</html>
```

### 2.3 Configure Dev Server Routing

**File:** `vite.config.js`

**Add dev server configuration:**
```javascript
server: {
  // Ensure /admin route serves admin.html
  // May need custom middleware or historyApiFallback config
}
```

---

## Phase 3: Admin Client Core

### 3.1 Create Admin React Entry Point

**New file:** `src/client/admin.js`

**Content:**
```javascript
import { createRoot } from 'react-dom/client'
import { AdminClient } from './admin-client'

const root = createRoot(document.getElementById('root'))
root.render(<AdminClient />)
```

### 3.2 Create Admin Client React Component

**New file:** `src/client/admin-client.js`

**Structure (similar to `world-client.js`):**
- Create admin world via `createAdminWorld()`
- Initialize with viewport and UI refs
- Set up base environment (HDR, sun, fog)
- Connect to admin WebSocket
- Render similar UI but without player-specific elements

**Key differences from `world-client.js`:**
- No avatar selection/customization UI
- No voice chat controls (LiveKit)
- No player-specific HUD elements
- Uses `AdminNetwork` instead of `ClientNetwork`

### 3.3 Create Admin World Factory

**New file:** `src/core/createAdminWorld.js`

**Systems to include:**
```javascript
// Rendering & Scene
world.register('client', Client)           // Render loop (adapt for admin)
world.register('graphics', ClientGraphics) // Three.js rendering
world.register('stage', Stage)             // Scene graph
world.register('environment', Environment) // Skybox, lighting

// Data & State
world.register('entities', Entities)       // Entity management
world.register('blueprints', Blueprints)   // Blueprint registry
world.register('settings', Settings)       // World settings

// Network
world.register('adminNetwork', AdminNetwork) // NEW: Admin-specific network

// Input & Controls
world.register('control', ClientControls)  // Input handling

// Builder
world.register('builder', AdminBuilder)    // NEW: Adapted builder for admin
world.register('admin', AdminClient)       // Existing admin command sender

// Assets
world.register('loader', ClientLoader)     // Asset loading

// Utilities
world.register('snaps', Snaps)             // Snap points
world.register('octree', Octree)           // Spatial queries
```

**Systems to EXCLUDE:**
```javascript
// No player systems
// world.register('avatars', Avatars)      // Not needed without player
// world.register('livekit', LiveKit)      // No voice chat
// world.register('xr', XR)                // No XR support for admin (initially)
// world.register('analytics', Analytics)  // No analytics
```

### 3.4 Create AdminNetwork System

**New file:** `src/core/systems/AdminNetwork.js`

**Responsibilities:**
- Connect to `/admin` WebSocket
- Send auth message with `needsHeartbeat: true`
- Handle binary packets via MessagePackr
- Process snapshot on connection
- Handle continuous updates:
  - Entity events (added/modified/removed)
  - Blueprint events
  - Player events (joined/updated/left)
  - Settings/spawn changes

**Key methods:**
```javascript
class AdminNetwork extends System {
  init({ adminUrl, adminCode }) {
    // Connect to admin WS
  }

  onSnapshot(data) {
    // Deserialize world state
    // Initialize entities, blueprints, settings
    // Create player representations
  }

  onPlayerJoined(data) {
    // Create remote player entity (visual only)
  }

  onPlayerUpdated(data) {
    // Update player position/rotation
  }

  onPlayerLeft(data) {
    // Remove player entity
  }

  // Reuse existing event handlers from ClientNetwork:
  onEntityAdded(data) { ... }
  onEntityModified(data) { ... }
  onEntityRemoved(data) { ... }
  onBlueprintAdded(data) { ... }
  onBlueprintModified(data) { ... }
}
```

### 3.5 Create FreeCam Entity

**New file:** `src/core/entities/FreeCam.js`

**Properties:**
```javascript
class FreeCam {
  position = new Vector3()    // World position
  quaternion = new Quaternion() // Rotation
  euler = new Euler()         // For yaw/pitch control

  moveSpeed = 10              // Units per second
  fastMultiplier = 3          // Shift key multiplier
  lookSpeed = 0.002           // Mouse sensitivity

  // Pitch limits
  minPitch = -89 * DEG2RAD
  maxPitch = 89 * DEG2RAD
}
```

**Controls (WASD + Mouse Look):**
```javascript
update(delta) {
  const control = this.world.control

  // Mouse look (when pointer locked)
  if (control.pointer.locked) {
    this.euler.y -= control.pointer.delta.x * this.lookSpeed
    this.euler.x -= control.pointer.delta.y * this.lookSpeed
    this.euler.x = clamp(this.euler.x, this.minPitch, this.maxPitch)
    this.quaternion.setFromEuler(this.euler)
  }

  // Movement
  const speed = control.shiftLeft.down
    ? this.moveSpeed * this.fastMultiplier
    : this.moveSpeed

  const moveDir = new Vector3()
  if (control.keyW.down) moveDir.z -= 1
  if (control.keyS.down) moveDir.z += 1
  if (control.keyA.down) moveDir.x -= 1
  if (control.keyD.down) moveDir.x += 1
  if (control.space.down) moveDir.y += 1      // Fly up
  if (control.keyC.down) moveDir.y -= 1       // Fly down

  moveDir.normalize()
  moveDir.applyQuaternion(this.quaternion)
  moveDir.multiplyScalar(speed * delta)

  this.position.add(moveDir)

  // Update camera
  this.world.rig.position.copy(this.position)
  this.world.rig.quaternion.copy(this.quaternion)
}
```

**Initialization:**
- Start position: World spawn point (`world.settings.spawn`)
- Start rotation: Face spawn direction

---

## Phase 4: Admin Builder System

### 4.1 Create AdminBuilder System

**New file:** `src/core/systems/AdminBuilder.js`

**Based on:** `src/core/systems/ClientBuilder.js`

**Key adaptations:**

1. **Remove player dependency:**
   - Current: `this.world.entities.player` for position/permissions
   - Admin: Always has full permissions, position from FreeCam

2. **Beam origin from camera:**
   ```javascript
   getBeamOrigin() {
     // Instead of player position, use camera position
     return this.world.camera.getWorldPosition(new Vector3())
   }

   getBeamDirection() {
     // Camera forward direction
     return new Vector3(0, 0, -1).applyQuaternion(this.world.camera.quaternion)
   }
   ```

3. **Remove permission checks:**
   - Current: `if (!this.world.entities.player?.isBuilder()) return`
   - Admin: Always allowed to build

4. **Adapt control bindings:**
   - Ensure controls work without player entity
   - Tab key still toggles build mode
   - All builder shortcuts work the same (1-4 for modes, R duplicate, X delete, etc.)

5. **Keep all features:**
   - Grab mode
   - Translate/Rotate/Scale gizmos
   - Duplicate (R key)
   - Delete (X key)
   - Pin/Unpin (P key)
   - Unlink blueprint (U key)
   - File upload (drag-drop)
   - Undo system

### 4.2 Adapt Pointer Lock for Admin

**File:** `src/core/systems/ClientControls.js`

**Current behavior:** Pointer lock is requested by player for camera control

**Admin behavior:**
- Pointer lock for free cam navigation
- Click to lock, Escape to unlock
- Same as current behavior, just not tied to player entity

---

## Phase 5: UI Components

### 5.1 Admin Client UI Structure

**File:** `src/client/admin-client.js`

**Include from `world-client.js`:**
- Viewport component (canvas container)
- Builder HUD (mode indicators, hints)
- Chat panel (read-only or full?)
- Toast notifications
- Loading states

**Exclude:**
- Avatar customization
- Voice chat controls
- Player HUD elements
- XR entry buttons

### 5.2 Build Mode Always Available

**Current:** Build mode toggled with Tab, requires Builder rank

**Admin:**
- Build mode can be on by default or toggled
- No permission check needed
- Same visual indicators and hints

---

## Phase 6: Player Representation in Admin

### 6.1 AdminPlayerRemote Entity

**New file:** `src/core/entities/AdminPlayerRemote.js`

**Based on:** `src/core/entities/PlayerRemote.js`

**Simplifications:**
- Visual representation only (avatar model)
- No physics capsule needed
- No collision
- Position/rotation interpolation for smooth movement
- Nametag display

**Updates received via AdminNetwork:**
- Position
- Rotation
- Avatar URL
- Display name
- Animation state (optional)

---

## Phase 7: Packets & Protocol

### 7.1 New Packet Types

**File:** `src/core/packets.js`

**Add to `names` array:**
```javascript
// Admin protocol
'adminAuth',           // C->S: { code, needsHeartbeat, networkId }
'adminAuthOk',         // S->C: auth success
'adminAuthError',      // S->C: { error: string }
'adminCommand',        // C->S: { type, ...payload, requestId }
'adminResult',         // S->C: { ok, error?, requestId }

// Player streaming (for admin clients with needsHeartbeat)
'playerJoined',        // S->C: { id, name, avatar, position, quaternion }
'playerUpdated',       // S->C: { id, position, quaternion }
'playerLeft',          // S->C: { id }
```

### 7.2 Admin Command Types

Commands sent via `adminCommand` packet:
- `blueprint_add`
- `blueprint_modify`
- `entity_add`
- `entity_modify`
- `entity_remove`
- `settings_modify`
- `spawn_modify`
- `upload` (may need special handling for binary file data)

---

## File Structure Summary

### New Files

```
src/
├── client/
│   ├── admin.js                    # Admin entry point
│   ├── admin-client.js             # Admin React component
│   └── public/
│       └── admin.html              # Admin HTML entry
├── core/
│   ├── createAdminWorld.js         # Admin world factory
│   ├── entities/
│   │   ├── FreeCam.js              # Free camera entity
│   │   └── AdminPlayerRemote.js    # Player representation
│   └── systems/
│       ├── AdminNetwork.js         # Admin WebSocket handler
│       └── AdminBuilder.js         # Adapted builder system
```

### Modified Files

```
src/
├── server/
│   └── admin.js                    # Binary protocol, snapshot, player streaming
├── core/
│   ├── packets.js                  # New packet types
│   └── systems/
│       └── ServerNetwork.js        # Emit player events for admin relay
vite.config.js                      # Multi-page app configuration
```

---

## Implementation Order

1. **Server: Binary protocol for admin WS** (foundation)
2. **Server: Snapshot on needsHeartbeat** (required for admin client)
3. **Server: Player streaming to admin** (required for player visibility)
4. **Vite: Multi-page configuration** (required for /admin route)
5. **Client: Admin entry point & HTML** (minimal setup)
6. **Client: createAdminWorld** (world without player)
7. **Client: AdminNetwork** (connect and receive data)
8. **Client: FreeCam entity** (navigation)
9. **Client: AdminBuilder** (adapted from ClientBuilder)
10. **Client: AdminPlayerRemote** (player visualization)
11. **Client: Admin UI** (adapted from world-client)
12. **Integration testing**

---

## Testing Checklist

- [ ] Admin client loads at `/admin`
- [ ] Connects to admin WebSocket with code
- [ ] Receives and renders world snapshot
- [ ] Free cam navigation works (WASD + mouse)
- [ ] Can see other players moving
- [ ] Build mode activates
- [ ] Can select entities
- [ ] Grab mode works (beam from camera)
- [ ] Gizmo modes work (translate/rotate/scale)
- [ ] Duplicate works (R key)
- [ ] Delete works (X key)
- [ ] Pin/Unpin works (P key)
- [ ] File upload works (drag-drop GLB/VRM)
- [ ] Changes sync to player clients
- [ ] Changes from player clients sync to admin
- [ ] Multiple admin clients can connect
- [ ] Undo system works

---

## Future Considerations (Out of Scope)

- Admin-to-admin visibility (see each other's cursors)
- Admin-specific UI panels (entity hierarchy, property inspector)
- XR support for admin
- Admin voice chat channel
- Role-based admin permissions
- Undo/redo across sessions
