import { System } from './System'
import { uuid } from '../utils'
import { hashFile } from '../utils-client'

function buildPlaceholderScript({ blueprintId }) {
  return `export default (world, app, fetch, props, setTimeout) => {
  // Draft placeholder: ${blueprintId}
  const cube = app.create('prim', {
    type: 'box',
    scale: [0.3, 0.3, 0.3],
    position: [0, 0.5, 0],
    color: '#ffffff',
    emissive: '#a78bfa',
    emissiveIntensity: 0.8,
    metalness: 0.2,
    roughness: 0.4,
  })
  app.add(cube)

  const aura = app.create('particles', {
    shape: ['sphere', 0.6, 1],
    rate: 30,
    life: '1.2~2.4',
    speed: '0.05~0.2',
    size: '0.2~0.5',
    color: '#ffffff',
    alpha: '0.4~0.8',
    emissive: '0.6~1',
    blending: 'additive',
    billboard: 'full',
    space: 'local',
  })
  aura.colorOverLife = '0,#5eead4|0.5,#a78bfa|1,#f0abfc'
  aura.alphaOverLife = '0,0|0.2,0.7|1,0'
  aura.sizeOverLife = '0,0.6|0.5,1|1,0.8'
  aura.position.set(0, 0.5, 0)
  app.add(aura)

  app.on('update', dt => {
    cube.rotation.y += dt * 0.8
    cube.rotation.x += dt * 0.4
  })
}
`
}

const DEFAULT_ENTRY = 'index.js'
const BLUEPRINT_ID_MAX_LENGTH = 80

function stripControlChars(value) {
  let output = ''
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code >= 32) output += value[i]
  }
  return output
}

function sanitizeBlueprintIdFromName(name) {
  if (typeof name !== 'string') return ''
  let safe = name.trim()
  if (!safe) return ''
  safe = stripControlChars(safe)
  safe = safe.replace(/[<>:"/\\|?*]/g, '')
  safe = safe.replace(/[^a-zA-Z0-9._ -]+/g, '-')
  safe = safe.replace(/\s+/g, ' ').trim()
  safe = safe.replace(/[. ]+$/g, '').replace(/^[. ]+/g, '')
  safe = safe.replace(/__+/g, '_')
  if (safe.length > BLUEPRINT_ID_MAX_LENGTH) {
    safe = safe.slice(0, BLUEPRINT_ID_MAX_LENGTH).trim()
  }
  return safe || ''
}

function trimBlueprintIdBase(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/[. ]+$/g, '').replace(/^[. ]+/g, '').trim()
}

function resolveUniqueDraftBlueprintId(world, preferredName) {
  const initialBase = sanitizeBlueprintIdFromName(preferredName) || 'Draft'
  const base = trimBlueprintIdBase(initialBase) || 'Draft'
  if (base !== '$scene' && !world.blueprints.get(base)) {
    return base
  }
  for (let i = 2; i < 10000; i += 1) {
    const suffix = `_${i}`
    const maxBaseLength = Math.max(1, BLUEPRINT_ID_MAX_LENGTH - suffix.length)
    const stem = trimBlueprintIdBase(base.slice(0, maxBaseLength)) || 'Draft'
    const candidate = `${stem}${suffix}`
    if (candidate === '$scene') continue
    if (!world.blueprints.get(candidate)) {
      return candidate
    }
  }
  return uuid()
}

export class ClientDrafts extends System {
  createDraftApp = async input => {
    const payload = typeof input === 'string' ? { name: input } : input || {}
    const name = typeof payload.name === 'string' ? payload.name.trim() : ''
    const props = payload.props && typeof payload.props === 'object' ? payload.props : {}
    return createPlaceholderApp({
      world: this.world,
      name: name || 'Draft',
      props,
    })
  }
}

async function createPlaceholderApp({ world, name, props }) {
  if (!world.builder?.canBuild?.()) {
    const err = new Error('builder_required')
    err.code = 'builder_required'
    throw err
  }
  if (!world.admin?.upload || !world.admin?.blueprintAdd || !world.admin?.acquireDeployLock) {
    const err = new Error('admin_required')
    err.code = 'admin_required'
    throw err
  }

  let lockToken = null
  let blueprint = null
  let app = null
  try {
    const blueprintId = resolveUniqueDraftBlueprintId(world, name)
    const scope = blueprintId
    const lockResult = await world.admin.acquireDeployLock({
      owner: world.network.id,
      scope,
    })
    lockToken = lockResult?.token || world.admin.deployLockToken

    const scriptText = buildPlaceholderScript({ blueprintId })
    const file = new File([scriptText], 'script.js', { type: 'text/javascript' })
    const hash = await hashFile(file)
    const scriptUrl = `asset://${hash}.js`
    await world.admin.upload(file)

    const resolvedUrl = world.resolveURL ? world.resolveURL(scriptUrl) : scriptUrl
    world.loader?.setFile?.(resolvedUrl, file)

    const createdAt = new Date().toISOString()
    const entryPath = DEFAULT_ENTRY
    const scriptFiles = { [entryPath]: scriptUrl }
    blueprint = {
      id: blueprintId,
      scope,
      version: 0,
      name: name || 'Draft',
      image: {
        url: 'asset://Model.png',
      },
      author: null,
      url: null,
      desc: null,
      model: 'asset://empty.glb',
      script: scriptUrl,
      scriptEntry: entryPath,
      scriptFiles,
      scriptFormat: 'module',
      createdAt,
      props: {
        createdAt,
        ...props,
      },
      preload: false,
      public: false,
      locked: false,
      frozen: false,
      unique: false,
      scene: false,
      disabled: false,
    }
    world.blueprints.add(blueprint)
    world.admin.blueprintAdd(blueprint, { ignoreNetworkId: world.network.id, lockToken })

    const transform = world.builder.getSpawnTransform(true)
    world.builder.toggle(true)
    world.builder.control.pointer.lock()
    await new Promise(resolve => setTimeout(resolve, 100))
    const appData = {
      id: uuid(),
      type: 'app',
      blueprint: blueprint.id,
      position: transform.position,
      quaternion: transform.quaternion,
      scale: [1, 1, 1],
      mover: world.network.id,
      uploader: null,
      pinned: false,
      props: {},
      state: {},
    }
    app = world.entities.add(appData)
    world.admin.entityAdd(appData, { ignoreNetworkId: world.network.id })
    world.builder.select(app)

    return { blueprintId: blueprint.id, appId: appData.id }
  } catch (err) {
    if (app) {
      app.destroy(true)
    }
    if (blueprint) {
      world.blueprints.remove(blueprint.id)
      world.admin
        ?.blueprintRemove?.(blueprint.id)
        .catch(removeErr => console.error('failed to remove blueprint', removeErr))
    }
    throw err
  } finally {
    if (lockToken && world.admin?.releaseDeployLock) {
      try {
        await world.admin.releaseDeployLock(lockToken)
      } catch (releaseErr) {
        console.error('failed to release deploy lock', releaseErr)
      }
    }
  }
}
