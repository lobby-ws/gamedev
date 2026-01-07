import * as THREE from '../extras/three'
import { Ranks, hasRank } from '../extras/ranks'

const ZERO_POS = [0, 0, 0]
const IDENTITY_QUAT = [0, 0, 0, 1]

export class AdminLocalPlayer {
  constructor(world, { id, name } = {}) {
    this.world = world
    this.isPlayer = true
    this.isLocal = true
    this.isRemote = false
    this.isXR = false
    this.base = world.rig
    this.data = {
      id,
      owner: id,
      userId: id,
      name: name || 'Admin',
      rank: Ranks.ADMIN,
      position: [...ZERO_POS],
      quaternion: [...IDENTITY_QUAT],
    }
    this.enteredAt = Date.now()
  }

  outranks(otherPlayer) {
    if (!otherPlayer?.data) return true
    const rank = Math.max(this.data.rank, this.world.settings.effectiveRank)
    const otherRank = Math.max(otherPlayer.data.rank, this.world.settings.effectiveRank)
    return rank > otherRank
  }

  isAdmin() {
    const rank = Math.max(this.data.rank, this.world.settings.effectiveRank)
    return hasRank(rank, Ranks.ADMIN)
  }

  isBuilder() {
    const rank = Math.max(this.data.rank, this.world.settings.effectiveRank)
    return hasRank(rank, Ranks.BUILDER)
  }

  isMuted() {
    return this.world.livekit?.isMuted?.(this.data.id) || false
  }

  teleport({ position, rotationY }) {
    const target = position?.isVector3 ? position : new THREE.Vector3().fromArray(position || ZERO_POS)
    const euler = new THREE.Euler(0, rotationY || 0, 0, 'YXZ')
    const quaternion = new THREE.Quaternion().setFromEuler(euler)
    this.world.freeCam?.teleport({ position: target, quaternion })
  }

  setName(name) {
    if (!name) return
    this.modify({ name })
  }

  setSessionAvatar() {
    // No-op for admin local player.
  }

  modify(data) {
    if (data.hasOwnProperty('name')) {
      this.data.name = data.name
      this.world.emit('name', { playerId: this.data.id, name: this.data.name })
    }
    if (data.hasOwnProperty('rank')) {
      this.data.rank = data.rank
      this.world.emit('rank', { playerId: this.data.id, rank: this.data.rank })
    }
  }
}
