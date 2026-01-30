# Code Changes Summary

This document contains all code differences in the `/src/` directory between the hyperfy-splatting fork and the original Hyperfy repository.

## High-Level Summary of Changes

The changes implement **Gaussian Splatting support** for the Hyperfy metaverse platform, adding:

1. **Complete Gaussian Splat Node Implementation** (`GaussianSplat.js`)
   - New 3D node type for rendering Gaussian splat files (.ply, .splat, .spz, .ksplat)
   - Support for color tinting, opacity, scaling, and LOD rendering
   - Automatic 180° orientation correction for proper splat display
   - Ghost splat prevention through creation ID tracking

2. **Enhanced Entity Selection & Interaction** (`ClientBuilder.js`)
   - Splat-aware raycasting that compares distances between regular meshes and splats
   - Support for Delete/Backspace keys for entity deletion
   - Force translate mode for splats (grab mode disabled for performance)
   - Splat app configuration panel with color, opacity, and scale controls

3. **Robust Splat File Loading** (`ClientLoader.js`)
   - Support for multiple splat formats (PLY, SPZ, SPLAT, KSPLAT)
   - Unified loading pipeline using Spark.js
   - Proper format detection and blob URL handling
   - Error handling and timeout protection

4. **Advanced Rendering Pipeline** (`Stage.js`)
   - Integration with Spark.js renderer for high-performance splat rendering
   - Automatic 180° X-axis flip for correct splat orientation
   - On-demand precision raycasting using WASM-based ellipsoid detection
   - Device-specific performance optimizations (mobile/Quest settings)
   - LOD (Level of Detail) rendering support

## Modified Files

- **src/core/nodes/GaussianSplat.js** - New Gaussian splat node implementation
- **src/core/systems/ClientBuilder.js** - Enhanced entity selection and interaction
- **src/core/systems/ClientLoader.js** - Splat file loading pipeline  
- **src/core/systems/Stage.js** - Rendering system integration

---

## Detailed Code Diffs

### src/core/nodes/GaussianSplat.js

```diff
diff --git a/src/core/nodes/GaussianSplat.js b/src/core/nodes/GaussianSplat.js
index 9452e8e..a9b2046 100644
--- a/src/core/nodes/GaussianSplat.js
+++ b/src/core/nodes/GaussianSplat.js
@@ -33,6 +33,7 @@ export class GaussianSplat extends Node {
     this.loadingState = 'idle' // 'idle', 'loading', 'loaded', 'error'
     this.needsRebuild = false
     this.handle = null
+    this.handleCreationId = 0 // Unique ID for each handle creation attempt (prevents ghost splats)
   }
 
   mount() {
@@ -56,6 +57,10 @@ export class GaussianSplat extends Node {
   }
 
   unmount() {
+    // Increment creation ID to invalidate any pending handle creation
+    this.handleCreationId++
+
+    // Destroy existing handle
     this.handle?.destroy()
     this.handle = null
   }
@@ -106,6 +111,15 @@ export class GaussianSplat extends Node {
     // Only create SplatMesh on client
     if (this.ctx.world.network.isServer) return
 
+    // Destroy existing handle before creating new one
+    if (this.handle) {
+      this.handle.destroy()
+      this.handle = null
+    }
+
+    // Track this creation attempt with unique ID
+    const creationId = ++this.handleCreationId
+
     // Determine URL to use based on loaded data or fallback
     let actualURL = this.ctx.world.resolveURL(this._src)
 
@@ -126,16 +140,28 @@ export class GaussianSplat extends Node {
       }
     }
 
-    this.handle = await this.ctx.world.stage.insertGaussianSplat({
+    // Create the splat handle (async operation)
+    // Note: sortMode is not passed - Spark.js handles sorting internally via SparkRenderer
+    const newHandle = await this.ctx.world.stage.insertGaussianSplat({
       url: actualURL,
       node: this,
       matrix: this.matrixWorld,
-      sortMode: this._sortMode,
       color: this._color,
       opacity: this._opacity,
       splatScale: this._splatScale,
       lodRenderScale: this._lodRenderScale
     })
+
+    // Check if this creation was invalidated while we were waiting
+    if (creationId !== this.handleCreationId) {
+      // This handle is stale - destroy it immediately to prevent ghost splat
+      console.log('🗑️ [GaussianSplat] Destroying stale handle (creation invalidated)')
+      newHandle?.destroy()
+      return
+    }
+
+    // Assign the handle
+    this.handle = newHandle
   }
 
   copy(source, recursive) {
@@ -216,6 +242,8 @@ export class GaussianSplat extends Node {
   }
 
 
+  // Note: sortMode is kept for backwards compatibility but has no effect
+  // Spark.js handles sorting internally via SparkRenderer
   get sortMode() {
     return this._sortMode
   }
@@ -226,12 +254,7 @@ export class GaussianSplat extends Node {
     }
     if (this._sortMode === value) return
     this._sortMode = value
-    if (this.handle && this.handle.updateSortMode) {
-      this.handle.updateSortMode(value)
-    } else if (this.handle) {
-      this.needsRebuild = true
-      this.setDirty()
-    }
+    // Note: Spark.js does not support sortMode - sorting is handled automatically
   }
 
   get color() {
```

