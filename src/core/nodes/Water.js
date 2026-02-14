import { isNumber, isString, isArray } from 'lodash-es'
import { Water as ThreeWater } from '../extras/ThreeWater'
import * as THREE from '../extras/three'
import { Node } from './Node'

const _rotMatrix = new THREE.Matrix4().makeRotationX(-Math.PI / 2)

const defaults = {
  width: 10,
  height: 10,
  color: '#001e0f',
  sunColor: '#ffffff',
  sunDirection: [0, 0, 0],
  distortionScale: 2,
  speed: 0.1,
  alpha: 1,
  reflectivity: 0.3,
  textureSize: 256,
  normals: null,
}

export class Water extends Node {
  constructor(data = {}) {
    super(data)
    this.name = 'water'

    this.width = data.width
    this.height = data.height
    this.color = data.color
    this.sunColor = data.sunColor
    this.sunDirection = data.sunDirection
    this.distortionScale = data.distortionScale
    this.speed = data.speed
    this.alpha = data.alpha
    this.reflectivity = data.reflectivity
    this.textureSize = data.textureSize
    this.normals = data.normals

    this.n = 0
    this._offsetMatrix = new THREE.Matrix4()
  }

  async mount() {
    this.needsRebuild = false
    if (this.ctx.world.network?.isServer) return

    const n = ++this.n

    let normalsTexture
    if (this._normals) {
      let tex = this.ctx.world.loader.get('texture', this._normals)
      if (!tex) tex = await this.ctx.world.loader.load('texture', this._normals)
      if (this.n !== n) return
      normalsTexture = tex
      normalsTexture.wrapS = THREE.RepeatWrapping
      normalsTexture.wrapT = THREE.RepeatWrapping
    } else {
      normalsTexture = new THREE.TextureLoader().load('/waternormals.jpg', texture => {
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping
      })
    }

    const geometry = new THREE.PlaneGeometry(this._width, this._height)

    const sunDir = new THREE.Vector3().fromArray(this._sunDirection)

    this.water = new ThreeWater(geometry, {
      textureWidth: this._textureSize,
      textureHeight: this._textureSize,
      waterNormals: normalsTexture,
      sunDirection: sunDir,
      sunColor: 0xffffff,
      waterColor: new THREE.Color(this._color).getHex(),
      distortionScale: this._distortionScale,
      alpha: this._alpha,
      reflectivity: this._reflectivity,
    })

    const self = this
    const usePostprocessing = this.ctx.world.graphics?.usePostprocessing
    const origOnBeforeRender = this.water.onBeforeRender
    this.water.onBeforeRender = function (renderer, scene, camera) {
      this.material.uniforms['isPostProcessing'].value = usePostprocessing
      this.material.uniforms['time'].value += (1 / 60) * self._speed
      origOnBeforeRender.call(this, renderer, scene, camera)
    }

    this.water.matrixAutoUpdate = false
    this.water.matrixWorldAutoUpdate = false
    this.updateOffsetMatrix()

    this.ctx.world.stage.scene.add(this.water)
  }

  commit(didMove) {
    if (this.needsRebuild) {
      this.unbuild()
      this.mount()
      return
    }
    if (didMove && this.water) {
      this.updateOffsetMatrix()
    }
  }

  unmount() {
    this.unbuild()
  }

  unbuild() {
    this.n++
    if (this.water) {
      this.ctx.world.stage.scene.remove(this.water)
      this.water.material.dispose()
      this.water.geometry.dispose()
      this.water = null
    }
  }

  updateOffsetMatrix() {
    this._offsetMatrix.multiplyMatrices(this.matrixWorld, _rotMatrix)
    this.water.matrixWorld.copy(this._offsetMatrix)
  }

  copy(source, recursive) {
    super.copy(source, recursive)
    this._width = source._width
    this._height = source._height
    this._color = source._color
    this._sunColor = source._sunColor
    this._sunDirection = source._sunDirection
    this._distortionScale = source._distortionScale
    this._speed = source._speed
    this._alpha = source._alpha
    this._reflectivity = source._reflectivity
    this._textureSize = source._textureSize
    this._normals = source._normals
    return this
  }

  get width() {
    return this._width
  }

  set width(value = defaults.width) {
    if (!isNumber(value) || value <= 0) {
      throw new Error('[water] width must be positive number')
    }
    if (this._width === value) return
    this._width = value
    this.needsRebuild = true
    this.setDirty()
  }

  get height() {
    return this._height
  }

  set height(value = defaults.height) {
    if (!isNumber(value) || value <= 0) {
      throw new Error('[water] height must be positive number')
    }
    if (this._height === value) return
    this._height = value
    this.needsRebuild = true
    this.setDirty()
  }

