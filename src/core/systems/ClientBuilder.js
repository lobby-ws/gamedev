import moment from 'moment'
import * as THREE from '../extras/three'
import { cloneDeep, isBoolean, merge } from 'lodash-es'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'

import { System } from './System'

import { hashFile } from '../utils-client'
import { uuid } from '../utils'
import { ControlPriorities } from '../extras/ControlPriorities'
import { DEG2RAD, RAD2DEG } from '../extras/general'
import { createNode } from '../extras/createNode'
import { importApp } from '../extras/appTools'
import { buildScriptGroups, getScriptGroupMain } from '../extras/blueprintGroups'

const FORWARD = new THREE.Vector3(0, 0, -1)
const SNAP_DISTANCE = 1
const SNAP_DEGREES = 5
const PROJECT_SPEED = 10
const PROJECT_MIN = 3
const PROJECT_MIN_XR = 0.1
const PROJECT_MAX = 50

const v1 = new THREE.Vector3()
const v2 = new THREE.Vector3()
const q1 = new THREE.Quaternion()
const e1 = new THREE.Euler()

function splitBlueprintId(id) {
  const idx = typeof id === 'string' ? id.indexOf('__') : -1
  if (idx !== -1) {
    return { prefix: id.slice(0, idx + 2), base: id.slice(idx + 2) }
  }
  return { prefix: '', base: id || 'blueprint' }
}

function getNextBlueprintVariant(world, sourceBlueprint) {
  const sourceId = typeof sourceBlueprint === 'string' ? sourceBlueprint : sourceBlueprint?.id
  const { prefix, base } = splitBlueprintId(sourceId)
  let safeBase = base || 'blueprint'
  if (sourceBlueprint && typeof sourceBlueprint === 'object') {
    const scriptKey = typeof sourceBlueprint.script === 'string' ? sourceBlueprint.script.trim() : ''
    if (scriptKey) {
      const groups = buildScriptGroups(world?.blueprints?.items)
      const main = getScriptGroupMain(groups, sourceBlueprint)
      const mainName = typeof main?.name === 'string' && main.name.trim() ? main.name.trim() : main?.id
      if (mainName) {
        const { base: mainBase } = splitBlueprintId(mainName)
        safeBase = mainBase || mainName
      }
    }
  }
  for (let n = 2; n < 10000; n += 1) {
    const candidateId = `${prefix}${safeBase}_${n}`
    if (!world.blueprints.get(candidateId)) {
      return { id: candidateId, name: `${safeBase}_${n}` }
    }
  }
  const fallback = uuid()
  return { id: `${prefix}${safeBase}_${fallback}`, name: `${safeBase}_${fallback}` }
}

const modeLabels = {
  grab: 'Grab',
  translate: 'Translate',
  rotate: 'Rotate',
  scale: 'Scale',
}

const SCRIPT_BLUEPRINT_FIELDS = new Set([
  'script',
  'scriptEntry',
  'scriptFiles',
  'scriptFormat',
  'scriptRef',
])

const DEFAULT_MODULE_SCRIPT_ENTRY = 'index.js'
const DEFAULT_MODULE_SCRIPT_SOURCE = `export default (world, app, fetch, props, setTimeout) => {

}
`

function hasScriptFields(data) {
  if (!data || typeof data !== 'object') return false
  for (const field of SCRIPT_BLUEPRINT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(data, field)) continue
    if (field === 'script' && data.script === '') continue
    return true
  }
  return false
}

