import * as THREE from '../extras/three'
import { clamp } from '../utils'
import { ControlPriorities } from '../extras/ControlPriorities'
import { DEG2RAD } from '../extras/general'

const MOVE_DIR = new THREE.Vector3()
const MOVE_STEP = new THREE.Vector3()

export class FreeCam {
  constructor(world) {
    this.world = world
    this.position = new THREE.Vector3()
    this.quaternion = new THREE.Quaternion()
    this.euler = new THREE.Euler(0, 0, 0, 'YXZ')

    this.moveSpeed = 10
    this.fastMultiplier = 3
    this.lookSpeed = 0.002
    this.minPitch = -89 * DEG2RAD
    this.maxPitch = 89 * DEG2RAD

    this.control = this.world.controls.bind({ priority: ControlPriorities.PLAYER })
    this.control.camera.write = true
    this.control.camera.position.copy(this.position)
    this.control.camera.quaternion.copy(this.quaternion)
    this.control.camera.zoom = 0

    this.world.setHot(this, true)
  }

  setSpawn(spawn) {
    if (!spawn?.position || !spawn?.quaternion) return
    this.setTransform({
      position: spawn.position,
      quaternion: spawn.quaternion,
    })
  }

  teleport({ position, quaternion, rotationY }) {
    this.setTransform({ position, quaternion, rotationY })
  }

  setTransform({ position, quaternion, rotationY }) {
    if (position) {
      if (position.isVector3) {
        this.position.copy(position)
      } else {
        this.position.fromArray(position)
      }
    }
    if (quaternion) {
      if (quaternion.isQuaternion) {
        this.quaternion.copy(quaternion)
      } else {
        this.quaternion.fromArray(quaternion)
      }
    } else if (rotationY !== undefined) {
      this.euler.set(0, rotationY, 0)
      this.quaternion.setFromEuler(this.euler)
    }

    this.euler.setFromQuaternion(this.quaternion, 'YXZ')
    this.control.camera.position.copy(this.position)
    this.control.camera.quaternion.copy(this.quaternion)
  }

  update(delta) {
    if (this.control.pointer.locked) {
      const deltaX = this.control.pointer.delta.x
      const deltaY = this.control.pointer.delta.y
      if (deltaX || deltaY) {
        this.euler.y -= deltaX * this.lookSpeed
        this.euler.x = clamp(this.euler.x - deltaY * this.lookSpeed, this.minPitch, this.maxPitch)
        this.quaternion.setFromEuler(this.euler)
      }
    }

    if (this.control.pointer.locked) {
      MOVE_DIR.set(0, 0, 0)
      if (this.control.keyW.down || this.control.arrowUp.down) MOVE_DIR.z -= 1
      if (this.control.keyS.down || this.control.arrowDown.down) MOVE_DIR.z += 1
      if (this.control.keyA.down || this.control.arrowLeft.down) MOVE_DIR.x -= 1
      if (this.control.keyD.down || this.control.arrowRight.down) MOVE_DIR.x += 1
      if (this.control.space.down) MOVE_DIR.y += 1
      if (this.control.keyC.down) MOVE_DIR.y -= 1

      if (MOVE_DIR.lengthSq() > 0) {
        MOVE_DIR.normalize()
        MOVE_STEP.copy(MOVE_DIR).applyQuaternion(this.quaternion)
        const speed =
          this.control.shiftLeft.down || this.control.shiftRight.down
            ? this.moveSpeed * this.fastMultiplier
            : this.moveSpeed
        MOVE_STEP.multiplyScalar(speed * delta)
        this.position.add(MOVE_STEP)
      }
    }

    this.control.camera.position.copy(this.position)
    this.control.camera.quaternion.copy(this.quaternion)

    const localPlayer = this.world.entities.player
    if (localPlayer?.data?.position && localPlayer?.data?.quaternion) {
      localPlayer.data.position[0] = this.position.x
      localPlayer.data.position[1] = this.position.y
      localPlayer.data.position[2] = this.position.z
      localPlayer.data.quaternion[0] = this.quaternion.x
      localPlayer.data.quaternion[1] = this.quaternion.y
      localPlayer.data.quaternion[2] = this.quaternion.z
      localPlayer.data.quaternion[3] = this.quaternion.w
    }
  }

  destroy() {
    this.control?.release()
    this.control = null
    this.world.setHot(this, false)
  }
}
