import { System } from './System'
import { uuid } from '../utils'
import { hashFile } from '../utils-client'

const PLACEHOLDER_SCRIPT = `export default (world, app, fetch, props, setTimeout) => {
  // AI placeholder while generation runs
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
}
`
const DEFAULT_ENTRY = 'index.js'

function normalizePrompt(value) {
  if (typeof value !== 'string') return ''
  return value.trim()
}

function normalizeAttachments(input) {
  if (!Array.isArray(input)) return null
  const output = []
  const seen = new Set()
  for (const item of input) {
    if (!item) continue
    const type = item.type === 'doc' || item.type === 'script' ? item.type : null
    const path = typeof item.path === 'string' ? item.path.trim() : ''
    if (!type || !path) continue
    const key = `${type}:${path}`
    if (seen.has(key)) continue
    seen.add(key)
    output.push({ type, path })
    if (output.length >= 12) break
  }
  return output.length ? output : null
}

export class ClientAI extends System {
  constructor(world) {
    super(world)
    this.enabled = false
    this.provider = null
    this.model = null
    this.effort = null
  }

  deserialize(data) {
    if (!data || typeof data !== 'object') {
      this.enabled = false
      this.provider = null
      this.model = null
      this.effort = null
      return
    }
    this.enabled = !!data.enabled
    this.provider = data.provider || null
    this.model = data.model || null
    this.effort = data.effort || null
  }

  createFromPrompt = async input => {
    const payload = typeof input === 'string' ? { prompt: input } : input || {}
    const trimmed = normalizePrompt(payload.prompt)
    if (!trimmed) {
      const err = new Error('missing_prompt')
      err.code = 'missing_prompt'
      throw err
    }
    if (!this.enabled) {
      const err = new Error('ai_disabled')
      err.code = 'ai_disabled'
      throw err
    }
    if (!this.world.builder?.canBuild?.()) {
      const err = new Error('builder_required')
      err.code = 'builder_required'
      throw err
    }
    if (!this.world.admin?.upload || !this.world.admin?.blueprintAdd || !this.world.admin?.acquireDeployLock) {
      const err = new Error('admin_required')
      err.code = 'admin_required'
      throw err
    }

    const normalizedAttachments = normalizeAttachments(payload.attachments)
    const scriptRootId = typeof payload.scriptRootId === 'string' ? payload.scriptRootId.trim() : ''
    let lockToken = null
    let blueprint = null
    let app = null
    try {
      const blueprintId = uuid()
      const scope = blueprintId
      const lockResult = await this.world.admin.acquireDeployLock({
        owner: this.world.network.id,
        scope,
      })
      lockToken = lockResult?.token || this.world.admin.deployLockToken

      const file = new File([PLACEHOLDER_SCRIPT], 'script.js', { type: 'text/javascript' })
      const hash = await hashFile(file)
      const scriptUrl = `asset://${hash}.js`
      await this.world.admin.upload(file)

      const resolvedUrl = this.world.resolveURL ? this.world.resolveURL(scriptUrl) : scriptUrl
      this.world.loader?.setFile?.(resolvedUrl, file)

      const createdAt = this.world.network?.getTime?.() ?? Date.now() / 1000
      const entryPath = DEFAULT_ENTRY
      const scriptFiles = { [entryPath]: scriptUrl }
      blueprint = {
        id: blueprintId,
        scope,
        version: 0,
        name: 'AI Draft',
        image: null,
        author: null,
        url: null,
        desc: null,
        model: 'asset://empty.glb',
        script: scriptUrl,
        scriptEntry: entryPath,
        scriptFiles,
        scriptFormat: 'module',
        props: {
          prompt: trimmed.length > 100 ? `${trimmed.slice(0, 100)}...` : trimmed,
          createdAt,
        },
        preload: false,
        public: false,
        locked: false,
        frozen: false,
        unique: false,
        scene: false,
        disabled: false,
      }
      this.world.blueprints.add(blueprint)
      this.world.admin.blueprintAdd(blueprint, { ignoreNetworkId: this.world.network.id, lockToken })

      const transform = this.world.builder.getSpawnTransform(true)
      this.world.builder.toggle(true)
      this.world.builder.control.pointer.lock()
      await new Promise(resolve => setTimeout(resolve, 100))
      const appData = {
        id: uuid(),
        type: 'app',
        blueprint: blueprint.id,
        position: transform.position,
        quaternion: transform.quaternion,
        scale: [1, 1, 1],
        mover: this.world.network.id,
        uploader: null,
        pinned: false,
        props: {},
        state: {},
      }
      app = this.world.entities.add(appData)
      this.world.admin.entityAdd(appData, { ignoreNetworkId: this.world.network.id })
      this.world.builder.select(app)

      const request = {
        blueprintId: blueprint.id,
        appId: appData.id,
        prompt: trimmed,
      }
      if (normalizedAttachments) {
        request.attachments = normalizedAttachments
      }
      if (scriptRootId) {
        request.scriptRootId = scriptRootId
      }
      this.world.network.send('aiCreateRequest', request)

      return { blueprintId: blueprint.id, appId: appData.id }
    } catch (err) {
      if (app) {
        app.destroy(true)
      }
      if (blueprint) {
        this.world.blueprints.remove(blueprint.id)
        this.world.admin
          ?.blueprintRemove?.(blueprint.id)
          .catch(removeErr => console.error('failed to remove blueprint', removeErr))
      }
      throw err
    } finally {
      if (lockToken && this.world.admin?.releaseDeployLock) {
        try {
          await this.world.admin.releaseDeployLock(lockToken)
        } catch (releaseErr) {
          console.error('failed to release deploy lock', releaseErr)
        }
      }
    }
  }
}
