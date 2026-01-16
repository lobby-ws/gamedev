import { isBoolean, isFunction, isNumber, isString } from 'lodash-es'
import * as THREE from '../extras/three'
import { CSS3DObject } from 'three/examples/jsm/renderers/CSS3DRenderer.js'

import { Node } from './Node'

const defaults = {
  value: '',
  placeholder: '',
  width: 200,
  height: 32,
  factor: 100,
  fontSize: 14,
  color: '#000000',
  backgroundColor: '#ffffff',
  borderWidth: 1,
  borderColor: '#cccccc',
  borderRadius: 4,
  padding: 8,
  disabled: false,
  type: 'text',
}

const v1 = new THREE.Vector3()

export class UIInput extends Node {
  constructor(data = {}) {
    super(data)
    this.name = 'uiinput'

    this.value = data.value
    this.placeholder = data.placeholder
    this.width = data.width
    this.height = data.height
    this.factor = data.factor
    this.fontSize = data.fontSize
    this.color = data.color
    this.backgroundColor = data.backgroundColor
    this.borderWidth = data.borderWidth
    this.borderColor = data.borderColor
    this.borderRadius = data.borderRadius
    this.padding = data.padding
    this.disabled = data.disabled
    this.type = data.type

    this._onFocus = data.onFocus
    this._onBlur = data.onBlur
    this._onChange = data.onChange
    this._onSubmit = data.onSubmit

    this.n = 0
  }