function normalizeScope(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

/**
 * Builder System
 *
 * - runs on the client
 * - listens for files being drag and dropped onto the window and handles them
 * - handles build mode
 *
 */
export class ClientBuilder extends System {
  constructor(world) {
    super(world)
    this.enabled = false
    this.beam = new THREE.Object3D()
    this.selected = null
    this.mode = 'grab'
    this.localSpace = false
    this.target = new THREE.Object3D()
    this.target.rotation.reorder('YXZ')
    this.lastMoveSendTime = 0

    this.createXRMenu()
    this.xrLaser = null
    this.xrMenuTimer = 0

    this.undos = []

    this.dropTarget = null
    this.file = null
  }

  async init({ viewport }) {
    this.viewport = viewport
    this.viewport.addEventListener('dragover', this.onDragOver)
    this.viewport.addEventListener('dragenter', this.onDragEnter)
    this.viewport.addEventListener('dragleave', this.onDragLeave)
    this.viewport.addEventListener('drop', this.onDrop)
    this.world.on('player', this.checkLocalPlayer)
    this.world.settings.on('change', this.checkLocalPlayer)
  }

  start() {
    this.control = this.world.controls.bind({ priority: ControlPriorities.BUILDER })
    this.control.mouseLeft.onPress = () => {
      // pointer lock requires user-gesture in safari
      // so this can't be done during update cycle
      if (!this.control.pointer.locked) {
        this.control.pointer.lock()
        this.justPointerLocked = true
        return true // capture
      }
    }
    this.control.backquote.onPress = () => {
      if (this.control.pointer.locked) {
        this.control.pointer.unlock()
      } else {
        this.control.pointer.lock()
      }
    }
    this.updateActions()
  }

  checkLocalPlayer = () => {
    if (this.enabled && !this.canBuild()) {
      // builder revoked
      this.select(null)
      this.enabled = false
      this.world.emit('build-mode', false)
    }
    this.updateActions()
  }

  canBuild() {
    return this.world.entities.player?.isBuilder()
  }

  getAdminGateMessage() {
    const admin = this.world.admin
    if (!admin) return 'Admin connection unavailable.'
    if (admin.requireCode && !admin.code) return 'Admin code required. Use /admin <code>.'
    if (admin.error === 'invalid_code') return 'Invalid admin code. Use /admin <code>.'
    if (admin.error === 'connection_error') return 'Admin connection failed.'
    if (admin.error === 'missing_code') return 'Admin code required. Use /admin <code>.'
    return 'Admin connection required. Use /admin <code>.'
  }

  ensureAdminReady(actionLabel) {
    const admin = this.world.admin
    if (!admin?.authenticated) {
      const msg = this.getAdminGateMessage()
      this.world.emit('toast', actionLabel ? `${actionLabel}: ${msg}` : msg)
      return false
    }
    return true
  }

  handleAdminError(err, fallbackMessage) {
    const code = err?.code || err?.error || err?.message
    if (code === 'builder_required') {
      this.world.emit('toast', 'Builder access required.')
      return
    }
    if (code === 'deploy_required') {
      this.world.emit('toast', 'Deploy code required.')
      return
    }
    if (code === 'deploy_lock_required') {
      this.world.emit('toast', 'Deploy lock required.')
      return
    }
    if (code === 'scope_unknown') {
      this.world.emit('toast', 'Scope metadata missing for deploy operation.')
      return
    }
    if (code === 'scope_mismatch' || code === 'multi_scope_not_supported') {
      this.world.emit('toast', 'Scope metadata mismatch for deploy operation.')
      return
    }
    if (code === 'locked' || code === 'deploy_locked') {
      const owner = err?.lock?.owner
      this.world.emit('toast', owner ? `Deploy locked by ${owner}.` : 'Deploy locked by another session.')
      return
    }
    if (code === 'ai_request_pending') {
      this.world.emit('toast', 'AI request already in progress for this script.')
      return
    }
    if (code === 'admin_url_missing') {
      this.world.emit('toast', 'Admin connection unavailable.')
      return
    }
    if (code === 'admin_required' || code === 'admin_code_missing') {
      this.world.emit('toast', 'Admin code required.')
      return
    }
    if (code === 'upload_failed') {
      this.world.emit('toast', 'Upload failed.')
      return
    }
    if (fallbackMessage) {
      this.world.emit('toast', fallbackMessage)
      return
    }
    this.world.emit('toast', 'Action failed.')
  }

  updateActions() {
    const actions = []
    if (!this.enabled) {
      if (this.canBuild()) {
        // actions.push({ type: 'tab', label: 'Build Mode' })
      }
    }
    if (this.enabled && !this.selected) {
      actions.push({ type: 'mouseLeft', label: modeLabels[this.mode] })
      actions.push({ type: 'mouseRight', label: 'Inspect' })
      actions.push({ type: 'custom', btn: '1234', label: 'Grab / Translate / Rotate / Scale' })
      actions.push({ type: 'keyR', label: 'Duplicate' })
      actions.push({ type: 'keyP', label: 'Pin' })
      actions.push({ type: 'keyX', label: 'Destroy' })
      actions.push({ type: 'space', label: 'Jump / Fly (Double-Tap)' })
      // actions.push({ type: 'tab', label: 'Exit Build Mode' })
    }
    if (this.enabled && this.selected && this.mode === 'grab') {
      actions.push({ type: 'mouseLeft', label: 'Place' })
      actions.push({ type: 'mouseWheel', label: 'Rotate' })
      actions.push({ type: 'mouseRight', label: 'Inspect' })
      actions.push({ type: 'custom', btn: '1234', label: 'Grab / Translate / Rotate / Scale' })
      actions.push({ type: 'keyF', label: 'Push' })
      actions.push({ type: 'keyC', label: 'Pull' })
      actions.push({ type: 'keyX', label: 'Destroy' })
      actions.push({ type: 'controlLeft', label: 'No Snap (Hold)' })
      actions.push({ type: 'space', label: 'Jump / Fly (Double-Tap)' })
      // actions.push({ type: 'tab', label: 'Exit Build Mode' })
    }
    if (
      this.enabled &&
      this.selected &&
      (this.mode === 'translate' || this.mode === 'rotate' || this.mode === 'scale')
    ) {
      actions.push({ type: 'mouseLeft', label: 'Select / Transform' })
      actions.push({ type: 'mouseRight', label: 'Inspect' })
      actions.push({ type: 'custom', btn: '1234', label: 'Grab / Translate / Rotate / Scale' })
      actions.push({ type: 'keyT', label: this.localSpace ? 'World Space' : 'Local Space' })
      actions.push({ type: 'keyX', label: 'Destroy' })
      actions.push({ type: 'controlLeft', label: 'No Snap (Hold)' })
      actions.push({ type: 'space', label: 'Jump / Fly (Double-Tap)' })
      // actions.push({ type: 'tab', label: 'Exit Build Mode' })
    }
    this.control.setActions(actions)
  }

  async forkTemplateFromEntity(entity, actionLabel = 'Template fork', overrides) {
    const baseProps =
      entity.blueprint.props && typeof entity.blueprint.props === 'object' && !Array.isArray(entity.blueprint.props)
        ? entity.blueprint.props
        : {}
    const instanceProps =
      entity.data.props && typeof entity.data.props === 'object' && !Array.isArray(entity.data.props)
        ? entity.data.props
        : {}
    const mergedProps = merge({}, baseProps, instanceProps)
    return this.forkTemplateFromBlueprint(entity.blueprint, actionLabel, mergedProps, overrides)
  }

  async forkTemplateFromBlueprint(sourceBlueprint, actionLabel = 'Template fork', mergedProps, overrides) {
    if (!this.ensureAdminReady(actionLabel)) return null
    const sourceScope = normalizeScope(sourceBlueprint.scope)
    const sourceId =
      typeof sourceBlueprint?.id === 'string' && sourceBlueprint.id.trim() ? sourceBlueprint.id.trim() : null
    const sourceInWorld = sourceId ? this.world.blueprints.get(sourceId) : null
    const sourceScriptRef =
      typeof sourceBlueprint.scriptRef === 'string' && sourceBlueprint.scriptRef.trim()
        ? sourceBlueprint.scriptRef.trim()
        : null
    const scriptRootId = sourceScriptRef || (sourceInWorld ? sourceId : null)
    const scriptRoot =
      (scriptRootId && this.world.blueprints.get(scriptRootId)) || sourceInWorld || sourceBlueprint
    const shouldUseScriptRef = !!(scriptRootId && this.world.blueprints.get(scriptRootId))
    const sharedScript = typeof scriptRoot?.script === 'string' ? scriptRoot.script : sourceBlueprint.script
    const baseProps =
      sourceBlueprint.props &&
      typeof sourceBlueprint.props === 'object' &&
      !Array.isArray(sourceBlueprint.props)
        ? sourceBlueprint.props
        : {}
    const props =
      mergedProps && typeof mergedProps === 'object' && !Array.isArray(mergedProps) ? mergedProps : baseProps
    const nextBlueprint = getNextBlueprintVariant(this.world, sourceBlueprint)
    const blueprint = {
      id: nextBlueprint.id,
      version: 0,
      name: nextBlueprint.name,
      image: sourceBlueprint.image,
      author: sourceBlueprint.author,
      url: sourceBlueprint.url,
      desc: sourceBlueprint.desc,
      model: sourceBlueprint.model,
      script: sharedScript,
      scriptEntry: shouldUseScriptRef ? null : scriptRoot?.scriptEntry ?? null,
      scriptFiles:
        shouldUseScriptRef || !scriptRoot?.scriptFiles || Array.isArray(scriptRoot.scriptFiles)
          ? null
          : cloneDeep(scriptRoot.scriptFiles),
      scriptFormat: shouldUseScriptRef ? null : scriptRoot?.scriptFormat ?? null,
      scriptRef: shouldUseScriptRef ? scriptRootId : null,
      scope: sourceScope,
      props: cloneDeep(props),
      preload: sourceBlueprint.preload,
      public: sourceBlueprint.public,
      locked: sourceBlueprint.locked,
      frozen: sourceBlueprint.frozen,
      unique: sourceBlueprint.unique,
      scene: sourceBlueprint.scene,
      disabled: sourceBlueprint.disabled,
    }
    if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
      const { id: _id, version: _version, ...rest } = overrides
      Object.assign(blueprint, rest)
    }
    if (hasScriptFields(blueprint) && !normalizeScope(blueprint.scope)) {
      blueprint.scope = blueprint.id
    }
    this.world.blueprints.add(blueprint)
    let lockToken
    let lockScope = null
    let releaseLock = false
    try {
      if (hasScriptFields(blueprint)) {
        lockScope = normalizeScope(blueprint.scope)
        if (!lockScope) {
          throw new Error('scope_unknown')
        }
        const admin = this.world.admin
        const currentScope = admin?.deployLockScope || 'global'
        if (admin?.deployLockToken && (currentScope === 'global' || currentScope === lockScope)) {
          lockToken = admin.deployLockToken
        } else {
          const result = await admin.acquireDeployLock({ owner: this.world.network.id, scope: lockScope })
          lockToken = result?.token || admin.deployLockToken
          releaseLock = !!lockToken
        }
      }
      await this.world.admin.blueprintAdd(blueprint, {
        ignoreNetworkId: this.world.network.id,
        lockToken,
        request: true,
      })
      return blueprint
    } catch (err) {
      this.world.blueprints.remove(blueprint.id)
      this.handleAdminError(err, `${actionLabel} failed.`)
      return null
    } finally {
      if (releaseLock && lockToken && this.world.admin?.releaseDeployLock) {
        try {
          await this.world.admin.releaseDeployLock(lockToken, lockScope)
        } catch (releaseErr) {
          console.error('failed to release deploy lock', releaseErr)
        }
      }
    }
  }

  update(delta) {
    const player = this.world.entities.player
    if (!player) return
    const xr = player.isXR
    // toggle build
    if (this.control.tab.pressed) {
      this.toggle()
    }
    // deselect if dead
    if (this.selected?.destroyed) {
      this.select(null)
    }
    // deselect if stolen
    if (this.selected && this.selected?.data.mover !== this.world.network.id) {
      this.select(null)
    }
    // non-xr if not in build mode, stop here
    if (!xr && !this.enabled) {
      return
    }
    // xr if not a builder, stop here
    if (xr && !this.canBuild()) {
      return
    }
    // xr and non-xr beam
    // in xr this is the laser when holding trigger
    // otherwise its the reticle when pointer locked
    if (xr) {
      if (this.control.xrLeftTrigger.value) {
        this.beam.xr = true
        this.beam.kind = 'xrLeft'
        this.beam.position.copy(this.control.xrLeftRayPose.position)
        this.beam.quaternion.copy(this.control.xrLeftRayPose.quaternion)
        this.beam.active = true
      } else if (this.control.xrRightTrigger.value) {
        this.beam.xr = true
        this.beam.kind = 'xrRight'
        this.beam.position.copy(this.control.xrRightRayPose.position)
        this.beam.quaternion.copy(this.control.xrRightRayPose.quaternion)
        this.beam.active = true
      } else {
        this.beam.xr = false
        // this.beam.kind = null
        this.beam.active = false
      }
    } else if (this.control.pointer.locked) {
      this.beam.xr = false
      this.beam.kind = 'reticle'
      this.beam.position.copy(this.world.rig.position)
      this.beam.quaternion.copy(this.world.rig.quaternion)
      this.beam.active = true
    } else {
      this.beam.xr = false
      // this.beam.kind = null
      this.beam.active = false
      // this.beam.pressed = false
    }
    // xr menu open
    if (this.beam.xr && this.beam.active && this.xrMenu.state === 'closed') {
      this.xrMenuTimer += delta
      if (this.xrMenuTimer > 0.6) {
        this.xrMenu.open(this.beam.kind)
      }
    } else if (xr) {
      this.xrMenuTimer = 0
    }
    // xr menu close
    if (this.xrMenu.state !== 'closed' && !this.beam.active) {
      this.xrMenu.close()
    }
    // xr menu updates
    if (xr) {
      this.xrMenu.update(delta)
      this.updateXRLaser(delta)
    }
    // inspect in pointer-lock
    if (this.beam.active && this.control.mouseRight.pressed) {
      const entity = this.getEntityAtBeam()
      if (entity?.isApp) {
        this.select(null)
        this.control.pointer.unlock()
        this.world.ui.setApp(entity)
      }
      if (entity?.isPlayer) {
        this.select(null)
        this.control.pointer.unlock()
        this.world.ui.togglePane('players')
      }
    }
    // inspect out of pointer-lock
    else if (!this.selected && !this.beam.active && this.control.mouseRight.pressed) {
      const entity = this.getEntityAtCursor()
      if (entity?.isApp) {
        this.select(null)
        this.control.pointer.unlock()
        this.world.ui.setApp(entity)
      }
      if (entity?.isPlayer) {
        this.select(null)
        this.control.pointer.unlock()
        this.world.ui.togglePane('players')
      }
    }
    // fork template from instance
    if (this.control.keyU.pressed && this.beam.active) {
      const entity = this.selected || this.getEntityAtBeam()
      if (entity?.isApp && !entity.blueprint.scene) {
        void (async () => {
          const blueprint = await this.forkTemplateFromEntity(entity, 'Template fork')
          if (!blueprint) return
          this.select(null)
          // assign new blueprint
          entity.modify({ blueprint: blueprint.id, props: {} })
          this.world.admin.entityModify(
            { id: entity.data.id, blueprint: blueprint.id, props: {} },
            { ignoreNetworkId: this.world.network.id }
          )
          // toast
          this.world.emit('toast', 'Template forked')
        })()
      }
    }
    // pin/unpin
    if (this.control.keyP.pressed && this.beam.active) {
      const entity = this.selected || this.getEntityAtBeam()
      if (entity?.isApp) {
        entity.data.pinned = !entity.data.pinned
        this.world.admin.entityModify(
          {
            id: entity.data.id,
            pinned: entity.data.pinned,
          },
          { ignoreNetworkId: this.world.network.id }
        )
        this.world.emit('toast', entity.data.pinned ? 'Pinned' : 'Un-pinned')
        this.select(null)
      }
    }
    // gizmo local/world toggle
    if (this.control.keyT.pressed & (this.mode === 'translate' || this.mode === 'rotate' || this.mode === 'scale')) {
      this.localSpace = !this.localSpace
      this.gizmo.space = this.localSpace ? 'local' : 'world'
      this.updateActions()
    }
    // grab mode
    if (this.control.digit1.pressed) {
      this.setMode('grab')
    }
    // translate mode
    if (this.control.digit2.pressed) {
      this.setMode('translate')
    }
    // rotate mode
    if (this.control.digit3.pressed) {
      this.setMode('rotate')
    }
    // scale mode
    if (this.control.digit4.pressed) {
      this.setMode('scale')
    }
    // left-click place/select/reselect/deselect
    if (this.xrMenu && this.xrMenu.move) {
      this.xrMenu.move = false
      const entity = this.getEntityAtBeam()
      if (entity?.isApp && !entity.data.pinned && !entity.blueprint.scene) {
        this.select(entity)
      }
    }
    if (!this.justPointerLocked && this.beam.active && this.control.mouseLeft.pressed) {
      // if nothing selected, attempt to select
      if (!this.selected) {
        const entity = this.getEntityAtBeam()
        if (entity?.isApp && !entity.data.pinned && !entity.blueprint.scene) this.select(entity)
      }
      // if selected in grab mode, place
      else if (this.selected && this.mode === 'grab') {
        this.select(null)
      }
      // if selected in translate/rotate/scale mode, re-select/deselect
      else if (
        this.selected &&
        (this.mode === 'translate' || this.mode === 'rotate' || this.mode === 'scale') &&
        !this.gizmoActive
      ) {
        const entity = this.getEntityAtBeam()
        if (entity?.isApp && !entity.data.pinned && !entity.blueprint.scene) this.select(entity)
        else this.select(null)
      }
    }
    // deselect on pointer unlock
    if (this.selected && !this.beam.active) {
      this.select(null)
    }
    // duplicate
    let duplicate
    if (this.xrMenu?.copy) {
      this.xrMenu.copy = false
      duplicate = true
    } else if (
      !this.justPointerLocked &&
      this.beam.active &&
      this.control.keyR.pressed &&
      !this.control.metaLeft.down &&
      !this.control.controlLeft.down
    ) {
      duplicate = true
    }
    if (duplicate) {
      const entity = this.selected || this.getEntityAtBeam()
      if (entity?.isApp && !entity.blueprint.scene) {
        if (entity.blueprint.unique) {
          void (async () => {
            const blueprint = await this.forkTemplateFromEntity(entity, 'Duplicate')
            if (!blueprint) return
            const data = {
              id: uuid(),
              type: 'app',
              blueprint: blueprint.id,
              position: entity.root.position.toArray(),
              quaternion: entity.root.quaternion.toArray(),
              scale: entity.root.scale.toArray(),
              mover: this.world.network.id,
              uploader: null,
              pinned: false,
              props: {},
              state: {},
            }
            const dup = this.world.entities.add(data)
            this.world.admin.entityAdd(data, { ignoreNetworkId: this.world.network.id })
            this.select(dup)
            this.addUndo({
              name: 'remove-entity',
              entityId: data.id,
            })
          })()
        } else {
          const instanceProps =
            entity.data.props && typeof entity.data.props === 'object' && !Array.isArray(entity.data.props)
              ? entity.data.props
              : {}
          const data = {
            id: uuid(),
            type: 'app',
            blueprint: entity.data.blueprint,
            position: entity.root.position.toArray(),
            quaternion: entity.root.quaternion.toArray(),
            scale: entity.root.scale.toArray(),
            mover: this.world.network.id,
            uploader: null,
            pinned: false,
            props: cloneDeep(instanceProps),
            state: {},
          }
          const dup = this.world.entities.add(data)
          this.world.admin.entityAdd(data, { ignoreNetworkId: this.world.network.id })
          this.select(dup)
          this.addUndo({
            name: 'remove-entity',
            entityId: data.id,
          })
        }
      }
    }
    // destroy
    let destroy
    if (this.xrMenu.delete) {
      destroy = true
      this.xrMenu.delete = false
    } else if (this.control.keyX.pressed) {
      destroy = true
    }
    if (destroy) {
      const entity = this.selected || this.getEntityAtBeam()
      if (entity?.isApp && !entity.data.pinned && !entity.blueprint.scene) {
        // Destroy first to avoid any rebuilds triggered by deselection
        this.addUndo({
          name: 'add-entity',
          data: cloneDeep(entity.data),
        })
        entity?.destroy(true)
        // Then clear selection without sending mover updates/rebuilds
        this.select(null)
      }
    }
    // undo
    if (
      this.control.keyZ.pressed &&
      !this.control.shiftLeft.down &&
      (this.control.metaLeft.down || this.control.controlLeft.down)
    ) {
      console.log('undo', {
        shiftLeft: this.control.shiftLeft.down,
        metaLeft: this.control.metaLeft.down,
        controlLeft: this.control.controlLeft.down,
      })
      this.undo()
    }
    // translate updates
    if (this.selected && this.mode === 'translate' && this.gizmoActive) {
      const app = this.selected
      app.root.position.copy(this.gizmoTarget.position)
      app.root.quaternion.copy(this.gizmoTarget.quaternion)
      app.root.scale.copy(this.gizmoTarget.scale)
    }
    // rotate updates
    if (this.selected && this.mode === 'rotate' && this.control.controlLeft.pressed) {
      this.gizmo.rotationSnap = null
    }
    if (this.selected && this.mode === 'rotate' && this.control.controlLeft.released) {
      this.gizmo.rotationSnap = SNAP_DEGREES * DEG2RAD
    }
    if (this.selected && this.mode === 'rotate' && this.gizmoActive) {
      const app = this.selected
      app.root.position.copy(this.gizmoTarget.position)
      app.root.quaternion.copy(this.gizmoTarget.quaternion)
      app.root.scale.copy(this.gizmoTarget.scale)
    }
    // scale updates
    if (this.selected && this.mode === 'scale' && this.gizmoActive) {
      const app = this.selected
      app.root.scale.copy(this.gizmoTarget.scale)
    }
    // grab updates
    if (this.selected && this.mode === 'grab') {
      const app = this.selected
      const hit = this.getHitAtBeam(app, true)
      // place at distance
      const beamPos = this.beam.position
      const beamDir = v1.copy(FORWARD).applyQuaternion(this.beam.quaternion)
      const hitDistance = hit ? hit.point.distanceTo(beamPos) : 0
      if (hit && hitDistance < this.target.limit) {
        // within range, use hit point
        this.target.position.copy(hit.point)
      } else {
        // no hit, project to limit
        this.target.position.copy(beamPos).add(beamDir.multiplyScalar(this.target.limit))
      }
      // push and pull (F/C keys or XR stick up/down)
      let project = 0
      if (this.control.keyF.down) project += this.control.shiftLeft.down ? 4 : 1
      if (this.control.keyC.down) project -= this.control.shiftLeft.down ? 4 : 1
      if (xr) {
        const stick = this.beam.kind === 'xrLeft' ? this.control.xrLeftStick.value : this.control.xrRightStick.value
        if (stick.z < -0.4) project += Math.abs(stick.z) * 4
        if (stick.z > 0.4) project -= stick.z * 4
      }
      if (project) {
        this.target.limit += project * PROJECT_SPEED * delta
        const min = xr ? PROJECT_MIN_XR : PROJECT_MIN
        if (this.target.limit < min) this.target.limit = min
        if (hitDistance && this.target.limit > hitDistance) this.target.limit = hitDistance
      }
      // scale (shift + mouse wheel or XR grip + left/right)
      let scale = 0
      if (this.control.shiftLeft.down) {
        scale = this.control.scrollDelta.value * 0.1
      }
      if (xr) {
        const grip = this.beam.kind === 'xrLeft' ? this.control.xrLeftGrip : this.control.xrRightGrip
        const stick = this.beam.kind === 'xrLeft' ? this.control.xrLeftStick.value : this.control.xrRightStick.value
        if (grip.down && Math.abs(stick.x) > 0.4) {
          scale = stick.x * 1.2
        }
      }
      if (scale) {
        const scaleFactor = 1 + scale * delta
        this.target.scale.multiplyScalar(scaleFactor)
      }
      // rotate (!shift + mouse wheel OR xr !grip stick left/right)
      let rotate = 0
      if (!this.control.shiftLeft.down) {
        rotate = this.control.scrollDelta.value * 0.1
      }
      if (xr) {
        const grip = this.beam.kind === 'xrLeft' ? this.control.xrLeftGrip : this.control.xrRightGrip
        const stick = this.beam.kind === 'xrLeft' ? this.control.xrLeftStick.value : this.control.xrRightStick.value
        if (!grip.down && Math.abs(stick.x) > 0.4) {
          rotate = -stick.x * 1.5
        }
      }
      if (rotate) {
        this.target.rotation.y += rotate * delta
      }
      // apply movement
      app.root.position.copy(this.target.position)
      app.root.quaternion.copy(this.target.quaternion)
      app.root.scale.copy(this.target.scale)
      // snap rotation to degrees
      if (!this.control.controlLeft.down) {
        const newY = this.target.rotation.y
        const degrees = newY / DEG2RAD
        const snappedDegrees = Math.round(degrees / SNAP_DEGREES) * SNAP_DEGREES
        app.root.rotation.y = snappedDegrees * DEG2RAD
      }
      // update matrix
      app.root.clean()
      // and snap to any nearby points
      if (!this.control.controlLeft.down) {
        for (const pos of app.snaps) {
          const result = this.world.snaps.octree.query(pos, SNAP_DISTANCE)[0]
          if (result) {
            const offset = v1.copy(result.position).sub(pos)
            app.root.position.add(offset)
            break
          }
        }
      }
    }
    // send selected updates
    if (this.selected) {
      this.lastMoveSendTime += delta
      if (this.lastMoveSendTime > this.world.networkRate) {
        const app = this.selected
        this.world.admin.entityModify(
          {
            id: app.data.id,
            position: app.root.position.toArray(),
            quaternion: app.root.quaternion.toArray(),
            scale: app.root.scale.toArray(),
          },
          { ignoreNetworkId: this.world.network.id }
        )
        this.lastMoveSendTime = 0
      }
    }

    if (this.justPointerLocked) {
      this.justPointerLocked = false
    }
  }

  addUndo(action) {
    this.undos.push(action)
    if (this.undos.length > 50) {
      this.undos.shift()
    }
  }

  undo() {
    const undo = this.undos.pop()
    if (!undo) return
    if (this.selected) this.select(null)
    if (undo.name === 'add-entity') {
      this.world.entities.add(undo.data)
      this.world.admin.entityAdd(undo.data, { ignoreNetworkId: this.world.network.id })
      return
    }
    if (undo.name === 'move-entity') {
      const entity = this.world.entities.get(undo.entityId)
      if (!entity) return
      entity.data.position = undo.position
      entity.data.quaternion = undo.quaternion
      this.world.admin.entityModify(
        {
          id: undo.entityId,
          position: entity.data.position,
          quaternion: entity.data.quaternion,
          scale: entity.data.scale,
        },
        { ignoreNetworkId: this.world.network.id }
      )
      entity.build()
      return
    }
    if (undo.name === 'remove-entity') {
      const entity = this.world.entities.get(undo.entityId)
      if (!entity) return
      entity.destroy(true)
      return
    }
  }

  toggle(enabled) {
    if (!this.canBuild()) return
    enabled = isBoolean(enabled) ? enabled : !this.enabled
    if (this.enabled === enabled) return
    this.enabled = enabled
    if (!this.enabled) this.select(null)
    this.updateActions()
    this.world.emit('build-mode', enabled)
  }

  setMode(mode) {
    // cleanup
    if (this.selected) {
      if (this.mode === 'grab') {
        this.control.keyC.capture = false
        this.control.scrollDelta.capture = false
      }
      if (this.mode === 'translate' || this.mode === 'rotate' || this.mode === 'scale') {
        this.detachGizmo()
      }
    }
    // change
    this.mode = mode
    if (this.mode === 'grab') {
      if (this.selected) {
        const app = this.selected
        this.control.keyC.capture = true
        this.control.scrollDelta.capture = true
        this.target.position.copy(app.root.position)
        this.target.quaternion.copy(app.root.quaternion)
        this.target.scale.copy(app.root.scale)
        this.target.limit = PROJECT_MAX
      }
    }
    if (this.mode === 'translate' || this.mode === 'rotate' || this.mode === 'scale') {
      if (this.selected) {
        this.attachGizmo(this.selected, this.mode)
      }
    }
    this.updateActions()
  }

  select(app) {
    // do nothing if unchanged
    if (this.selected === app) return
    // deselect existing
    if (this.selected && this.selected !== app) {
      // If the selected app was destroyed, skip mover updates and rebuilds
      if (!this.selected.destroyed && !this.selected.dead && this.selected.data.mover === this.world.network.id) {
        const app = this.selected
        app.data.mover = null
        app.data.position = app.root.position.toArray()
        app.data.quaternion = app.root.quaternion.toArray()
        app.data.scale = app.root.scale.toArray()
        app.data.state = {}
        this.world.admin.entityModify(
          {
            id: app.data.id,
            mover: null,
            position: app.data.position,
            quaternion: app.data.quaternion,
            scale: app.data.scale,
            state: app.data.state,
          },
          { ignoreNetworkId: this.world.network.id }
        )
        app.build()
      }
      this.selected = null
      if (this.mode === 'grab') {
        this.control.keyC.capture = false
        this.control.scrollDelta.capture = false
      }
      if (this.mode === 'translate' || this.mode === 'rotate' || this.mode === 'scale') {
        this.detachGizmo()
      }
    }
    // select new (if any)
    if (app) {
      this.addUndo({
        name: 'move-entity',
        entityId: app.data.id,
        position: app.data.position.slice(),
        quaternion: app.data.quaternion.slice(),
        scale: app.data.scale.slice(),
      })
      if (app.data.mover !== this.world.network.id) {
        app.data.mover = this.world.network.id
        app.build()
        this.world.admin.entityModify(
          { id: app.data.id, mover: app.data.mover },
          { ignoreNetworkId: this.world.network.id }
        )
      }
      this.selected = app
      if (this.mode === 'grab') {
        this.control.keyC.capture = true
        this.control.scrollDelta.capture = true
        this.target.position.copy(app.root.position)
        this.target.quaternion.copy(app.root.quaternion)
        this.target.scale.copy(app.root.scale)
        this.target.limit = PROJECT_MAX
      }
      if (this.mode === 'translate' || this.mode === 'rotate' || this.mode === 'scale') {
        this.attachGizmo(app, this.mode)
      }
    }
    // update actions
    this.updateActions()
  }

  createXRMenu() {
    const $root = createNode('group')
    const $ui = createNode('ui', {
      width: 200,
      height: 200,
      size: 0.001,
      // backgroundColor: 'white',
      doubleside: true,
      rotation: [-90 * DEG2RAD, 0, 0],
      position: [0, 0.01, 0.02],
    })
    $root.add($ui)
    function createBtn({ label }) {
      const $btn = createNode('uiview', {
        backgroundColor: 'black',
        borderRadius: 10,
        width: 60,
        height: 60,
        absolute: true,
        alignItems: 'center',
        justifyContent: 'center',
      })
      const $text = createNode('uitext', {
        value: label,
        color: 'white',
        fontSize: 11,
      })
      $btn.add($text)
      return {
        $btn,
        set highlight(value) {
          $btn.backgroundColor = value ? 'white' : 'black'
          $text.color = value ? 'black' : 'white'
        },
      }
    }
    const btn1 = createBtn({ label: 'Move' })
    btn1.$btn.left = 200 - 100 - 60 / 2
    btn1.$btn.top = 0
    $ui.add(btn1.$btn)
    const btn2 = createBtn({ label: 'Copy' })
    btn2.$btn.right = 0
    btn2.$btn.top = 200 - 100 - 60 / 2
    $ui.add(btn2.$btn)
    const btn3 = createBtn({ label: 'Delete' })
    btn3.$btn.left = 200 - 100 - 60 / 2
    btn3.$btn.bottom = 0
    $ui.add(btn3.$btn)
    // const btn4 = createBtn({ label: 'Pin' })
    // btn4.$btn.left = 0
    // btn4.$btn.top = 200 - 100 - 60 / 2
    // $ui.add(btn4.$btn)
    const menu = {
      state: 'closed',
      ray: null,
      stick: null,
      open: kind => {
        menu.ray = kind === 'xrLeft' ? this.control.xrLeftRayPose : this.control.xrRightRayPose
        menu.stick = kind === 'xrLeft' ? this.control.xrLeftStick : this.control.xrRightStick
        menu.stick.capture = true
        menu.state = 'open'
        $root.activate({ world: this.world, entity: null })
        console.log('OPEN')
      },
      hide: () => {
        menu.state = 'hidden'
        $root.deactivate()
        console.log('HIDe')
      },
      close: () => {
        menu.ray = null
        menu.stick.capture = false
        menu.stick = null
        menu.state = 'closed'
        $root.deactivate()
        console.log('CLOSE')
      },
      update: delta => {
        if (menu.state !== 'open') return
        // attach to hand
        $root.position.copy(menu.ray.position)
        $root.quaternion.copy(menu.ray.quaternion)
        // highlight button
        const stick = menu.stick
        btn1.highlight = false
        btn2.highlight = false
        btn3.highlight = false
        // btn4.highlight = false
        const deadzone = 0.3
        if (Math.abs(stick.value.x) > deadzone || Math.abs(stick.value.z) > deadzone) {
          const angle = Math.atan2(stick.value.z, stick.value.x)
          // Convert angle to degrees and normalize to 0-36
          let degrees = angle * (180 / Math.PI)
          if (degrees < 0) degrees += 360
          // Determine which quadrant/button based on angle
          // Top button: 45° to 135° (centered at 90°)
          // Right button: 315° to 45° (centered at 0°/360°)
          // Bottom button: 225° to 315° (centered at 270°)
          // Left button: 135° to 225° (centered at 180°)
          if (degrees >= 45 && degrees < 135) {
            // Down: Delete
            btn3.highlight = true
            menu.delete = true
            menu.hide()
          } else if (degrees >= 315 || degrees < 45) {
            // Right: Copy
            btn2.highlight = true
            menu.copy = true
            menu.hide()
          } else if (degrees >= 225 && degrees < 315) {
            // Up: Move
            btn1.highlight = true
            menu.move = true
            menu.hide()
          } else if (degrees >= 135 && degrees < 225) {
            // Left: Pin/Unpin
            // btn4.highlight = true
            // menu.pin = true
            // menu.hide()
          }
        }
      },
    }
    this.xrMenu = menu
  }

  updateXRLaser(delta) {
    if (!this.beam.xr) {
      if (this.xrLaser) this.xrLaser.visible = false
      return
    }
    if (!this.xrLaser) {
      const geometry = new THREE.BoxGeometry(0.002, 0.002, 1)
      geometry.translate(0, 0, -0.5)
      const material = new THREE.MeshStandardMaterial({ color: 'white', opacity: 0.5, transparent: true })
      this.xrLaser = new THREE.Mesh(geometry, material)
      this.xrLaser.scale.z = 2
      this.world.stage.scene.add(this.xrLaser)
    }

    const color = this.beam.build ? 'red' : 'white'
    if (this.xrLaser.material.$color !== color) {
      this.xrLaser.material.color.set(color)
      this.xrLaser.material.needsUpdate = true
      this.xrLaser.material.$color = color
    }
    this.xrLaser.position.copy(this.beam.kind === 'xrLeft' ? this.control.xrLeftRayPose.position : this.control.xrRightRayPose.position) // prettier-ignore
    this.xrLaser.quaternion.copy(this.beam.kind === 'xrLeft' ? this.control.xrLeftRayPose.quaternion : this.control.xrRightRayPose.quaternion) // prettier-ignore
    this.xrLaser.visible = true
  }

  attachGizmo(app, mode) {
    if (this.gizmo) this.detachGizmo()
    // create gizmo
    this.gizmo = new TransformControls(this.world.camera, this.viewport)
    this.gizmo.setSize(0.7)
    this.gizmo.space = this.localSpace ? 'local' : 'world'
    this.gizmo._gizmo.helper.translate.scale.setScalar(0)
    this.gizmo._gizmo.helper.rotate.scale.setScalar(0)
    this.gizmo._gizmo.helper.scale.scale.setScalar(0)
    this.gizmo.addEventListener('mouseDown', () => {
      this.gizmoActive = true
    })
    this.gizmo.addEventListener('mouseUp', () => {
      this.gizmoActive = false
    })
    this.gizmoTarget = new THREE.Object3D()
    this.gizmoHelper = this.gizmo.getHelper()
    // initialize it
    this.gizmoTarget.position.copy(app.root.position)
    this.gizmoTarget.quaternion.copy(app.root.quaternion)
    this.gizmoTarget.scale.copy(app.root.scale)
    this.world.stage.scene.add(this.gizmoTarget)
    this.world.stage.scene.add(this.gizmoHelper)
    this.gizmo.rotationSnap = SNAP_DEGREES * DEG2RAD
    this.gizmo.attach(this.gizmoTarget)
    this.gizmo.mode = mode
  }

  detachGizmo() {
    if (!this.gizmo) return
    this.world.stage.scene.remove(this.gizmoTarget)
    this.world.stage.scene.remove(this.gizmoHelper)
    this.gizmo.detach()
    this.gizmo.disconnect()
    this.gizmo.dispose()
    this.gizmo = null
  }

  getEntityAtReticle() {
    const hits = this.world.stage.raycastReticle()
    let entity
    for (const hit of hits) {
      entity = hit.getEntity?.()
      if (entity) break
    }
    return entity
  }

  getEntityAtBeam() {
    const origin = this.beam.position
    const dir = v1.set(0, 0, -1).applyQuaternion(this.beam.quaternion)
    const hits = this.world.stage.raycast(origin, dir)
    let entity
    for (const hit of hits) {
      entity = hit.getEntity?.()
      if (entity) break
    }
    return entity
  }

  getEntityAtCursor() {
    const hits = this.world.stage.raycastPointer(this.control.pointer.position)
    let entity
    for (const hit of hits) {
      entity = hit.getEntity?.()
      if (entity) break
    }
    return entity
  }

  getHitAtBeam(ignoreEntity, ignorePlayers) {
    const origin = this.beam.position
    const dir = v1.set(0, 0, -1).applyQuaternion(this.beam.quaternion)
    const hits = this.world.stage.raycast(origin, dir)
    let hit
    for (const _hit of hits) {
      const entity = _hit.getEntity?.()
      if (entity === ignoreEntity || (entity?.isPlayer && ignorePlayers)) continue
      hit = _hit
      break
    }
    return hit
  }

  getHitAtReticle(ignoreEntity, ignorePlayers) {
    const hits = this.world.stage.raycastReticle()
    let hit
    for (const _hit of hits) {
      const entity = _hit.getEntity?.()
      if (entity === ignoreEntity || (entity?.isPlayer && ignorePlayers)) continue
      hit = _hit
      break
    }
    return hit
  }

  onDragOver = e => {
    e.preventDefault()
  }

  onDragEnter = e => {
    this.dropTarget = e.target
    this.dropping = true
    this.file = null
  }

  onDragLeave = e => {
    if (e.target === this.dropTarget) {
      this.dropping = false
    }
  }

  onDrop = async e => {
    e.preventDefault()
    this.dropping = false
    // extract file from drop
    let file
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      const item = e.dataTransfer.items[0]
      if (item.kind === 'file') {
        file = item.getAsFile()
      }
      // Handle multiple MIME types for URLs
      if (item.type === 'text/uri-list' || item.type === 'text/plain' || item.type === 'text/html') {
        const text = await getAsString(item)
        // Extract URL from the text (especially important for text/html type)
        const url = text.trim().split('\n')[0] // Take first line in case of multiple
        if (url.startsWith('http')) {
          // Basic URL validation
          const resp = await fetch(url)
          const blob = await resp.blob()
          file = new File([blob], new URL(url).pathname.split('/').pop(), { type: resp.headers.get('content-type') })
        }
      }
    } else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      file = e.dataTransfer.files[0]
    }
    if (!file) return
    // slight delay to ensure we get updated pointer position from window focus
    await new Promise(resolve => setTimeout(resolve, 100))
    // get file type
    const ext = file.name.split('.').pop().toLowerCase()
    // if vrm and we are not a builder and custom avatars are not allowed, stop here
    if (ext === 'vrm' && !this.canBuild() && !this.world.settings.customAvatars) {
      return
    }
    // check file size
    const maxSize = this.world.network.maxUploadSize * 1024 * 1024
    if (ext !== 'hyp' && file.size > maxSize) {
      this.world.chat.add({
        id: uuid(),
        from: null,
        fromId: null,
        body: `File size too large (>${this.world.network.maxUploadSize}mb)`,
        createdAt: moment().toISOString(),
      })
      console.error(`File too large. Maximum size is ${maxSize / (1024 * 1024)}MB`)
      return
    }
    // builder rank required for non-vrm files
    if (ext !== 'vrm') {
      if (!this.canBuild()) {
        this.world.chat.add({
          id: uuid(),
          from: null,
          fromId: null,
          body: `You don't have permission to do that.`,
          createdAt: moment().toISOString(),
        })
        return
      }
      // switch to build mode
      this.toggle(true)
    }
    const transform = this.getSpawnTransform()
    if (ext === 'hyp') {
      this.addApp(file, transform)
    }
    if (ext === 'glb') {
      this.addModel(file, transform)
    }
    if (ext === 'vrm') {
      const canPlace = this.canBuild()
      this.addAvatar(file, transform, canPlace)
    }
  }

  async addApp(file, transform) {
    if (typeof this.ensureAdminReady === 'function' && !this.ensureAdminReady('Import')) return
    let lockToken = null
    let blueprint = null
    let app = null
    let sceneRevert = null
    try {
      const info = await importApp(file)
      const maxUploadSize = Number(this.world.network.maxUploadSize)
      if (Number.isFinite(maxUploadSize) && maxUploadSize > 0) {
        const maxBytes = maxUploadSize * 1024 * 1024
        for (const asset of info.assets) {
          if (asset.file.size > maxBytes) {
            this.world.chat.add({
              id: uuid(),
              from: null,
              fromId: null,
              body: `File size too large (>${maxUploadSize}mb)`,
              createdAt: moment().toISOString(),
            })
            console.error(`File too large. Maximum size is ${maxUploadSize}MB`)
            return
          }
        }
      }
      for (const asset of info.assets) {
        if (asset.type) {
          this.world.loader.insert(asset.type, asset.url, asset.file)
        } else {
          this.world.loader.setFile?.(asset.url, asset.file)
        }
      }
      if (info.blueprint.scene) {
        const confirmed = await this.world.ui.confirm({
          title: 'Scene',
          message: 'Do you want to replace your current scene with this one?',
          confirmText: 'Replace',
          cancelText: 'Cancel',
        })
        if (!confirmed) return
        const scene = this.world.blueprints.getScene()
        sceneRevert = scene ? cloneDeep(scene) : null
        const importedProps =
          info.blueprint.props && typeof info.blueprint.props === 'object' && !Array.isArray(info.blueprint.props)
            ? info.blueprint.props
            : {}
        const change = {
          id: scene.id,
          version: scene.version + 1,
          scope: normalizeScope(scene?.scope) || '$scene',
          name: info.blueprint.name,
          image: info.blueprint.image,
          author: info.blueprint.author,
          url: info.blueprint.url,
          desc: info.blueprint.desc,
          model: info.blueprint.model,
          script: info.blueprint.script,
          scriptEntry: info.blueprint.scriptEntry,
          scriptFiles: info.blueprint.scriptFiles,
          scriptFormat: info.blueprint.scriptFormat,
          scriptRef: info.blueprint.scriptRef,
          props: importedProps,
          preload: info.blueprint.preload,
          public: info.blueprint.public,
          locked: info.blueprint.locked,
          frozen: info.blueprint.frozen,
          unique: info.blueprint.unique,
          scene: info.blueprint.scene,
          disabled: info.blueprint.disabled,
        }
        if (hasScriptFields(change)) {
          const result = await this.world.admin.acquireDeployLock({
            owner: this.world.network.id,
            scope: change.scope,
          })
          lockToken = result?.token || this.world.admin.deployLockToken
        }
        await Promise.all(info.assets.map(asset => this.world.admin.upload(asset.file)))
        this.world.blueprints.modify(change)
        await this.world.admin.blueprintModify(change, {
          ignoreNetworkId: this.world.network.id,
          lockToken,
          request: true,
        })
        this.world.emit('toast', 'Imported app')
        return
      }
      const importedProps =
        info.blueprint.props && typeof info.blueprint.props === 'object' && !Array.isArray(info.blueprint.props)
          ? info.blueprint.props
          : {}
      blueprint = {
        id: uuid(),
        version: 0,
        scope: normalizeScope(info.blueprint.scope),
        name: info.blueprint.name,
        image: info.blueprint.image,
        author: info.blueprint.author,
        url: info.blueprint.url,
        desc: info.blueprint.desc,
        model: info.blueprint.model,
        script: info.blueprint.script,
        scriptEntry: info.blueprint.scriptEntry,
        scriptFiles: info.blueprint.scriptFiles,
        scriptFormat: info.blueprint.scriptFormat,
        scriptRef: info.blueprint.scriptRef,
        props: importedProps,
        preload: info.blueprint.preload,
        public: info.blueprint.public,
        locked: info.blueprint.locked,
        frozen: info.blueprint.frozen,
        unique: info.blueprint.unique,
        scene: info.blueprint.scene,
        disabled: info.blueprint.disabled,
      }
      if (hasScriptFields(blueprint)) {
        if (!normalizeScope(blueprint.scope)) {
          blueprint.scope = blueprint.id
        }
        const result = await this.world.admin.acquireDeployLock({
          owner: this.world.network.id,
          scope: blueprint.scope,
        })
        lockToken = result?.token || this.world.admin.deployLockToken
      }
      this.world.blueprints.add(blueprint)
      await this.world.admin.blueprintAdd(blueprint, {
        ignoreNetworkId: this.world.network.id,
        lockToken,
        request: true,
      })
      const data = {
        id: uuid(),
        type: 'app',
        blueprint: blueprint.id,
        position: transform.position,
        quaternion: transform.quaternion,
        scale: [1, 1, 1],
        mover: null,
        uploader: this.world.network.id,
        pinned: false,
        props: {},
        state: {},
      }
      app = this.world.entities.add(data)
      await this.world.admin.entityAdd(data, { ignoreNetworkId: this.world.network.id, request: true })
      await Promise.all(info.assets.map(asset => this.world.admin.upload(asset.file)))
      app.onUploaded()
      this.world.emit('toast', 'Imported app')
    } catch (err) {
      if (app) {
        app.destroy(true)
      }
      if (blueprint) {
        this.world.blueprints.remove(blueprint.id)
        this.world.admin
          ?.blueprintRemove?.(blueprint.id)
          .catch(removeErr => console.error('failed to remove blueprint', removeErr))
      }
      if (sceneRevert) {
        this.world.blueprints.modify(sceneRevert)
      }
      this.handleAdminError(err, 'Import failed')
    } finally {
      if (lockToken && this.world.admin?.releaseDeployLock) {
        try {
          await this.world.admin.releaseDeployLock(lockToken)
        } catch (releaseErr) {
          console.error('failed to release deploy lock', releaseErr)
        }
      }
    }
  }

  async addModel(file, transform) {
    if (!this.ensureAdminReady('Build')) return
    // immutable hash the file
    const hash = await hashFile(file)
    // use hash as glb filename
    const filename = `${hash}.glb`
    // canonical url to this file
    const url = `asset://${filename}`
    // create a blank module script entry
    const scriptFile = new File([DEFAULT_MODULE_SCRIPT_SOURCE], DEFAULT_MODULE_SCRIPT_ENTRY, {
      type: 'text/javascript',
    })
    const scriptHash = await hashFile(scriptFile)
    const scriptUrl = `asset://${scriptHash}.js`
    // cache file locally so this client can insta-load it
    this.world.loader.insert('model', url, file)
    this.world.loader.insert('script', scriptUrl, scriptFile)
    // make blueprint
    const blueprint = {
      id: uuid(),
      version: 0,
      scope: null,
      name: file.name.split('.')[0],
      image: null,
      author: null,
      url: null,
      desc: null,
      model: url,
      script: scriptUrl,
      scriptEntry: DEFAULT_MODULE_SCRIPT_ENTRY,
      scriptFiles: {
        [DEFAULT_MODULE_SCRIPT_ENTRY]: scriptUrl,
      },
      scriptFormat: 'module',
      scriptRef: null,
      props: {},
      preload: false,
      public: false,
      locked: false,
      unique: false,
      scene: false,
      disabled: false,
    }
    if (hasScriptFields(blueprint) && !normalizeScope(blueprint.scope)) {
      blueprint.scope = blueprint.id
    }
    let app = null
    let lockToken = null
    let lockScope = null
    try {
      if (hasScriptFields(blueprint)) {
        lockScope = normalizeScope(blueprint.scope)
        if (!lockScope) {
          throw new Error('scope_unknown')
        }
        const result = await this.world.admin.acquireDeployLock({
          owner: this.world.network.id,
          scope: lockScope,
        })
        lockToken = result?.token || this.world.admin.deployLockToken
      }
      // register blueprint
      this.world.blueprints.add(blueprint)
      await this.world.admin.blueprintAdd(blueprint, {
        ignoreNetworkId: this.world.network.id,
        lockToken,
        request: true,
      })
      // spawn the app moving
      // - mover: follows this clients cursor until placed
      // - uploader: other clients see a loading indicator until its fully uploaded
      const data = {
        id: uuid(),
        type: 'app',
        blueprint: blueprint.id,
        position: transform.position,
        quaternion: transform.quaternion,
        scale: [1, 1, 1],
        mover: null,
        uploader: this.world.network.id,
        pinned: false,
        props: {},
        state: {},
      }
      app = this.world.entities.add(data)
      await this.world.admin.entityAdd(data, { ignoreNetworkId: this.world.network.id, request: true })
      // upload the model + blank module script
      await Promise.all([this.world.admin.upload(file), this.world.admin.upload(scriptFile)])
      // mark as uploaded so other clients can load it in
      app.onUploaded()
    } catch (err) {
      if (app) {
        app.destroy(true)
      }
      if (blueprint) {
        this.world.blueprints.remove(blueprint.id)
        this.world.admin
          ?.blueprintRemove?.(blueprint.id)
          .catch(removeErr => console.error('failed to remove blueprint', removeErr))
      }
      this.handleAdminError(err, 'Import failed')
    } finally {
      if (lockToken && this.world.admin?.releaseDeployLock) {
        try {
          await this.world.admin.releaseDeployLock(lockToken, lockScope)
        } catch (releaseErr) {
          console.error('failed to release deploy lock', releaseErr)
        }
      }
    }
  }

  async addAvatar(file, transform, canPlace) {
    // immutable hash the file
    const hash = await hashFile(file)
    // use hash as vrm filename
    const filename = `${hash}.vrm`
    // canonical url to this file
    const url = `asset://${filename}`
    // cache file locally so this client can insta-load it
    this.world.loader.insert('avatar', url, file)
    this.world.emit('avatar', {
      file,
      url,
      hash,
      canPlace,
      onPlace: async () => {
        if (!this.ensureAdminReady('Place')) return
        // close pane
        this.world.emit('avatar', null)
        // make blueprint
        const blueprint = {
          id: uuid(),
          version: 0,
          name: file.name,
          image: null,
          author: null,
          url: null,
          desc: null,
          model: url,
          props: {},
          preload: false,
          public: false,
          locked: false,
          unique: false,
          scene: false,
          disabled: false,
        }
        let app = null
        try {
          // register blueprint
          this.world.blueprints.add(blueprint)
          await this.world.admin.blueprintAdd(blueprint, {
            ignoreNetworkId: this.world.network.id,
            request: true,
          })
          // spawn the app moving
          // - mover: follows this clients cursor until placed
          // - uploader: other clients see a loading indicator until its fully uploaded
          const data = {
            id: uuid(),
            type: 'app',
            blueprint: blueprint.id,
            position: transform.position,
            quaternion: transform.quaternion,
            scale: [1, 1, 1],
            mover: null,
            uploader: this.world.network.id,
            pinned: false,
            props: {},
            state: {},
          }
          app = this.world.entities.add(data)
          await this.world.admin.entityAdd(data, { ignoreNetworkId: this.world.network.id, request: true })
          // upload the glb
          await this.world.admin.upload(file)
          // mark as uploaded so other clients can load it in
          app.onUploaded()
        } catch (err) {
          if (app) {
            app.destroy(true)
          }
          if (blueprint) {
            this.world.blueprints.remove(blueprint.id)
            this.world.admin
              ?.blueprintRemove?.(blueprint.id)
              .catch(removeErr => console.error('failed to remove blueprint', removeErr))
          }
          this.handleAdminError(err, 'Place failed')
        }
      },
      onEquip: async () => {
        // close pane
        this.world.emit('avatar', null)
        // prep new user data
        const player = this.world.entities.player
        const prevUrl = player.data.avatar
        // update locally
        player.modify({ avatar: url, sessionAvatar: null })
        // upload
        try {
          await this.world.admin.upload(file)
        } catch (err) {
          console.error(err)
          // revert
          player.modify({ avatar: prevUrl })
          this.handleAdminError(err, 'Avatar upload failed')
          return
        }
        if (player.data.avatar !== url) {
          return // player equipped a new vrm while this one was uploading >.>
        }
        // update for everyone
        this.world.network.send('entityModified', {
          id: player.data.id,
          avatar: url,
        })
      },
    })
  }

  getSpawnTransform(atReticle) {
    const hit = atReticle
      ? this.world.stage.raycastReticle()[0]
      : this.world.stage.raycastPointer(this.control.pointer.position)[0]
    const position = hit ? hit.point.toArray() : [0, 0, 0]
    let quaternion
    if (hit) {
      e1.copy(this.world.rig.rotation).reorder('YXZ')
      e1.x = 0
      e1.z = 0
      const degrees = e1.y * RAD2DEG
      const snappedDegrees = Math.round(degrees / SNAP_DEGREES) * SNAP_DEGREES
      e1.y = snappedDegrees * DEG2RAD
      q1.setFromEuler(e1)
      quaternion = q1.toArray()
    } else {
      quaternion = [0, 0, 0, 1]
    }
    return { position, quaternion }
  }

  destroy() {
    this.viewport.removeEventListener('dragover', this.onDragOver)
    this.viewport.removeEventListener('dragenter', this.onDragEnter)
    this.viewport.removeEventListener('dragleave', this.onDragLeave)
    this.viewport.removeEventListener('drop', this.onDrop)
  }
}

function getAsString(item) {
  return new Promise(resolve => {
    item.getAsString(resolve)
  })
}
