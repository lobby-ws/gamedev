import { isBoolean, isNumber, isString } from 'lodash-es'
import * as THREE from '../extras/three'
import { CSS3DObject } from 'three/examples/jsm/renderers/CSS3DRenderer.js'

import { Node } from './Node'

const defaults = {
  src: null,
  html: null,
  width: 1,
  height: 1,
  factor: 100,
  doubleside: false,
  space: 'world',
  pointerEvents: true,
}

const v1 = new THREE.Vector3()

export class WebView extends Node {
  constructor(data = {}) {
    super(data)
    this.name = 'webview'

    this.src = data.src
    this.html = data.html ?? data.srcdoc
    this.width = data.width
    this.height = data.height
    this.factor = data.factor
    this.doubleside = data.doubleside
    this.space = data.space
    this.pointerEvents = data.pointerEvents

    this.n = 0
  }

  copy(source, recursive) {
    super.copy(source, recursive)
    this._src = source._src
    this._html = source._html
    this._width = source._width
    this._height = source._height
    this._factor = source._factor
    this._doubleside = source._doubleside
    this._space = source._space
    this._pointerEvents = source._pointerEvents
    return this
  }

  mount() {
    this.build()
  }

  commit(didMove) {
    if (this.needsRebuild) {
      this.build()
      return
    }
    if (this._space === 'screen') {
      if (didMove && this.container) {
        this.updateScreenTransform()
      }
      return
    }
    if (didMove) {
      if (this.mesh) {
        this.mesh.matrixWorld.copy(this.matrixWorld)
      }
      if (this.sItem) {
        this.ctx.world.stage.octree.move(this.sItem)
      }
    }
  }

  unmount() {
    this.unbuild()
  }

  build() {
    this.needsRebuild = false
    if (this.ctx.world.network.isServer) return
    this.unbuild()

    if (this._space === 'screen') {
      this.buildScreen()
    } else {
      this.buildWorld()
    }
  }

  buildWorld() {
    const n = ++this.n
    const hasContent = this._src || this._html

    const geometry = new THREE.PlaneGeometry(this._width, this._height)
    const material = new THREE.MeshBasicMaterial({
      opacity: 0,
      color: new THREE.Color('black'),
      blending: hasContent ? THREE.NoBlending : THREE.NormalBlending,
      side: this._doubleside ? THREE.DoubleSide : THREE.FrontSide,
    })
    this.mesh = new THREE.Mesh(geometry, material)
    this.mesh.matrixWorld.copy(this.matrixWorld)
    this.mesh.matrixAutoUpdate = false
    this.mesh.matrixWorldAutoUpdate = false
    this.mesh.renderOrder = -1
    this.ctx.world.stage.scene.add(this.mesh)

    if (this._pointerEvents) {
      this.sItem = {
        matrix: this.matrixWorld,
        geometry,
        material,
        getEntity: () => this.ctx.entity,
        node: this,
      }
      this.ctx.world.stage.octree.insert(this.sItem)
    }

    if (!hasContent) return

    const widthPx = `${this._width * this._factor}px`
    const heightPx = `${this._height * this._factor}px`

    const container = document.createElement('div')
    container.style.width = widthPx
    container.style.height = heightPx

    const inner = document.createElement('div')
    inner.style.width = widthPx
    inner.style.height = heightPx
    inner.style.backgroundColor = '#000'

    const iframe = document.createElement('iframe')
    iframe.frameBorder = '0'
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'
    iframe.allowFullscreen = true
    iframe.style.width = widthPx
    iframe.style.height = heightPx
    iframe.style.border = '0px'
    iframe.style.pointerEvents = 'none'
    if (this._html) {
      iframe.srcdoc = this._html
    } else {
      iframe.src = this._src
    }

    container.appendChild(inner)
    inner.appendChild(iframe)

    this.objectCSS = new CSS3DObject(container)
    this.objectCSS.target = this.mesh
    this.mesh.updateMatrixWorld()
    this.mesh.matrixWorld.decompose(this.objectCSS.position, this.objectCSS.quaternion, v1)
    this.objectCSS.scale.setScalar(1 / this._factor)

    this.iframe = iframe
    this.inner = inner
    this.container = container

    const isDesktop =
      !this.ctx.world.network.isServer &&
      this.ctx.world.controls &&
      !/iPhone|iPad|iPod|Android/i.test(globalThis.navigator?.userAgent || '')

    if (!isDesktop && this._pointerEvents) {
      iframe.style.pointerEvents = 'auto'
    }

    inner.addEventListener('mouseenter', () => {
      if (isDesktop && this._pointerEvents) {
        this.objectCSS.interacting = true
        iframe.style.pointerEvents = 'auto'
      }
    })

    inner.addEventListener('mouseleave', () => {
      if (isDesktop && this._pointerEvents) {
        this.objectCSS.interacting = false
        iframe.style.pointerEvents = 'none'
      }
    })

    if (this.n !== n) return
    this.ctx.world.css?.add(this.objectCSS)
  }

