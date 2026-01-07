import { System } from './System'

export class AdminLiveKit extends System {
  constructor(world) {
    super(world)
    this.status = {
      available: false,
      connected: false,
      mic: false,
      screenshare: null,
      level: 'disabled',
      muted: false,
    }
    this.muted = new Set()
    this.levels = {}
  }

  deserialize() {
    // No-op: admin clients do not join voice.
  }

  isMuted(playerId) {
    return this.muted.has(playerId)
  }

  setMuted(playerId, muted) {
    if (muted) {
      this.muted.add(playerId)
    } else {
      this.muted.delete(playerId)
    }
    this.emit('muted', { playerId, muted })
    if (playerId === this.world.network.id) {
      this.status.muted = muted
      this.emit('status', this.status)
    }
  }

  setLevel(playerId, level) {
    this.levels[playerId] = level
    if (playerId === this.world.network.id) {
      this.status.level = level
      this.emit('status', this.status)
    }
  }

  setMicrophoneEnabled() {
    // No-op.
  }

  setScreenShareTarget() {
    // No-op.
  }
}
