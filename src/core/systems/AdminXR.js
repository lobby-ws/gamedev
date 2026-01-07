import { System } from './System'

export class AdminXR extends System {
  constructor(world) {
    super(world)
    this.session = null
    this.camera = world.camera
    this.supportsVR = false
    this.supportsAR = false
  }

  async init() {
    this.camera = this.world.camera
  }

  async enter() {
    // XR is disabled for admin clients.
    return false
  }
}