  buildScreen() {
    const hasContent = this._src || this._html
    if (!hasContent) return
    if (!this.ctx.world.pointer?.ui) return

    const widthPx = this._width
    const heightPx = this._height

    const container = document.createElement('div')
    container.style.position = 'absolute'
    container.style.width = `${widthPx}px`
    container.style.height = `${heightPx}px`
    container.style.pointerEvents = this._pointerEvents ? 'auto' : 'none'

    const iframe = document.createElement('iframe')
    iframe.frameBorder = '0'
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'
    iframe.allowFullscreen = true
    iframe.style.width = '100%'
    iframe.style.height = '100%'
    iframe.style.border = '0px'
    if (this._html) {
      iframe.srcdoc = this._html
    } else {
      iframe.src = this._src
    }

    container.appendChild(iframe)

    this.container = container
    this.iframe = iframe

    this.updateScreenTransform()

    this.ctx.world.pointer.ui.prepend(container)
  }

  unbuild() {
    this.n++
    if (this.mesh) {
      this.ctx.world.stage.scene.remove(this.mesh)
      this.mesh.geometry.dispose()
      this.mesh.material.dispose()
      this.mesh = null
    }
    if (this.sItem) {
      this.ctx.world.stage.octree.remove(this.sItem)
      this.sItem = null
    }
    if (this.objectCSS) {
      this.ctx.world.css?.remove(this.objectCSS)
      this.objectCSS = null
    }
    if (this.container) {
      this.container.remove()
      this.container = null
    }
    this.iframe = null
    this.inner = null
  }

  updateScreenTransform() {
    const xPercent = this.position.x * 100
    const yPercent = this.position.y * 100
    const rotation = this.rotation.z || 0
    const scaleX = this.scale.x
    const scaleY = this.scale.y
    this.container.style.left = `${xPercent}%`
    this.container.style.top = `${yPercent}%`
    this.container.style.transform = `translate(-${xPercent}%, -${yPercent}%) rotate(${rotation}rad) scale(${scaleX}, ${scaleY})`
    this.container.style.zIndex = String(Math.floor(this.position.z || 0))
  }

  onPointerDown(e) {
    if (this._onPointerDown) {
      this._onPointerDown(e)
      if (e.defaultPrevented) return
    }
    if (this.ctx.world.builder?.enabled) return
    if (this.ctx.world.controls?.pointer?.locked) {
      this.ctx.world.controls.unlockPointer()
    }
  }

  get src() {
    return this._src
  }

  set src(value = defaults.src) {
    if (value !== null && !isString(value)) {
      throw new Error('[webview] src not null or string')
    }
    if (this._src === value) return
    this._src = value
    this.needsRebuild = true
    this.setDirty()
  }

  get html() {
    return this._html
  }

  set html(value = defaults.html) {
    if (value !== null && !isString(value)) {
      throw new Error('[webview] html not null or string')
    }
    if (this._html === value) return
    this._html = value
    this.needsRebuild = true
    this.setDirty()
  }

  get srcdoc() {
    return this._html
  }

  set srcdoc(value = defaults.html) {
    this.html = value
  }

  get width() {
    return this._width
  }

  set width(value = defaults.width) {
    if (!isNumber(value)) {
      throw new Error('[webview] width not a number')
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
    if (!isNumber(value)) {
      throw new Error('[webview] height not a number')
    }
    if (this._height === value) return
    this._height = value
    this.needsRebuild = true
    this.setDirty()
  }

  get factor() {
    return this._factor
  }

  set factor(value = defaults.factor) {
    if (!isNumber(value)) {
      throw new Error('[webview] factor not a number')
    }
    if (this._factor === value) return
    this._factor = value
    this.needsRebuild = true
    this.setDirty()
  }

  get doubleside() {
    return this._doubleside
  }

  set doubleside(value = defaults.doubleside) {
    if (!isBoolean(value)) {
      throw new Error('[webview] doubleside not a boolean')
    }
    if (this._doubleside === value) return
    this._doubleside = value
    this.needsRebuild = true
    this.setDirty()
  }

  get space() {
    return this._space
  }

  set space(value = defaults.space) {
    if (value !== 'world' && value !== 'screen') {
      throw new Error('[webview] space must be "world" or "screen"')
    }
    if (this._space === value) return
    this._space = value
    this.needsRebuild = true
    this.setDirty()
  }

  get pointerEvents() {
    return this._pointerEvents
  }

  set pointerEvents(value = defaults.pointerEvents) {
    if (!isBoolean(value)) {
      throw new Error('[webview] pointerEvents not a boolean')
    }
    if (this._pointerEvents === value) return
    this._pointerEvents = value
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
        get html() {
          return self.html
        },
        set html(value) {
          self.html = value
        },
        get srcdoc() {
          return self.srcdoc
        },
        set srcdoc(value) {
          self.srcdoc = value
        },
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
        get factor() {
          return self.factor
        },
        set factor(value) {
          self.factor = value
        },
        get doubleside() {
          return self.doubleside
        },
        set doubleside(value) {
          self.doubleside = value
        },
        get space() {
          return self.space
        },
        set space(value) {
          self.space = value
        },
        get pointerEvents() {
          return self.pointerEvents
        },
        set pointerEvents(value) {
          self.pointerEvents = value
        },
      }
      proxy = Object.defineProperties(proxy, Object.getOwnPropertyDescriptors(super.getProxy()))
      this.proxy = proxy
    }
    return this.proxy
  }
}
