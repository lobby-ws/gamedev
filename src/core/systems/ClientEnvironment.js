import * as THREE from '../extras/three'

import { System } from './System'

import { CSM } from '../libs/csm/CSM'
import { isNumber, isString } from 'lodash-es'

const csmLevels = {
  none: {
    cascades: 1,
    shadowMapSize: 1024,
    castShadow: false,
    lightIntensity: 3,
    // shadowBias: 0.000002,
    // shadowNormalBias: 0.001,
  },
  low: {
    cascades: 1,
    shadowMapSize: 2048,
    castShadow: true,
    lightIntensity: 3,
    shadowBias: 0.0000009,
    shadowNormalBias: 0.001,
  },
  med: {
    cascades: 3,
    shadowMapSize: 1024,
    castShadow: true,
    lightIntensity: 1,
    shadowBias: 0.000002,
    shadowNormalBias: 0.002,
  },
  high: {
    cascades: 3,
    shadowMapSize: 2048,
    castShadow: true,
    lightIntensity: 1,
    shadowBias: 0.000003,
    shadowNormalBias: 0.002,
  },
}

// fix fog distance calc
// see: https://github.com/mrdoob/three.js/issues/14601
// future: https://www.youtube.com/watch?v=k1zGz55EqfU
THREE.ShaderChunk.fog_vertex = `
#ifdef USE_FOG

  // original
  // vFogDepth = - mvPosition.z;

  // radial distance
  vFogDepth = length( mvPosition );

  // cylindrical (ignore altitude)
  // vFogDepth = length( mvPosition.xz );

  // height-based (eg ground fog)
  // vFogDepth = abs( mvPosition.y );

#endif
`

/**
 * Environment System
 *
 * - Runs on the client
 * - Sets up the sky, hdr, sun, shadows, fog etc
 *
 */
const skyVertexShader = `
varying vec3 vPosition;
varying vec2 vUv;
void main() {
  vPosition = position;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

function buildSkyFragmentShader(userCode) {
  return `