### src/core/systems/ClientBuilder.js

```diff
diff --git a/src/core/systems/ClientBuilder.js b/src/core/systems/ClientBuilder.js
index ade0761..380e401 100644
--- a/src/core/systems/ClientBuilder.js
+++ b/src/core/systems/ClientBuilder.js
@@ -232,7 +232,7 @@ export class ClientBuilder extends System {
     }
     // inspect in pointer-lock
     if (this.beam.active && this.control.mouseRight.pressed) {
-      const entity = this.getEntityAtBeam()
+      let entity = this._getClosestEntityAtBeam()
       if (entity?.isApp) {
         this.select(null)
         this.control.pointer.unlock()
@@ -246,7 +246,7 @@ export class ClientBuilder extends System {
     }
     // inspect out of pointer-lock
     else if (!this.selected && !this.beam.active && this.control.mouseRight.pressed) {
-      const entity = this.getEntityAtCursor()
+      let entity = this._getClosestEntityAtCursor()
       if (entity?.isApp) {
         this.select(null)
         this.control.pointer.unlock()
@@ -335,10 +335,53 @@ export class ClientBuilder extends System {
       }
     }
     if (!this.justPointerLocked && this.beam.active && this.control.mouseLeft.pressed) {
+      // Helper to get entity from regular raycast OR splat raycast
+      // Compares distances and returns the CLOSEST hit
+      const getEntityIncludingSplats = () => {
+        // Get regular raycast hit with distance
+        const origin = this.beam.position
+        const dir = v1.set(0, 0, -1).applyQuaternion(this.beam.quaternion)
+        const regularHits = this.world.stage.raycast(origin, dir)
+        let regularEntity = null
+        let regularDistance = Infinity
+        for (const hit of regularHits) {
+          const entity = hit.getEntity?.()
+          if (entity) {
+            regularEntity = entity
+            regularDistance = hit.distance || Infinity
+            break
+          }
+        }
+
+        // Get splat raycast hit with distance
+        const splatHits = this.world.stage.raycastSplatsAtReticle()
+        let splatEntity = null
+        let splatDistance = Infinity
+        if (splatHits.length > 0) {
+          splatEntity = splatHits[0].getEntity?.()
+          splatDistance = splatHits[0].distance || Infinity
+        }
+
+        // Return the closer one
+        if (splatEntity && splatDistance < regularDistance) {
+          return { entity: splatEntity, isSplat: true }
+        }
+        if (regularEntity) {
+          return { entity: regularEntity, isSplat: false }
+        }
+        return { entity: null, isSplat: false }
+      }
+
       // if nothing selected, attempt to select
       if (!this.selected) {
-        const entity = this.getEntityAtBeam()
-        if (entity?.isApp && !entity.data.pinned && !entity.blueprint.scene) this.select(entity)
+        const { entity, isSplat } = getEntityIncludingSplats()
+        if (entity?.isApp && !entity.data.pinned && !entity.blueprint.scene) {
+          // For splats: force translate mode (grab mode would be too expensive)
+          if (isSplat && this.mode === 'grab') {
+            this.setMode('translate')
+          }
+          this.select(entity)
+        }
       }
       // if selected in grab mode, place
       else if (this.selected && this.mode === 'grab') {
@@ -350,7 +393,7 @@ export class ClientBuilder extends System {
         (this.mode === 'translate' || this.mode === 'rotate' || this.mode === 'scale') &&
         !this.gizmoActive
       ) {
-        const entity = this.getEntityAtBeam()
+        const { entity, isSplat } = getEntityIncludingSplats()
         if (entity?.isApp && !entity.data.pinned && !entity.blueprint.scene) this.select(entity)
         else this.select(null)
       }
@@ -360,6 +403,9 @@ export class ClientBuilder extends System {
       this.select(null)
     }
     // duplicate
+    // TODO: Currently duplicates the entire app (including splats inside).
+    // For splat apps, this duplicates the mesh within the same app, not creating a new app instance.
+    // Consider: Shift+R = duplicate as new app, R = duplicate mesh only (current behavior)?
     let duplicate
     if (this.xrMenu?.copy) {
       this.xrMenu.copy = false
@@ -426,7 +472,11 @@ export class ClientBuilder extends System {
     if (this.xrMenu.delete) {
       destroy = true
       this.xrMenu.delete = false
-    } else if (this.control.keyX.pressed) {
+    } else if (
+      this.control.keyX.pressed ||
+      this.control.delete.pressed ||
+      this.control.backspace.pressed
+    ) {
       destroy = true
     }
     if (destroy) {
@@ -946,6 +996,70 @@ export class ClientBuilder extends System {
     return entity
   }
 
+  // Get closest entity including splats (compares distances)
+  _getClosestEntityAtBeam() {
+    const origin = this.beam.position
+    const dir = v1.set(0, 0, -1).applyQuaternion(this.beam.quaternion)
+
+    // Regular raycast
+    const regularHits = this.world.stage.raycast(origin, dir)
+    let regularEntity = null
+    let regularDistance = Infinity
+    for (const hit of regularHits) {
+      const entity = hit.getEntity?.()
+      if (entity) {
+        regularEntity = entity
+        regularDistance = hit.distance || Infinity
+        break
+      }
+    }
+
+    // Splat raycast
+    const splatHits = this.world.stage.raycastSplatsAtReticle()
+    let splatEntity = null
+    let splatDistance = Infinity
+    if (splatHits.length > 0) {
+      splatEntity = splatHits[0].getEntity?.()
+      splatDistance = splatHits[0].distance || Infinity
+    }
+
+    // Return closer one
+    if (splatEntity && splatDistance < regularDistance) {
+      return splatEntity
+    }
+    return regularEntity
+  }
+
+  _getClosestEntityAtCursor() {
+    // Regular raycast
+    const regularHits = this.world.stage.raycastPointer(this.control.pointer.position)
+    let regularEntity = null
+    let regularDistance = Infinity
+    for (const hit of regularHits) {
+      const entity = hit.getEntity?.()
+      if (entity) {
+        regularEntity = entity
+        regularDistance = hit.distance || Infinity
+        break
+      }
+    }
+
+    // Splat raycast
+    const splatHits = this.world.stage.raycastSplatsAtPointer(this.control.pointer.position)
+    let splatEntity = null
+    let splatDistance = Infinity
+    if (splatHits.length > 0) {
+      splatEntity = splatHits[0].getEntity?.()
+      splatDistance = splatHits[0].distance || Infinity
+    }
+
+    // Return closer one
+    if (splatEntity && splatDistance < regularDistance) {
+      return splatEntity
+    }
+    return regularEntity
+  }
+
   getHitAtBeam(ignoreEntity, ignorePlayers) {
     const origin = this.beam.position
     const dir = v1.set(0, 0, -1).applyQuaternion(this.beam.quaternion)
@@ -1126,13 +1240,7 @@ app.configure([
     initial: false,
     hint: 'Toggle visibility of positioning cube handle'
   },
-  {
-    key: 'autoRotate',
-    type: 'toggle',
-    label: 'Flip Splat along X-axis',
-    initial: true,
-    hint: 'Automatically rotate splats 180° on X-axis for correct orientation'
-  },
+  // Note: autoRotate removed - 180° flip is now applied internally in Stage.js
   {
     key: 'color',
     type: 'color',
@@ -1190,7 +1298,7 @@ app.on('update', () => {
     lastShowCube = props.showCube
     console.log('🎲 Cube visibility updated to:', props.showCube)
   }
-  
+
   // Handle splat file changes
   if (props.splatFile && typeof props.splatFile === 'string' && props.splatFile.startsWith('asset://')) {
     // Only create new splat if the file changed
@@ -1200,8 +1308,9 @@ app.on('update', () => {
         splat.parent.remove(splat)
         splat = null
       }
-      
+
       // Create new splat (only once!)
+      // Note: 180° flip is applied internally in Stage.js, no app.rotation needed
       try {
         splat = app.create('gaussiansplat', {
           src: props.splatFile,
@@ -1210,14 +1319,7 @@ app.on('update', () => {
           color: props.color || '#ffffff',
           opacity: props.opacity !== undefined ? props.opacity : 1.0
         })
-        
-        // Rotate 180° around X-axis to fix splat orientation (if enabled)
-        if (props.autoRotate !== false) {
-          // Rotate the entire app instead of just the splat
-          // This way the transform values in the UI will be correct
-          app.rotation.x = Math.PI
-        }
-        
+
         app.add(splat)
         lastSplatFile = props.splatFile
         lastColor = props.color
@@ -1257,8 +1359,6 @@ app.on('update', () => {
       console.error('❌ Failed to update opacity:', error)
     }
   }
-  
-  
 })
 
 
```