  copy(source, recursive) {
    super.copy(source, recursive)
    this._value = source._value
    this._placeholder = source._placeholder
    this._width = source._width
    this._height = source._height
    this._factor = source._factor
    this._fontSize = source._fontSize
    this._color = source._color
    this._backgroundColor = source._backgroundColor
    this._borderWidth = source._borderWidth
    this._borderColor = source._borderColor
    this._borderRadius = source._borderRadius
    this._padding = source._padding
    this._disabled = source._disabled
    this._type = source._type
    this._onFocus = source._onFocus
    this._onBlur = source._onBlur
    this._onChange = source._onChange
    this._onSubmit = source._onSubmit
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

    const n = ++this.n
    const widthM = this._width / this._factor
    const heightM = this._height / this._factor

    const geometry = new THREE.PlaneGeometry(widthM, heightM)
    const material = new THREE.MeshBasicMaterial({
      opacity: 0,
      color: new THREE.Color('black'),
      blending: THREE.NoBlending,
      side: THREE.FrontSide,
    })
    this.mesh = new THREE.Mesh(geometry, material)
    this.mesh.matrixWorld.copy(this.matrixWorld)
    this.mesh.matrixAutoUpdate = false
    this.mesh.matrixWorldAutoUpdate = false
    this.mesh.renderOrder = -1
    this.ctx.world.stage.scene.add(this.mesh)

    this.sItem = {
      matrix: this.matrixWorld,
      geometry,
      material,
      getEntity: () => this.ctx.entity,
      node: this,
    }
    this.ctx.world.stage.octree.insert(this.sItem)

    const widthPx = `${this._width}px`
    const heightPx = `${this._height}px`

    const container = document.createElement('div')
    container.style.width = widthPx
    container.style.height = heightPx

    const inner = document.createElement('div')
    inner.style.width = widthPx
    inner.style.height = heightPx
    inner.style.backgroundColor = this._backgroundColor

    const input = document.createElement('input')
    input.type = this._type
    input.value = this._value
    input.placeholder = this._placeholder
    input.disabled = this._disabled
    input.style.width = '100%'
    input.style.height = '100%'
    input.style.boxSizing = 'border-box'
    input.style.border = `${this._borderWidth}px solid ${this._borderColor}`
    input.style.borderRadius = `${this._borderRadius}px`
    input.style.padding = `${this._padding}px`
    input.style.fontSize = `${this._fontSize}px`
    input.style.color = this._color
    input.style.backgroundColor = this._backgroundColor
    input.style.outline = 'none'
    input.style.fontFamily = 'Rubik, sans-serif'
    input.style.pointerEvents = 'none'

    container.appendChild(inner)
    inner.appendChild(input)

    this.objectCSS = new CSS3DObject(container)
    this.objectCSS.target = this.mesh
    this.mesh.updateMatrixWorld()
    this.mesh.matrixWorld.decompose(this.objectCSS.position, this.objectCSS.quaternion, v1)
    this.objectCSS.scale.setScalar(1 / this._factor)

    this.input = input
    this.inner = inner
    this.container = container

    const isDesktop =
      !this.ctx.world.network.isServer &&
      this.ctx.world.controls &&
      !/iPhone|iPad|iPod|Android/i.test(globalThis.navigator?.userAgent || '')

    if (!isDesktop) {
      input.style.pointerEvents = 'auto'
    }

    container.addEventListener('pointerdown', e => {
      e.stopPropagation()
    })

    inner.addEventListener('mouseenter', () => {
      if (isDesktop) {
        this.objectCSS.interacting = true
        input.style.pointerEvents = 'auto'
      }
    })

    inner.addEventListener('mouseleave', () => {
      if (isDesktop && document.activeElement !== input) {
        this.objectCSS.interacting = false
        input.style.pointerEvents = 'none'
      }
    })

    input.addEventListener('focus', () => {
      this.objectCSS.interacting = true
      this._onFocus?.(this._value)
    })

    input.addEventListener('blur', () => {
      if (isDesktop) {
        this.objectCSS.interacting = false
        input.style.pointerEvents = 'none'
      }
      this._onBlur?.(this._value)
    })

    input.addEventListener('input', () => {
      this._value = input.value
      this._onChange?.(this._value)
    })

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault()
        this._onSubmit?.(this._value)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        input.blur()
      }
    })

    if (this.n !== n) return
    this.ctx.world.css?.add(this.objectCSS)
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
    this.input = null
    this.inner = null
    this.container = null
  }

  onPointerDown(e) {
    if (this._onPointerDown) {
      this._onPointerDown(e)
      if (e.defaultPrevented) return
    }
    if (this.ctx.world.builder?.enabled) return
    if (this._disabled) return
    if (this.ctx.world.controls?.pointer?.locked) {
      this.ctx.world.controls.unlockPointer()
    }
  }

  focus() {
    this.input?.focus()
  }

  blur() {
    this.input?.blur()
  }

  get value() {
    return this._value
  }

  set value(val = defaults.value) {
    if (isNumber(val)) {
      val = val + ''
    }
    if (!isString(val)) {
      throw new Error('[uiinput] value not a string')
    }
    if (this._value === val) return
    this._value = val
    if (this.input) {
      this.input.value = val
    }
  }

  get placeholder() {
    return this._placeholder
  }

  set placeholder(value = defaults.placeholder) {
    if (!isString(value)) {
      throw new Error('[uiinput] placeholder not a string')
    }
    if (this._placeholder === value) return
    this._placeholder = value
    if (this.input) {
      this.input.placeholder = value
    }
  }

  get width() {
    return this._width
  }

  set width(value = defaults.width) {
    if (!isNumber(value)) {
      throw new Error('[uiinput] width not a number')
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
      throw new Error('[uiinput] height not a number')
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
      throw new Error('[uiinput] factor not a number')
    }
    if (this._factor === value) return
    this._factor = value
    this.needsRebuild = true
    this.setDirty()
  }

  get fontSize() {
    return this._fontSize
  }

  set fontSize(value = defaults.fontSize) {
    if (!isNumber(value)) {
      throw new Error('[uiinput] fontSize not a number')
    }
    if (this._fontSize === value) return
    this._fontSize = value
    if (this.input) {
      this.input.style.fontSize = `${value}px`
    }
  }

  get color() {
    return this._color
  }

  set color(value = defaults.color) {
    if (!isString(value)) {
      throw new Error('[uiinput] color not a string')
    }
    if (this._color === value) return
    this._color = value
    if (this.input) {
      this.input.style.color = value
    }
  }

  get backgroundColor() {
    return this._backgroundColor
  }

  set backgroundColor(value = defaults.backgroundColor) {
    if (!isString(value)) {
      throw new Error('[uiinput] backgroundColor not a string')
    }
    if (this._backgroundColor === value) return
    this._backgroundColor = value
    if (this.input) {
      this.input.style.backgroundColor = value
    }
    if (this.inner) {
      this.inner.style.backgroundColor = value
    }
  }

  get borderWidth() {
    return this._borderWidth
  }

  set borderWidth(value = defaults.borderWidth) {
    if (!isNumber(value)) {
      throw new Error('[uiinput] borderWidth not a number')
    }
    if (this._borderWidth === value) return
    this._borderWidth = value
    if (this.input) {
      this.input.style.border = `${value}px solid ${this._borderColor}`
    }
  }

  get borderColor() {
    return this._borderColor
  }

  set borderColor(value = defaults.borderColor) {
    if (!isString(value)) {
      throw new Error('[uiinput] borderColor not a string')
    }
    if (this._borderColor === value) return
    this._borderColor = value
    if (this.input) {
      this.input.style.border = `${this._borderWidth}px solid ${value}`
    }
  }

  get borderRadius() {
    return this._borderRadius
  }

  set borderRadius(value = defaults.borderRadius) {
    if (!isNumber(value)) {
      throw new Error('[uiinput] borderRadius not a number')
    }
    if (this._borderRadius === value) return
    this._borderRadius = value
    if (this.input) {
      this.input.style.borderRadius = `${value}px`
    }
  }

  get padding() {
    return this._padding
  }

  set padding(value = defaults.padding) {
    if (!isNumber(value)) {
      throw new Error('[uiinput] padding not a number')
    }
    if (this._padding === value) return
    this._padding = value
    if (this.input) {
      this.input.style.padding = `${value}px`
    }
  }

  get disabled() {
    return this._disabled
  }

  set disabled(value = defaults.disabled) {
    if (!isBoolean(value)) {
      throw new Error('[uiinput] disabled not a boolean')
    }
    if (this._disabled === value) return
    this._disabled = value
    if (this.input) {
      this.input.disabled = value
    }
  }

  get type() {
    return this._type
  }

  set type(value = defaults.type) {
    if (!isString(value)) {
      throw new Error('[uiinput] type not a string')
    }
    if (this._type === value) return
    this._type = value
    if (this.input) {
      this.input.type = value
    }
  }

  get onFocus() {
    return this._onFocus
  }

  set onFocus(value) {
    if (value !== null && value !== undefined && !isFunction(value)) {
      throw new Error('[uiinput] onFocus not a function')
    }
    this._onFocus = value
  }

  get onBlur() {
    return this._onBlur
  }

  set onBlur(value) {
    if (value !== null && value !== undefined && !isFunction(value)) {
      throw new Error('[uiinput] onBlur not a function')
    }
    this._onBlur = value
  }

  get onChange() {
    return this._onChange
  }

  set onChange(value) {
    if (value !== null && value !== undefined && !isFunction(value)) {
      throw new Error('[uiinput] onChange not a function')
    }
    this._onChange = value
  }

  get onSubmit() {
    return this._onSubmit
  }

  set onSubmit(value) {
    if (value !== null && value !== undefined && !isFunction(value)) {
      throw new Error('[uiinput] onSubmit not a function')
    }
    this._onSubmit = value
  }

  getProxy() {
    if (!this.proxy) {
      const self = this
      let proxy = {
        get value() {
          return self.value
        },
        set value(v) {
          self.value = v
        },
        get placeholder() {
          return self.placeholder
        },
        set placeholder(v) {
          self.placeholder = v
        },
        get width() {
          return self.width
        },
        set width(v) {
          self.width = v
        },
        get height() {
          return self.height
        },
        set height(v) {
          self.height = v
        },
        get factor() {
          return self.factor
        },
        set factor(v) {
          self.factor = v
        },
        get fontSize() {
          return self.fontSize
        },
        set fontSize(v) {
          self.fontSize = v
        },
        get color() {
          return self.color
        },
        set color(v) {
          self.color = v
        },
        get backgroundColor() {
          return self.backgroundColor
        },
        set backgroundColor(v) {
          self.backgroundColor = v
        },
        get borderWidth() {
          return self.borderWidth
        },
        set borderWidth(v) {
          self.borderWidth = v
        },
        get borderColor() {
          return self.borderColor
        },
        set borderColor(v) {
          self.borderColor = v
        },
        get borderRadius() {
          return self.borderRadius
        },
        set borderRadius(v) {
          self.borderRadius = v
        },
        get padding() {
          return self.padding
        },
        set padding(v) {
          self.padding = v
        },
        get disabled() {
          return self.disabled
        },
        set disabled(v) {
          self.disabled = v
        },
        get type() {
          return self.type
        },
        set type(v) {
          self.type = v
        },
        get onFocus() {
          return self.onFocus
        },
        set onFocus(v) {
          self.onFocus = v
        },
        get onBlur() {
          return self.onBlur
        },
        set onBlur(v) {
          self.onBlur = v
        },
        get onChange() {
          return self.onChange
        },
        set onChange(v) {
          self.onChange = v
        },
        get onSubmit() {
          return self.onSubmit
        },
        set onSubmit(v) {
          self.onSubmit = v
        },
        focus() {
          self.focus()
        },
        blur() {
          self.blur()
        },
      }
      proxy = Object.defineProperties(proxy, Object.getOwnPropertyDescriptors(super.getProxy()))
      this.proxy = proxy
    }
    return this.proxy
  }
}