varying vec3 vPosition;
varying vec2 vUv;
uniform float uTime;
uniform vec2 uResolution;
void main() {
  vec3 direction = normalize(vPosition);
  vec3 color = vec3(0.0);
  float alpha = 1.0;
  ${userCode}
  gl_FragColor = vec4(color, alpha);
}
`
}

function buildShaderUniforms(userUniforms) {
  const uniforms = {
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2() },
  }
  if (!userUniforms) return uniforms
  for (const key in userUniforms) {
    const v = userUniforms[key]
    if (typeof v === 'number') {
      uniforms[key] = { value: v }
    } else if (Array.isArray(v)) {
      if (v.length === 2) uniforms[key] = { value: new THREE.Vector2(v[0], v[1]) }
      else if (v.length === 3) uniforms[key] = { value: new THREE.Vector3(v[0], v[1], v[2]) }
      else if (v.length === 4) uniforms[key] = { value: new THREE.Vector4(v[0], v[1], v[2], v[3]) }
    }
  }
  return uniforms
}

export class ClientEnvironment extends System {
  constructor(world) {
    super(world)

    this.model = null
    this.skys = []
    this.sky = null
    this.skyN = 0
    this.bgUrl = null
    this.hdrUrl = null
    this.skyShaderMaterial = null
    this.skyBasicMaterial = null
    this.skyElapsed = 0
  }

  init({ baseEnvironment }) {
    this.base = baseEnvironment
  }

  async start() {
    this.buildCSM()
    this.updateSky()

    this.world.prefs.on('change', this.onPrefsChange)
    this.world.graphics.on('resize', this.onViewportResize)
  }

  addSky(node) {
    const handle = {
      node,
      destroy: () => {
        const idx = this.skys.indexOf(handle)
        if (idx === -1) return
        this.skys.splice(idx, 1)
        this.updateSky()
      },
    }
    this.skys.push(handle)
    this.updateSky()
    return handle
  }

  getSky() {
    // ...
  }

  async updateSky() {
    if (!this.sky) {
      const geometry = new THREE.SphereGeometry(1000, 60, 40)
      const material = new THREE.MeshBasicMaterial({ side: THREE.BackSide })
      this.sky = new THREE.Mesh(geometry, material)
      this.sky.geometry.computeBoundsTree()
      this.sky.material.fog = false
      this.sky.material.toneMapped = false
      this.sky.material.needsUpdate = true
      this.sky.matrixAutoUpdate = false
      this.sky.matrixWorldAutoUpdate = false
      this.sky.visible = false
      this.world.stage.scene.add(this.sky)
    }

    const base = this.base
    const node = this.skys[this.skys.length - 1]?.node
    const shaderCode = node?._shader || null
    const shaderUniforms = node?._shaderUniforms || null
    const bgUrl = node?._bg || base.bg
    const hdrUrl = node?._hdr || base.hdr
    const rotationY = isNumber(node?._rotationY) ? node._rotationY : base.rotationY
    const sunDirection = node?._sunDirection || base.sunDirection
    const sunIntensity = isNumber(node?._sunIntensity) ? node._sunIntensity : base.sunIntensity
    const sunColor = isString(node?._sunColor) ? node._sunColor : base.sunColor
    const fogNear = isNumber(node?._fogNear) ? node._fogNear : base.fogNear
    const fogFar = isNumber(node?._fogFar) ? node._fogFar : base.fogFar
    const fogColor = isString(node?._fogColor) ? node._fogColor : base.fogColor

    const n = ++this.skyN
    let bgTexture
    if (bgUrl) bgTexture = await this.world.loader.load('texture', bgUrl)
    let hdrTexture
    if (hdrUrl) hdrTexture = await this.world.loader.load('hdr', hdrUrl)
    if (n !== this.skyN) return

    if (shaderCode) {
      if (this.skyShaderMaterial) {
        this.skyShaderMaterial.dispose()
        this.skyShaderMaterial = null
      }
      try {
        const uniforms = buildShaderUniforms(shaderUniforms)
        const material = new THREE.ShaderMaterial({
          vertexShader: skyVertexShader,
          fragmentShader: buildSkyFragmentShader(shaderCode),
          uniforms,
          side: THREE.BackSide,
          depthWrite: false,
        })
        material.fog = false
        material.toneMapped = false
        const renderer = this.world.graphics.renderer
        if (!renderer) {
          material.dispose()
          this.sky.visible = false
        } else {
          const prevOnError = renderer.debug.onShaderError
          let compileError = null
          renderer.debug.onShaderError = (gl, program, vs, fs) => {
            const fsLog = gl.getShaderInfoLog(fs)
            const vsLog = gl.getShaderInfoLog(vs)
            compileError = fsLog || vsLog || 'unknown shader error'
          }
          const testScene = new THREE.Scene()
          const testCamera = new THREE.Camera()
          const testMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material)
          testScene.add(testMesh)
          renderer.compile(testScene, testCamera)
          renderer.debug.onShaderError = prevOnError
          testMesh.geometry.dispose()
          if (compileError) {
            console.warn('[sky] shader compile error:', compileError)
            material.dispose()
            this.sky.visible = false
          } else {
            if (!this.skyBasicMaterial) {
              this.skyBasicMaterial = this.sky.material
            }
            this.skyShaderMaterial = material
            this.sky.material = this.skyShaderMaterial
            this.sky.visible = true
          }
        }
      } catch (err) {
        console.warn('[sky] shader error:', err)
        this.sky.visible = false
      }
    } else if (bgTexture) {
      if (this.skyBasicMaterial) {
        this.sky.material = this.skyBasicMaterial
      }
      if (this.skyShaderMaterial) {
        this.skyShaderMaterial.dispose()
        this.skyShaderMaterial = null
      }
      bgTexture.minFilter = bgTexture.magFilter = THREE.LinearFilter
      bgTexture.mapping = THREE.EquirectangularReflectionMapping
      bgTexture.colorSpace = THREE.SRGBColorSpace
      this.sky.material.map = bgTexture
      this.sky.visible = true
    } else {
      if (this.skyBasicMaterial) {
        this.sky.material = this.skyBasicMaterial
      }
      if (this.skyShaderMaterial) {
        this.skyShaderMaterial.dispose()
        this.skyShaderMaterial = null
      }
      this.sky.visible = false
    }

    if (hdrTexture) {
      // hdrTexture.colorSpace = THREE.NoColorSpace
      // hdrTexture.colorSpace = THREE.SRGBColorSpace
      // hdrTexture.colorSpace = THREE.LinearSRGBColorSpace
      hdrTexture.mapping = THREE.EquirectangularReflectionMapping
      this.world.stage.scene.environment = hdrTexture
    }

    this.world.stage.scene.environmentRotation.y = rotationY
    this.sky.rotation.y = rotationY
    this.sky.matrixWorld.compose(this.sky.position, this.sky.quaternion, this.sky.scale)

    this.csm.lightDirection = sunDirection

    for (const light of this.csm.lights) {
      light.intensity = sunIntensity
      light.color.set(sunColor)
    }

    if (isNumber(fogNear) && isNumber(fogFar) && fogColor) {
      const color = new THREE.Color(fogColor)
      this.world.stage.scene.fog = new THREE.Fog(color, fogNear, fogFar)
    } else {
      this.world.stage.scene.fog = null
    }

    this.skyInfo = {
      bgUrl,
      hdrUrl,
      rotationY,
      sunDirection,
      sunIntensity,
      sunColor,
      fogNear,
      fogFar,
      fogColor,
    }
  }

  update(delta) {
    this.csm.update()
    if (this.skyShaderMaterial) {
      this.skyElapsed += delta
      this.skyShaderMaterial.uniforms.uTime.value = this.skyElapsed
      const renderer = this.world.graphics.renderer
      if (renderer) {
        this.skyShaderMaterial.uniforms.uResolution.value.set(
          renderer.domElement.width,
          renderer.domElement.height
        )
      }
    }
  }

  lateUpdate(delta) {
    this.sky.position.x = this.world.rig.position.x
    this.sky.position.z = this.world.rig.position.z
    this.sky.matrixWorld.setPosition(this.sky.position)
    // this.sky.matrixWorld.copyPosition(this.world.rig.matrixWorld)
  }

  buildCSM() {
    const options = csmLevels[this.world.prefs.shadows]
    if (this.csm) {
      this.csm.updateCascades(options.cascades)
      this.csm.updateShadowMapSize(options.shadowMapSize)
      this.csm.lightDirection = this.skyInfo.sunDirection
      for (const light of this.csm.lights) {
        light.intensity = this.skyInfo.sunIntensity
        light.color.set(this.skyInfo.sunColor)
        light.castShadow = options.castShadow
      }
    } else {
      const scene = this.world.stage.scene
      const camera = this.world.camera
      this.csm = new CSM({
        mode: 'practical', // uniform, logarithmic, practical, custom
        // mode: 'custom',
        // customSplitsCallback: function (cascadeCount, nearDistance, farDistance) {
        //   return [0.05, 0.2, 0.5]
        // },
        cascades: 3,
        maxCascades: 3,
        shadowMapSize: 2048,
        maxFar: 100,
        lightIntensity: 1,
        lightDirection: new THREE.Vector3(0, -1, 0).normalize(),
        fade: true,
        parent: scene,
        camera: camera,
        // note: you can play with bias in console like this:
        // var csm = world.graphics.csm
        // csm.shadowBias = 0.00001
        // csm.shadowNormalBias = 0.002
        // csm.updateFrustums()
        // shadowBias: 0.00001,
        // shadowNormalBias: 0.002,
        // lightNear: 0.0000001,
        // lightFar: 5000,
        // lightMargin: 200,
        // noLastCascadeCutOff: true,
        ...options,
        // note: you can test changes in console and then call csm.updateFrustrums() to debug
      })
      if (!options.castShadow) {
        for (const light of this.csm.lights) {
          light.castShadow = false
        }
      }
    }
  }

  onPrefsChange = changes => {
    if (changes.shadows) {
      this.buildCSM()
      this.updateSky()
    }
  }

  onViewportResize = () => {
    this.csm.updateFrustums()
  }
}