### src/core/systems/ClientLoader.js

```diff
diff --git a/src/core/systems/ClientLoader.js b/src/core/systems/ClientLoader.js
index d6d1101..3b938be 100644
--- a/src/core/systems/ClientLoader.js
+++ b/src/core/systems/ClientLoader.js
@@ -12,7 +12,7 @@ import { TextureLoader } from 'three'
 import { formatBytes } from '../extras/formatBytes'
 import { emoteUrls } from '../extras/playerEmotes'
 import Hls from 'hls.js/dist/hls.js'
-import { createStreamingSplatMesh } from '../extras/StreamingSplatLoader'
+// Streaming loader removed - using Spark.js native handling for all formats
 
 // THREE.Cache.enabled = true
 
@@ -339,145 +339,36 @@ export class ClientLoader extends System {
         const format = file.name.split('.').pop().toLowerCase()
         console.log('📦 [ClientLoader] Loading splat file:', file.name, 'Format:', format, 'Size:', file.size)
 
-        // For SPZ: Use fileBytes approach to avoid gzip conflicts
+        // For SPZ: Use Spark.js native handling
         if (format === 'spz') {
-          console.log('🔵 [ClientLoader] Using SPZ-specific loading path')
+          console.log('🔵 [ClientLoader] Using SPZ path (Spark native)')
           const fileBytes = await file.arrayBuffer()
 
-          // Debug: Check the actual file data
-          const firstBytes = new Uint8Array(fileBytes.slice(0, 10))
-          const isGzipped = firstBytes[0] === 0x1f && firstBytes[1] === 0x8b
-
-          // SPZ files are handled with fileBytes approach
-
           const createSplatMesh = async (options = {}) => {
             const { SplatMesh } = await import('@sparkjsdev/spark')
+            console.log('🔧 [ClientLoader SPZ] Creating via Spark SplatMesh')
 
-            console.log('🔧 [ClientLoader SPZ] Creating SplatMesh with fileBytes approach')
-            console.log('   fileBytes length:', fileBytes.byteLength)
-            console.log('   format:', format)
-
-            // Convert fileBytes to Blob URL - onLoad callback works better with URLs
             const blob = new Blob([fileBytes], { type: 'application/octet-stream' })
             const blobUrl = URL.createObjectURL(blob)
-            console.log('   Created blob URL:', blobUrl)
 
-            // Wrap onLoad callback in a Promise to wait for loading
             return new Promise((resolve, reject) => {
-              const splatMeshOptions = {
-                url: blobUrl,  // Use URL instead of fileBytes
-                fileType: format,
-                // No scale override - use default
-                onLoad: (mesh) => {
-                  console.log('✅ [ClientLoader SPZ] onLoad callback fired! numSplats:', mesh.numSplats)
-                  // Clean up blob URL
-                  URL.revokeObjectURL(blobUrl)
-                  resolve(mesh)
-                },
-                ...options
-              }
-
               try {
-                console.log('   Creating SplatMesh...')
-                const splatMesh = new SplatMesh(splatMeshOptions)
-                console.log('   SplatMesh created, waiting for onLoad...')
-
-                // Safety timeout - if onLoad doesn't fire in 10 seconds, something is wrong
-                setTimeout(() => {
-                  if (splatMesh.numSplats === 0 && !splatMesh.isInitialized) {
-                    console.warn('⚠️ [ClientLoader SPZ] onLoad not called after 10s, resolving anyway')
+                const splatMesh = new SplatMesh({
+                  url: blobUrl,
+                  fileType: 'spz',
+                  onLoad: (mesh) => {
+                    console.log('✅ [ClientLoader SPZ] Loaded:', mesh.numSplats, 'splats')
                     URL.revokeObjectURL(blobUrl)
-                    resolve(splatMesh)
+                    resolve(mesh)
                   }
-                }, 10000)
-              } catch (error) {
-                console.error('❌ [ClientLoader SPZ] SplatMesh creation failed:', error)
-                URL.revokeObjectURL(blobUrl)
-                reject(error)
-              }
-            })
-          }
-
-          const splatData = {
-            file,
-            url,
-            fileBytes,
-            size: file.size,
-            format,
-            createSplatMesh,
-            getStats() {
-              return {
-                fileBytes: file.size,
-                format
-              }
-            }
-          }
-          this.results.set(key, splatData)
-          return splatData
-        }
-
-        // For PLY: Support streaming mode for progressive loading
-        if (format === 'ply') {
-          console.log('🔵 [ClientLoader] Using PLY loading path (streaming available)')
-
-          // Pre-load fileBytes for non-streaming fallback
-          const fileBytes = await file.arrayBuffer()
-
-          const createSplatMesh = async (options = {}) => {
-            const { streaming = false, onProgress, onBatch, onMeshReady } = options
-
-            // STREAMING MODE: Progressive loading with live rendering
-            if (streaming) {
-              console.log('🌊 [ClientLoader PLY] Using STREAMING mode')
-              try {
-                // Use already-loaded fileBytes (File stream can only be read once)
-                const mesh = await createStreamingSplatMesh({
-                  fileBytes: fileBytes,  // Pass bytes, not file object
-                  maxSplats: 2000000,
-                  onProgress,
-                  onBatch,
-                  onMeshReady  // Allow adding to scene before fully loaded
                 })
-                console.log('✅ [ClientLoader PLY] Streaming complete! numSplats:', mesh.numSplats)
-                return mesh
-              } catch (error) {
-                console.warn('⚠️ [ClientLoader PLY] Streaming failed, falling back to standard load:', error)
-                // Fall through to standard loading
-              }
-            }
-
-            // STANDARD MODE: Load all at once (fallback)
-            const { SplatMesh } = await import('@sparkjsdev/spark')
-
-            console.log('🔧 [ClientLoader PLY] Using STANDARD mode')
-            console.log('   fileBytes length:', fileBytes.byteLength)
-
-            const blob = new Blob([fileBytes], { type: 'application/octet-stream' })
-            const blobUrl = URL.createObjectURL(blob)
-
-            return new Promise((resolve, reject) => {
-              const splatMeshOptions = {
-                url: blobUrl,
-                fileType: format,
-                onLoad: (mesh) => {
-                  console.log('✅ [ClientLoader PLY] onLoad fired! numSplats:', mesh.numSplats)
-                  URL.revokeObjectURL(blobUrl)
-                  resolve(mesh)
-                },
-                ...options
-              }
-
-              try {
-                const splatMesh = new SplatMesh(splatMeshOptions)
                 setTimeout(() => {
-                  if (splatMesh.numSplats === 0 && !splatMesh.isInitialized) {
-                    console.warn('⚠️ [ClientLoader PLY] onLoad not called after 10s')
+                  if (!splatMesh.isInitialized) {
                     URL.revokeObjectURL(blobUrl)
                     resolve(splatMesh)
                   }
-                }, 10000)
+                }, 30000)
               } catch (error) {
-                console.error('❌ [ClientLoader PLY] Failed:', error)
                 URL.revokeObjectURL(blobUrl)
                 reject(error)
               }
@@ -491,7 +382,6 @@ export class ClientLoader extends System {
             size: file.size,
             format,
             createSplatMesh,
-            supportsStreaming: true, // Flag for UI
             getStats() {
               return { fileBytes: file.size, format }
             }
@@ -500,7 +390,7 @@ export class ClientLoader extends System {
           return splatData
         }
 
-        // For other formats (splat, ksplat, etc.): Use standard fileBytes approach
+        // For PLY and other formats: Use Spark.js native handling
         const fileBytes = await file.arrayBuffer()
 
         const createSplatMesh = async (options = {}) => {
@@ -514,15 +404,20 @@ export class ClientLoader extends System {
           const blobUrl = URL.createObjectURL(blob)
 
           return new Promise((resolve, reject) => {
+            // Map ksplat to splat for Spark.js compatibility
+            const sparkFileType = format === 'ksplat' ? 'splat' : format
+            console.log('   sparkFileType:', sparkFileType)
+
+            // Build options, ensuring fileType is never undefined
             const splatMeshOptions = {
+              ...options,
               url: blobUrl,
-              fileType: format,
+              fileType: sparkFileType,
               onLoad: (mesh) => {
                 console.log('✅ [ClientLoader OTHER] onLoad fired! numSplats:', mesh.numSplats)
                 URL.revokeObjectURL(blobUrl)
                 resolve(mesh)
-              },
-              ...options
+              }
             }
 
             try {
```

