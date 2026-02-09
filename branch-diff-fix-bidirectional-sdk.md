# Diff: blended-anim vs fix/bidirectional-sdk

Command used:

```bash
git diff fix/bidirectional-sdk..HEAD
```

```diff
diff --git a/src/core/entities/PlayerLocal.js b/src/core/entities/PlayerLocal.js
index b425a0d..252120f 100644
--- a/src/core/entities/PlayerLocal.js
+++ b/src/core/entities/PlayerLocal.js
@@ -998,17 +998,20 @@ export class PlayerLocal extends Entity {
 
     // apply emote
     let emote
+    let emoteUpperBody
     if (this.data.effect?.emote) {
       emote = this.data.effect.emote
+      emoteUpperBody = this.data.effect.upperBody || false
     }
     if (this.emote !== emote) {
       this.emote = emote
+      this.emoteUpperBody = emoteUpperBody
     }
-    this.avatar?.setEmote(this.emote)
+    this.avatar?.setEmote(this.emote, this.emoteUpperBody)
 
     // get locomotion mode
     let mode
-    if (this.data.effect?.emote) {
+    if (this.data.effect?.emote && !this.data.effect?.upperBody) {
       // emote = this.data.effect.emote
     } else if (this.flying) {
       mode = Modes.FLY
@@ -1092,6 +1095,7 @@ export class PlayerLocal extends Entity {
       }
       if (this.lastState.e !== this.emote) {
         data.e = this.emote
+        data.ub = this.emoteUpperBody
         this.lastState.e = this.emote
         hasChanges = true
       }
@@ -1136,7 +1140,7 @@ export class PlayerLocal extends Entity {
       if (!this.firstPerson) {
         const forward = v1.copy(FORWARD).applyQuaternion(this.cam.quaternion)
         const right = v2.crossVectors(forward, UP).normalize()
-        this.cam.position.add(right.multiplyScalar(0.3))
+        this.cam.position.add(right.multiplyScalar(0.35))
       }
     }
     if (xr) {
 diff --git a/src/core/entities/PlayerRemote.js b/src/core/entities/PlayerRemote.js
index 9146390..66a38ff 100644
--- a/src/core/entities/PlayerRemote.js
+++ b/src/core/entities/PlayerRemote.js
@@ -140,7 +140,7 @@ export class PlayerRemote extends Entity {
       this.position.update(delta)
       this.quaternion.update(delta)
     }
-    this.avatar?.setEmote(this.data.emote)
+    this.avatar?.setEmote(this.data.emote, this.data.emoteUpperBody)
     this.avatar?.instance?.setLocomotion(this.mode, this.axis, this.gaze)
   }
 
@@ -207,6 +207,7 @@ export class PlayerRemote extends Entity {
     }
     if (data.hasOwnProperty('e')) {
       this.data.emote = data.e
+      this.data.emoteUpperBody = data.ub || false
     }
     if (data.hasOwnProperty('ef')) {
       this.setEffect(data.ef)
 diff --git a/src/core/extras/createEmoteFactory.js b/src/core/extras/createEmoteFactory.js
index 22f1722..18be336 100644
--- a/src/core/extras/createEmoteFactory.js
+++ b/src/core/extras/createEmoteFactory.js
@@ -1,5 +1,17 @@
 import * as THREE from 'three'
 
+const LOWER_BODY_BONES = new Set([
+  'hips',
+  'leftUpperLeg',
+  'leftLowerLeg',
+  'leftFoot',
+  'leftToes',
+  'rightUpperLeg',
+  'rightLowerLeg',
+  'rightFoot',
+  'rightToes',
+])
+
 const q1 = new THREE.Quaternion()
 const restRotationInverse = new THREE.Quaternion()
 const parentRestWorldRotation = new THREE.Quaternion()
@@ -82,7 +94,7 @@ export function createEmoteFactory(glb, url) {
   // console.log(clip)
 
   return {
-    toClip({ rootToHips, version, getBoneName }) {
+    toClip({ rootToHips, version, getBoneName, upperBody, lowerBody }) {
       // we're going to resize animation to match vrm height
       const height = rootToHips
 
@@ -92,6 +104,8 @@ export function createEmoteFactory(glb, url) {
         const trackSplitted = track.name.split('.')
         const ogBoneName = trackSplitted[0]
         const vrmBoneName = normalizedBoneNames[ogBoneName]
+        if (upperBody && LOWER_BODY_BONES.has(vrmBoneName)) return
+        if (lowerBody && !LOWER_BODY_BONES.has(vrmBoneName)) return
         // TODO: use vrm.bones[name] not getBoneNode
         const vrmNodeName = getBoneName(vrmBoneName)
 
 diff --git a/src/core/extras/createPlayerProxy.js b/src/core/extras/createPlayerProxy.js
index 51a9ef7..0412fdd 100644
--- a/src/core/extras/createPlayerProxy.js
+++ b/src/core/extras/createPlayerProxy.js
@@ -114,6 +114,7 @@ export function createPlayerProxy(entity, player) {
       if (opts.freeze) effect.freeze = opts.freeze
       if (opts.turn) effect.turn = opts.turn
       if (opts.duration) effect.duration = opts.duration
+      if (opts.upperBody) effect.upperBody = opts.upperBody
       if (opts.cancellable) {
         effect.cancellable = opts.cancellable
         delete effect.freeze // overrides
 diff --git a/src/core/extras/createVRMFactory.js b/src/core/extras/createVRMFactory.js
index cf5aaa6..9a8897e 100644
--- a/src/core/extras/createVRMFactory.js
+++ b/src/core/extras/createVRMFactory.js
@@ -232,40 +232,45 @@ export function createVRMFactory(glb, setupMaterial) {
       // }
     }
     let currentEmote
-    const setEmote = url => {
+    const setEmote = (url, upperBody) => {
       if (currentEmote?.url === url) return
       if (currentEmote) {
         currentEmote.action?.fadeOut(0.15)
         currentEmote = null
+        setLocoLower(false)
       }
       if (!url) return
       const opts = getQueryParams(url)
       const loop = opts.l !== '0'
       const speed = parseFloat(opts.s || 1)
       const gaze = opts.g == '1'
+      const cacheKey = upperBody ? url + '__upper' : url
 
-      if (emotes[url]) {
-        currentEmote = emotes[url]
+      if (emotes[cacheKey]) {
+        currentEmote = emotes[cacheKey]
         if (currentEmote.action) {
           currentEmote.action.clampWhenFinished = !loop
           currentEmote.action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce)
           currentEmote.action.reset().fadeIn(0.15).play()
-          clearLocomotion()
+          if (upperBody) setLocoLower(true)
+          else clearLocomotion()
         }
       } else {
         const emote = {
           url,
+          upperBody: !!upperBody,
           loading: true,
           action: null,
           gaze,
         }
-        emotes[url] = emote
+        emotes[cacheKey] = emote
         currentEmote = emote
         hooks.loader.load('emote', url).then(emo => {
           const clip = emo.toClip({
             rootToHips,
             version,
             getBoneName,
+            upperBody,
           })
           const action = mixer.clipAction(clip)
           action.timeScale = speed
@@ -275,7 +280,8 @@ export function createVRMFactory(glb, setupMaterial) {
             action.clampWhenFinished = !loop
             action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce)
             action.play()
-            clearLocomotion()
+            if (upperBody) setLocoLower(true)
+            else clearLocomotion()
           }
         })
       }
@@ -307,7 +313,7 @@ export function createVRMFactory(glb, setupMaterial) {
         mixer.update(elapsed)
         skeleton.bones.forEach(bone => bone.updateMatrixWorld())
         skeleton.update = THREE.Skeleton.prototype.update
-        if (!currentEmote) {
+        if (!currentEmote || currentEmote.upperBody) {
           updateLocomotion(delta)
         }
         if (loco.gazeDir && distance < MAX_GAZE_DISTANCE && (currentEmote ? currentEmote.gaze : true)) {
@@ -479,6 +485,29 @@ export function createVRMFactory(glb, setupMaterial) {
     //   console.log('hi2')
     // })
 
+    let locoLower = false
+    function setLocoLower(enabled) {
+      if (locoLower === enabled) return
+      locoLower = enabled
+      for (const key in poses) {
+        const pose = poses[key]
+        if (!pose.action || !pose.lowerAction) continue
+        if (enabled) {
+          // crossfade from full-body to lower-body-only
+          pose.lowerAction.weight = pose.action.weight
+          pose.lowerAction.time = pose.action.time
+          pose.lowerAction.reset().fadeIn(0.15).play()
+          pose.action.fadeOut(0.15)
+        } else {
+          // crossfade from lower-body-only to full-body
+          pose.action.weight = pose.lowerAction.weight
+          pose.action.time = pose.lowerAction.time
+          pose.action.reset().fadeIn(0.15).play()
+          pose.lowerAction.fadeOut(0.15)
+        }
+      }
+    }
+
     const poses = {}
     function addPose(key, url) {
       const opts = getQueryParams(url)
@@ -487,14 +516,16 @@ export function createVRMFactory(glb, setupMaterial) {
         loading: true,
         active: false,
         action: null,
+        lowerAction: null,
         weight: 0,
         target: 0,
         setWeight: value => {
           pose.weight = value
-          if (pose.action) {
-            pose.action.weight = value
+          const active = locoLower ? pose.lowerAction : pose.action
+          if (active) {
+            active.weight = value
             if (!pose.active) {
-              pose.action.reset().fadeIn(0.15).play()
+              active.reset().fadeIn(0.15).play()
               pose.active = true
             }
           }
@@ -502,6 +533,7 @@ export function createVRMFactory(glb, setupMaterial) {
         fadeOut: () => {
           pose.weight = 0
           pose.action?.fadeOut(0.15)
+          pose.lowerAction?.fadeOut(0.15)
           pose.active = false
         },
       }
@@ -515,6 +547,18 @@ export function createVRMFactory(glb, setupMaterial) {
         pose.action.timeScale = speed
         pose.action.weight = pose.weight
         pose.action.play()
+
+        const lowerClip = emo.toClip({
+          rootToHips,
+          version,
+          getBoneName,
+          lowerBody: true,
+        })
+        lowerClip.name = clip.name + '_lower'
+        pose.lowerAction = mixer.clipAction(lowerClip)
+        pose.lowerAction.timeScale = speed
+        pose.lowerAction.weight = 0
+        pose.lowerAction.play()
       })
       poses[key] = pose
     }
 diff --git a/src/core/nodes/Avatar.js b/src/core/nodes/Avatar.js
index 4949c72..8dd37ab 100644
--- a/src/core/nodes/Avatar.js
+++ b/src/core/nodes/Avatar.js
@@ -37,7 +37,7 @@ export class Avatar extends Node {
     }
     if (this.factory) {
       this.instance = this.factory.create(this.matrixWorld, this.hooks, this)
-      this.instance.setEmote(this._emote)
+      this.instance.setEmote(this._emote, this._emoteUpperBody)
       this.instance.setVisible(this._visible)
       if (this._disableRateCheck) {
@@ -97,7 +97,7 @@ export class Avatar extends Node {
     }
     if (this._emote === value) return
     this._emote = value
-    this.instance?.setEmote(value)
+    this.instance?.setEmote(value, this._emoteUpperBody)
   }
 
   get visible() {
@@ -145,7 +145,8 @@ export class Avatar extends Node {
     this.instance?.setLocomotion(mode, axis, gazeDir)
   }
 
-  setEmote(url) {
+  setEmote(url, upperBody) {
+    this._emoteUpperBody = upperBody || false
     // DEPRECATED: use .emote
     this.emote = url
   }
```
