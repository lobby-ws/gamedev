import { Node } from './Node'

export class Splat extends Node {
  constructor(data = {}) {
    super(data)
    this.name = 'splat'
    this._mesh = data.mesh || null
  }

  mount() {
    if (this.ctx.world.network.isServer) return
    if (!this._mesh) return
    this._mesh.matrix.copy(this.matrixWorld)
    this._mesh.matrixAutoUpdate = false
    this._mesh.updateMatrixWorld(true)
    this.ctx.world.stage.scene.add(this._mesh)
  }

  commit(didMove) {
    if (didMove && this._mesh) {
      this._mesh.matrix.copy(this.matrixWorld)
      this._mesh.updateMatrixWorld(true)
    }
  }

  unmount() {
    if (this._mesh) {
      this.ctx.world.stage.scene.remove(this._mesh)
    }
  }

  copy(source, recursive) {
    super.copy(source, recursive)
    this._mesh = source._mesh
    return this
  }

  getProxy() {
    if (!this.proxy) {
      let proxy = {}
      proxy = Object.defineProperties(proxy, Object.getOwnPropertyDescriptors(super.getProxy()))
      this.proxy = proxy
    }
    return this.proxy
  }
}