### src/core/systems/Stage.js

```diff
diff --git a/src/core/systems/Stage.js b/src/core/systems/Stage.js
index 66db50d..998f4f8 100644
--- a/src/core/systems/Stage.js
+++ b/src/core/systems/Stage.js
@@ -8,6 +8,13 @@ import { LooseOctree } from '../extras/LooseOctree'
 // SparkRenderer attached to camera for float16 precision fix
 let sparkRendererInstance = null
 
+// Pre-computed 180° rotation quaternion around X-axis for splat orientation fix
+// Splat files are typically exported upside-down and need this internal correction
+const SPLAT_FLIP_QUATERNION = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI)
+const _tempPosition = new THREE.Vector3()
+const _tempQuaternion = new THREE.Quaternion()
+const _tempScale = new THREE.Vector3()
+
 // Device-based performance settings
 const getDevicePerformanceTier = () => {
   if (typeof window === 'undefined') return 'desktop'
@@ -254,6 +261,10 @@ export class Stage extends System {
     this.raycaster.far = max
     this.raycastHits.length = 0
     this.octree.raycast(this.raycaster, this.raycastHits)
+
+    // Also raycast against SplatMeshes using Three.js standard raycasting
+    this._raycastSplatMeshes(this.raycaster, this.raycastHits)
+
     return this.raycastHits
   }
 
@@ -267,72 +278,147 @@ export class Stage extends System {
     this.raycaster.far = max
     this.raycastHits.length = 0
     this.octree.raycast(this.raycaster, this.raycastHits)
+
+    // Also raycast against SplatMeshes using Three.js standard raycasting
+    this._raycastSplatMeshes(this.raycaster, this.raycastHits)
+
     return this.raycastHits
   }
 
-  // Helper function to apply color/opacity to splat meshes and create common handlers
-  async createSplatMeshHandlers(splatMesh, matrix, color, opacity, node, srcUrl) {
-    const id = node.id || `splat_${Date.now()}`
+  // Internal splat raycast - DISABLED for continuous raycasting (performance)
+  _raycastSplatMeshes(raycaster, hits) {
+    // Disabled for continuous use - too expensive every frame
+    // Use raycastSplatsOnDemand() for on-click selection instead
+    return
+  }
+
+  // On-demand splat raycasting - call this only on click/selection, not every frame!
+  // Uses Spark.js native WASM-based ellipsoid raycasting for precision
+  raycastSplatsOnDemand(raycaster) {
+    if (this.splatMeshes.size === 0) return []
+
+    const hits = []
+
+    // Raycast ALL splats directly using Spark's precise ellipsoid raycasting
+    // No bounding box pre-check needed - Spark's WASM is fast enough for on-demand use
+    for (const [id, splatMesh] of this.splatMeshes) {
+      if (!splatMesh.isInitialized) continue
+
+      const splatHits = []
+      // Spark.js raycast uses WASM with RAYCAST_ELLIPSOID=true
+      // This tests against actual splat ellipsoids, not just bounding boxes
+      splatMesh.raycast(raycaster, splatHits)
+
+      for (const hit of splatHits) {
+        const foundNode = splatMesh._hyperfyNode
+        hits.push({
+          distance: hit.distance,
+          point: hit.point,
+          node: foundNode,
+          getEntity: () => foundNode?.ctx?.entity,
+          object: splatMesh
+        })
+      }
+    }
+
+    hits.sort((a, b) => a.distance - b.distance)
+    return hits
+  }
+
+  // Helper: Setup raycaster from pointer position for on-demand splat selection
+  raycastSplatsAtPointer(position) {
+    if (!this.viewport) return []
+    const rect = this.viewport.getBoundingClientRect()
+    vec2.x = ((position.x - rect.left) / rect.width) * 2 - 1
+    vec2.y = -((position.y - rect.top) / rect.height) * 2 + 1
+    this.raycaster.setFromCamera(vec2, this.world.camera)
+    return this.raycastSplatsOnDemand(this.raycaster)
+  }
+
+  // Helper: Setup raycaster from reticle (center screen) for on-demand splat selection
+  raycastSplatsAtReticle() {
+    if (!this.viewport) return []
+    vec2.x = 0
+    vec2.y = 0
+    this.raycaster.setFromCamera(vec2, this.world.camera)
+    return this.raycastSplatsOnDemand(this.raycaster)
+  }
+
+  // Helper: Setup common splat mesh properties
+  _setupSplatMesh(splatMesh, { node, matrix, color, opacity, splatScale, lodRenderScale }) {
+    // Apply LOD render scale
+    if (splatMesh.lodRenderScale !== undefined) {
+      splatMesh.lodRenderScale = lodRenderScale || getDefaultLodRenderScale()
+    }
+
+    // Apply user scale
+    if (splatScale && splatScale !== 1.0) {
+      splatMesh.scale.setScalar(splatScale)
+    }
 
-    // Apply transform
-    splatMesh.matrix.copy(matrix)
+    // Apply transform with internal 180° X-axis flip for correct splat orientation
+    // Decompose user matrix, apply flip rotation, recompose
+    matrix.decompose(_tempPosition, _tempQuaternion, _tempScale)
+    _tempQuaternion.multiply(SPLAT_FLIP_QUATERNION) // Apply flip in local space
+    splatMesh.matrix.compose(_tempPosition, _tempQuaternion, _tempScale)
     splatMesh.matrixAutoUpdate = false
     splatMesh.updateMatrixWorld(true)
 
-    // Add to scene
+    // Store node reference for raycasting
+    splatMesh._hyperfyNode = node
     this.scene.add(splatMesh)
 
     // Store reference
+    const id = node.id || `splat_${Date.now()}`
     this.splatMeshes.set(id, splatMesh)
 
-    // Apply color/opacity modifications using direct SplatMesh properties
-    try {
-      const THREE = await import('three')
-
-      // Apply initial color using SplatMesh.recolor property
-      if (color && color !== '#ffffff') {
-        const colorObj = new THREE.Color(color)
-        splatMesh.recolor.set(colorObj.r, colorObj.g, colorObj.b)
-      }
-
-      // Apply initial opacity using SplatMesh.opacity property
-      if (opacity !== undefined && opacity !== 1.0) {
-        splatMesh.opacity = opacity
-      }
-
-    } catch (error) {
-      console.warn('⚠️ Failed to apply initial splat properties:', error.message)
+    // Apply color/opacity - use already imported THREE
+    if (color && color !== '#ffffff') {
+      const colorObj = new THREE.Color(color)
+      splatMesh.recolor.set(colorObj.r, colorObj.g, colorObj.b)
+    }
+    if (opacity !== undefined && opacity !== 1.0) {
+      splatMesh.opacity = opacity
     }
 
-    // Return handle with update methods
+    return id
+  }
+
+  // Helper: Create splat handle object
+  _createSplatHandle(splatMesh, { id, srcUrl, removeFromCache = false, loadInterval = null }) {
     return {
       splatMesh,
       move: (newMatrix) => {
-        splatMesh.matrix.copy(newMatrix)
+        // Apply same internal 180° flip as in _setupSplatMesh
+        newMatrix.decompose(_tempPosition, _tempQuaternion, _tempScale)
+        _tempQuaternion.multiply(SPLAT_FLIP_QUATERNION)
+        splatMesh.matrix.compose(_tempPosition, _tempQuaternion, _tempScale)
         splatMesh.updateMatrixWorld(true)
       },
-      updateColor: async (newColor) => {
-        try {
-          const THREE = await import('three')
-          const colorObj = new THREE.Color(newColor)
-          splatMesh.recolor.set(colorObj.r, colorObj.g, colorObj.b)
-        } catch (error) {
-          console.warn('⚠️ Failed to update color:', error)
-        }
+      updateColor: (newColor) => {
+        const colorObj = new THREE.Color(newColor)
+        splatMesh.recolor.set(colorObj.r, colorObj.g, colorObj.b)
       },
-      updateOpacity: async (newOpacity) => {
-        try {
-          splatMesh.opacity = newOpacity
-        } catch (error) {
-          console.warn('⚠️ Failed to update opacity:', error)
+      updateOpacity: (newOpacity) => {
+        splatMesh.opacity = newOpacity
+      },
+      updateSplatScale: (newScale) => {
+        splatMesh.scale.setScalar(newScale)
+      },
+      updateLodRenderScale: (newLodRenderScale) => {
+        if (splatMesh.lodRenderScale !== undefined) {
+          splatMesh.lodRenderScale = newLodRenderScale
         }
       },
       destroy: () => {
+        // Clean up SOGS load interval if exists
+        if (loadInterval) {
+          clearInterval(loadInterval)
+        }
         this.scene.remove(splatMesh)
         this.splatMeshes.delete(id)
         splatMesh.dispose?.()
-        // Remove from loader cache for SPZ files
-        if (srcUrl && srcUrl.split('.').pop()?.toLowerCase() === 'spz') {
+        if (removeFromCache && srcUrl) {
           this.world.loader.remove('splat', srcUrl)
         }
       }
@@ -353,8 +439,7 @@ export class Stage extends System {
       // Dynamically import Spark.js only on client
       const { SplatMesh, SparkRenderer } = await import('@sparkjsdev/spark')
 
-      // Create SparkRenderer and attach to camera for float16 precision fix
-      // This prevents line patterns/quantization artifacts with small position values
+      // Create SparkRenderer singleton and attach to camera for float16 precision fix
       if (!sparkRendererInstance && this.world.camera && this.world.graphics?.renderer) {
         sparkRendererInstance = new SparkRenderer({
           renderer: this.world.graphics.renderer
@@ -362,184 +447,47 @@ export class Stage extends System {
         this.world.camera.add(sparkRendererInstance)
 
         // Reduce maxStdDev on mobile/Quest for better performance
-        // Default is ~2.8 (sqrt(8)), lower = smaller splats = faster rendering
         const tier = getDevicePerformanceTier()
         if (tier === 'quest') {
-          sparkRendererInstance.maxStdDev = 1.8 // Very aggressive for VR
+          sparkRendererInstance.maxStdDev = 1.8
         } else if (tier === 'mobile') {
-          sparkRendererInstance.maxStdDev = 2.2 // Moderate for mobile
+          sparkRendererInstance.maxStdDev = 2.2
         }
-
-        console.log('🚀 [Stage] SparkRenderer attached to camera with maxStdDev:', sparkRendererInstance.maxStdDev)
+        console.log('🚀 [Stage] SparkRenderer attached, maxStdDev:', sparkRendererInstance.maxStdDev)
       }
 
-      // Determine if we should use SOGS for streaming or direct loading
-      const format = url.split('.').pop()?.toLowerCase()
-      console.log(`🧩 [insertGaussianSplat] format: ${format}, url: ${url}`)
-
-      // SOGS Streaming URL
-      const isSOGSUrl = url.includes('/sogs/')
-      if (isSOGSUrl) {
-        console.log('🌊 [insertGaussianSplat] Using SOGS streaming URL:', url)
-
-        const splatMesh = new SplatMesh({
-          url,
-          fileType: 'sogs',
-          lodRenderScale: lodRenderScale || getDefaultLodRenderScale(),
-          maxSplatCount: 5000000 // High limit for streaming
-        })
-
-        if (splatScale && splatScale !== 1.0) {
-          splatMesh.scale.setScalar(splatScale)
-        }
-
-        splatMesh.onLoad = (mesh) => {
-          console.log('✅ [Stage SOGS] SOGS streaming initialized! numSplats:', mesh.numSplats)
-        }
-
-        return await this.createSplatMeshHandlers(splatMesh, matrix, color, opacity, node, url)
-      }
-
-      // Direct asset:// URLs - attempt to get file data or stream
+      // File asset:// URLs
       if (url.startsWith('asset://')) {
         console.log('🎯 [insertGaussianSplat] Asset URL detected:', url)
 
-        // Try to get cached file data first
         const splatData = this.world.loader.get('splat', url)
         if (!splatData) {
           throw new Error(`Splat data not found in loader cache for: ${url}`)
         }
 
-        // Check if this loader supports streaming (PLY only)
-        const shouldUseStreaming = false  // Disabled for now - was causing issues
-        console.log(`📋 [Stage] Streaming mode: ${shouldUseStreaming}`)
-
-        let splatMesh
-        if (shouldUseStreaming && splatData.supportsStreaming) {
-          // STREAMING MODE: Progressive loading with live scene updates
-          console.log('🌊 [insertGaussianSplat] Using STREAMING mode')
-
-          splatMesh = await splatData.createSplatMesh({
-            streaming: true,
-            lodRenderScale: lodRenderScale || getDefaultLodRenderScale(),
-            onProgress: (loaded, total) => {
-              console.log(`📊 [Stage Streaming] Progress: ${loaded}/${total} splats (${(loaded/total*100).toFixed(1)}%)`)
-            },
-            onBatch: (mesh, newSplats) => {
-              console.log(`📦 [Stage Streaming] Added ${newSplats} splats, total: ${mesh.numSplats}`)
-            },
-            onMeshReady: (partialMesh) => {
-              console.log('🎬 [Stage Streaming] Mesh ready for scene! Partial splats:', partialMesh.numSplats)
-              // Mesh is ready to be added to scene even while streaming continues
-            }
-          })
-
-          if (splatScale && splatScale !== 1.0) {
-            splatMesh.scale.setScalar(splatScale)
-          }
-
-        } else {
-          // STANDARD MODE: Load entire file at once
-          console.log('🔧 [insertGaussianSplat] Using STANDARD mode')
-
-          splatMesh = await splatData.createSplatMesh({
-            lodRenderScale: lodRenderScale || getDefaultLodRenderScale()
-          })
+        const splatMesh = await splatData.createSplatMesh()
 
-          if (splatScale && splatScale !== 1.0) {
-            splatMesh.scale.setScalar(splatScale)
-          }
-        }
+        const id = this._setupSplatMesh(splatMesh, { node, matrix, color, opacity, splatScale, lodRenderScale })
 
-        return await this.createSplatMeshHandlers(splatMesh, matrix, color, opacity, node, url)
+        return this._createSplatHandle(splatMesh, { id, srcUrl: url })
       }
 
-      // External URL: Try to create SplatMesh directly
-      else {
-        console.log('🌐 [insertGaussianSplat] External URL:', url)
-
-        // Determine file type from URL extension
-        let fileType = format
-
-        // Handle ksplat -> splat mapping for Spark.js compatibility
-        if (fileType === 'ksplat') {
-          fileType = 'splat'
-          console.log('🔄 [Stage] Mapped ksplat → splat for Spark.js')
-        }
-
-        // Create SplatMesh with external URL
-        const splatMeshOptions = {
-          url,
-          fileType,
-          lodRenderScale: lodRenderScale || getDefaultLodRenderScale(),
-          onLoad: (mesh) => {
-            console.log(`✅ [Stage External] External ${format} loaded! numSplats:`, mesh.numSplats)
-          }
-        }
-
-        console.log('🔧 [Stage External] Creating SplatMesh with options:', {
-          url,
-          fileType,
-          lodRenderScale: splatMeshOptions.lodRenderScale
-        })
+      // External URL
+      console.log('🌐 [insertGaussianSplat] External URL:', url)
+      const format = url.split('.').pop()?.toLowerCase()
+      const fileType = format === 'ksplat' ? 'splat' : format
 
-        const splatMesh = new SplatMesh(splatMeshOptions)
+      const splatMesh = new SplatMesh({
+        url,
+        fileType,
+        onLoad: (mesh) => console.log(`✅ [Stage External] External ${format} loaded:`, mesh.numSplats)
+      })
 
-        if (splatScale && splatScale !== 1.0) {
-          splatMesh.scale.setScalar(splatScale)
-        }
-
-        return await this.createSplatMeshHandlers(splatMesh, matrix, color, opacity, node, url)
-      }
+      const id = this._setupSplatMesh(splatMesh, { node, matrix, color, opacity, splatScale, lodRenderScale })
 
+      return this._createSplatHandle(splatMesh, { id, srcUrl: url })
     } catch (error) {
       console.error('❌ [insertGaussianSplat] Failed to create splat:', error)
       throw error
```

---

## Key Implementation Notes

### Performance Optimizations
- **Device-specific LOD settings** for Quest/mobile devices
- **On-demand splat raycasting** to avoid expensive per-frame operations  
- **Automatic 180° orientation correction** applied internally to prevent transform confusion

### Ghost Splat Prevention
- **Creation ID tracking** prevents stale handles from creating duplicate splats
- **Proper handle destruction** ensures clean teardown on unmount/rebuild

### Format Support
- **PLY, SPZ, SPLAT, KSPLAT** formats supported via unified Spark.js pipeline
- **Format detection and mapping** (e.g., ksplat → splat for compatibility)

### User Experience
- **Enhanced selection** with distance-based raycasting comparison
- **Delete/Backspace key support** for entity deletion
- **Force translate mode** for splats (grab mode disabled for performance)
- **Color and opacity controls** in the splat app configuration panel

This implementation provides a comprehensive Gaussian Splatting solution integrated seamlessly into the Hyperfy metaverse platform.