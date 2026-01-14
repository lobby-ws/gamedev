import { System } from './System'
import { uuid } from '../utils'

/**
 * AI System
 *
 * - Runs on the client
 * - /create <desc> to prompt an app into existence
 * - /edit <desc> to edit the app you are looking at
 * - /fix to send the error stack of a crashed app to ai to fix
 *
 */
export class ClientAI extends System {
  constructor(world) {
    super(world)
  }

  init() {
    this.world.chat.bindCommand('create', this.create)
    this.world.chat.bindCommand('edit', this.edit)
    this.world.chat.bindCommand('fix', this.fix)
  }

  deserialize(data) {
    this.enabled = data.enabled
    this.provider = data.provider
    this.model = data.model
    this.effort = data.effort
    console.log('[ai]', data)
  }

  create = async ({ value: prompt }) => {
    if (!this.enabled) {
      return console.error('[ai] not enabled')
    }
    if (!this.world.builder.canBuild()) return
    // create blueprint
    const blueprint = {
      id: uuid(),
      version: 0,
      name: 'Model',
      image: null,
      author: 'Claude',
      url: null,
      desc: null,
      model: 'asset://ai.glb',
      script: 'asset://ai.js',
      props: {
        prompt: prompt.length > 100 ? prompt.slice(0, 100) + '...' : prompt,
        createdAt: this.world.network.getTime(),
      },
      preload: false,
      public: false,
      locked: false,
      unique: false,
      disabled: false,
    }
    this.world.blueprints.add(blueprint)
    this.world.admin.blueprintAdd(blueprint, { ignoreNetworkId: this.world.network.id })
    const transform = this.world.builder.getSpawnTransform(true)
    this.world.builder.toggle(true)
    this.world.builder.control.pointer.lock()
    // wait a tick
    await new Promise(resolve => setTimeout(resolve, 100))
    // create app
    const appData = {
      id: uuid(),
      type: 'app',
      blueprint: blueprint.id,
      position: transform.position,
      quaternion: transform.quaternion,
      scale: [1, 1, 1],
      mover: null, // this.world.network.id,
      uploader: null,
      pinned: false,
      props: {},
      state: {},
    }
    const app = this.world.entities.add(appData)
    // this.world.builder.select(app)

    // send to server
    const action = {
      name: 'create',
      blueprintId: blueprint.id,
      appId: appData.id,
      prompt,
    }
    console.log('[ai] creating', action)
    this.world.admin.entityAdd(appData, { ignoreNetworkId: this.world.network.id })
    this.world.network.send('ai', action)
  }

  edit = async ({ value: prompt }) => {
    if (!this.enabled) {
      return console.error('[ai] not enabled')
    }
    if (!this.world.builder.canBuild()) {
      return console.error('[ai] not a builder')
    }
    const entity = this.world.builder.getEntityAtReticle()
    if (!entity || !entity.isApp || entity.blueprint.scene) {
      return console.error('[ai] no app found at reticle')
    }
    // send to server
    const action = {
      name: 'edit',
      blueprintId: entity.data.blueprint,
      appId: entity.data.id,
      prompt,
    }
    this.world.network.send('ai', action)
    console.log('[ai] editing', action)
  }

  fix = async () => {
    if (!this.enabled) {
      return console.error('[ai] not enabled')
    }
    if (!this.world.builder.canBuild()) {
      return console.error('[ai] not a builder')
    }
    const entity = this.world.builder.getEntityAtReticle()
    if (!entity || !entity.isApp || entity.blueprint.scene) {
      return console.error('[ai] no app found at reticle')
    }
    if (!entity.scriptError) {
      return console.error('[ai] no script error to fix')
    }
    // send to server
    const action = {
      name: 'fix',
      blueprintId: entity.data.blueprint,
      appId: entity.data.id,
      error: entity.scriptError,
    }
    this.world.network.send('ai', action)
    console.log('[ai] fixing', action)
  }
}
