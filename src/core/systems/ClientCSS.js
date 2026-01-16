import * as THREE from '../extras/three'
import { CSS3DRenderer } from 'three/examples/jsm/renderers/CSS3DRenderer.js'

import { System } from './System'

const v1 = new THREE.Vector3()

export class ClientCSS extends System {
  constructor(world) {
    super(world)
    this.scene = new THREE.Scene()
    this.renderer = null
    this.elem = null
  }

  async init({ cssLayer }) {
    if (!cssLayer) return
    this.elem = cssLayer
    this.renderer = new CSS3DRenderer({ element: this.elem })
  }

  start() {
    if (!this.elem) return
    this.world.graphics.on('resize', this.onResize)
    this.resize(this.world.graphics.width, this.world.graphics.height)
  }

  onResize = () => {
    this.resize(this.world.graphics.width, this.world.graphics.height)
  }

  resize(width, height) {
    if (!this.renderer) return
    this.renderer.setSize(width, height)
  }

  add(object) {
    this.scene.add(object)
  }

  remove(object) {
    this.scene.remove(object)
  }

  lateUpdate() {
    if (!this.renderer) return
    for (const objectCSS of this.scene.children) {
      if (!objectCSS.target) continue
      if (objectCSS.interacting) continue
      objectCSS.target.matrixWorld.decompose(objectCSS.position, objectCSS.quaternion, v1)
    }
  }

  render() {
    if (!this.renderer) return
    this.renderer.render(this.scene, this.world.camera)
  }

  destroy() {
    if (this.elem) {
      this.world.graphics.off('resize', this.onResize)
    }
  }
}
