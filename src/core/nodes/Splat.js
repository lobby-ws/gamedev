import { isString } from 'lodash-es'
import { Node } from './Node'

const defaults = {
  src: null,
}

export class Splat extends Node {
  constructor(data = {}) {
    super(data)
    this.name = 'splat'
    this.src = data.src
  }

  async mount() {
    if (this.ctx.world.network.isServer) return
    if (!this._src) return
    this.needsRebuild = false
    const url = this.ctx.world.resolveURL(this._src)
    let splatData = this.ctx.world.loader.get('splat', url)
    if (!splatData) {
      splatData = await this.ctx.world.loader.load('splat', url)
    }
    if (!this.mounted) return
    this.handle = await this.ctx.world.stage.insertSplat({
      splatData,
      matrix: this.matrixWorld,
      node: this,
    })
  }

  commit(didMove) {
    if (this.needsRebuild) {
      this.unmount()
      this.mount()
      return
    }
    if (didMove && this.handle) {
      this.handle.move(this.matrixWorld)
    }
  }

  unmount() {
    this.handle?.destroy()
    this.handle = null
  }

  copy(source, recursive) {
    super.copy(source, recursive)
    this._src = source._src
    return this
  }

  get src() {
    return this._src
  }

  set src(value = defaults.src) {
    if (value !== null && !isString(value)) {
      throw new Error('[splat] src must be a string')
    }
    if (this._src === value) return
    this._src = value
    this.needsRebuild = true
    this.setDirty()
  }

  getProxy() {
    if (!this.proxy) {
      const self = this
      let proxy = {
        get src() {
          return self.src
        },
        set src(value) {
          self.src = value
        },
      }
      proxy = Object.defineProperties(proxy, Object.getOwnPropertyDescriptors(super.getProxy()))
      this.proxy = proxy
    }
    return this.proxy
  }
}