  get color() {
    return this._color
  }

  set color(value = defaults.color) {
    if (!isString(value)) {
      throw new Error('[water] color must be string')
    }
    if (this._color === value) return
    this._color = value
    if (this.water) {
      this.water.material.uniforms['waterColor'].value.set(value)
    }
  }

  get sunColor() {
    return this._sunColor
  }

  set sunColor(value = defaults.sunColor) {
    if (!isString(value)) {
      throw new Error('[water] sunColor must be string')
    }
    if (this._sunColor === value) return
    this._sunColor = value
    if (this.water) {
      this.water.material.uniforms['sunColor'].value.set(value)
    }
  }

  get sunDirection() {
    return this._sunDirection
  }

  set sunDirection(value = defaults.sunDirection) {
    if (!isArray(value) || value.length !== 3 || !value.every(isNumber)) {
      throw new Error('[water] sunDirection must be [x, y, z] array')
    }
    if (this._sunDirection && this._sunDirection[0] === value[0] && this._sunDirection[1] === value[1] && this._sunDirection[2] === value[2]) return
    this._sunDirection = value
    if (this.water) {
      this.water.material.uniforms['sunDirection'].value.fromArray(value)
    }
  }

  get distortionScale() {
    return this._distortionScale
  }

  set distortionScale(value = defaults.distortionScale) {
    if (!isNumber(value) || value < 0) {
      throw new Error('[water] distortionScale must be non-negative number')
    }
    if (this._distortionScale === value) return
    this._distortionScale = value
    if (this.water) {
      this.water.material.uniforms['distortionScale'].value = value
    }
  }

  get speed() {
    return this._speed
  }

  set speed(value = defaults.speed) {
    if (!isNumber(value)) {
      throw new Error('[water] speed must be number')
    }
    if (this._speed === value) return
    this._speed = value
  }

  get alpha() {
    return this._alpha
  }

  set alpha(value = defaults.alpha) {
    if (!isNumber(value) || value < 0 || value > 1) {
      throw new Error('[water] alpha must be number between 0 and 1')
    }
    if (this._alpha === value) return
    this._alpha = value
    if (this.water) {
      this.water.material.uniforms['alpha'].value = value
    }
  }

  get reflectivity() {
    return this._reflectivity
  }

  set reflectivity(value = defaults.reflectivity) {
    if (!isNumber(value) || value < 0 || value > 1) {
      throw new Error('[water] reflectivity must be number between 0 and 1')
    }
    if (this._reflectivity === value) return
    this._reflectivity = value
    if (this.water) {
      this.water.material.uniforms['reflectivity'].value = value
    }
  }

  get textureSize() {
    return this._textureSize
  }

  set textureSize(value = defaults.textureSize) {
    if (!isNumber(value) || value <= 0) {
      throw new Error('[water] textureSize must be positive number')
    }
    if (this._textureSize === value) return
    this._textureSize = value
    this.needsRebuild = true
    this.setDirty()
  }

  get normals() {
    return this._normals
  }

  set normals(value = defaults.normals) {
    if (value !== null && !isString(value)) {
      throw new Error('[water] normals must be string or null')
    }
    if (this._normals === value) return
    this._normals = value
    this.needsRebuild = true
    this.setDirty()
  }

  getProxy() {
    if (!this.proxy) {
      const self = this
      let proxy = {
        get width() {
          return self.width
        },
        set width(value) {
          self.width = value
        },
        get height() {
          return self.height
        },
        set height(value) {
          self.height = value
        },
        get color() {
          return self.color
        },
        set color(value) {
          self.color = value
        },
        get sunColor() {
          return self.sunColor
        },
        set sunColor(value) {
          self.sunColor = value
        },
        get sunDirection() {
          return self.sunDirection
        },
        set sunDirection(value) {
          self.sunDirection = value
        },
        get distortionScale() {
          return self.distortionScale
        },
        set distortionScale(value) {
          self.distortionScale = value
        },
        get speed() {
          return self.speed
        },
        set speed(value) {
          self.speed = value
        },
        get alpha() {
          return self.alpha
        },
        set alpha(value) {
          self.alpha = value
        },
        get textureSize() {
          return self.textureSize
        },
        set textureSize(value) {
          self.textureSize = value
        },
        get normals() {
          return self.normals
        },
        set normals(value) {
          self.normals = value
        },
        get reflectivity() {
          return self.reflectivity
        },
        set reflectivity(value) {
          self.reflectivity = value
        },
      }
      proxy = Object.defineProperties(proxy, Object.getOwnPropertyDescriptors(super.getProxy()))
      this.proxy = proxy
    }
    return this.proxy
  }
}
