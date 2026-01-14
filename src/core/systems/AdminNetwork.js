import { readPacket, writePacket } from '../packets'
import { storage } from '../storage'
import { uuid } from '../utils'
import { System } from './System'

function normalizeAdminUrl(url) {
  if (!url) return null
  return url.replace(/\/admin\/?$/, '')
}

function toWsUrl(baseUrl) {
  const wsBase = baseUrl.replace(/^http/, 'ws')
  return `${wsBase.replace(/\/$/, '')}/admin`
}

export class AdminNetwork extends System {
  constructor(world) {
    super(world)
    this.ws = null
    this.adminUrl = null
    this.connected = false
    this.authenticated = false
    this.error = null
    this.queue = []
    this.id = uuid()
    this.isClient = true
    this.serverTimeOffset = 0
    this.maxUploadSize = null
    this.subscriptions = { snapshot: true, players: false, runtime: false }
  }

  init({ adminUrl, adminCode, subscriptions } = {}) {
    this.adminUrl = normalizeAdminUrl(adminUrl)
    this.code = adminCode || storage.get('adminCode') || null
    if (subscriptions && typeof subscriptions === 'object') {
      this.subscriptions = {
        snapshot: !!subscriptions.snapshot,
        players: !!subscriptions.players,
        runtime: !!subscriptions.runtime,
      }
    }
    const playerId = this.world.entities.player?.data?.id
    if (playerId) this.id = playerId
    this.world.on('admin-code', this.onAdminCode)
  }

  start() {
    this.connect()
  }

  preFixedUpdate() {
    this.flush()
  }

  connect() {
    if (this.ws || !this.adminUrl) return
    const wsUrl = toWsUrl(this.adminUrl)
    this.ws = new WebSocket(wsUrl)
    this.ws.binaryType = 'arraybuffer'
    this.ws.addEventListener('open', this.onOpen)
    this.ws.addEventListener('message', this.onPacket)
    this.ws.addEventListener('close', this.onClose)
    this.ws.addEventListener('error', this.onError)
  }

  disconnect() {
    if (!this.ws) return
    this.ws.removeEventListener('open', this.onOpen)
    this.ws.removeEventListener('message', this.onPacket)
    this.ws.removeEventListener('close', this.onClose)
    this.ws.removeEventListener('error', this.onError)
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close()
    }
    this.ws = null
    this.connected = false
    this.authenticated = false
  }

  setCode(code) {
    this.onAdminCode(code)
  }

  setSubscriptions(subscriptions) {
    if (!subscriptions || typeof subscriptions !== 'object') return
    const next = {
      snapshot: !!subscriptions.snapshot,
      players: !!subscriptions.players,
      runtime: !!subscriptions.runtime,
    }
    const wasPlayers = this.subscriptions.players
    this.subscriptions = next
    if (wasPlayers && !next.players) {
      const players = Array.from(this.world.entities.players.values())
      for (const player of players) {
        this.world.entities.remove(player.data.id)
      }
    }
    this.disconnect()
    this.connect()
  }

  onAdminCode = code => {
    this.code = code || null
    storage.set('adminCode', this.code)
    this.disconnect()
    this.connect()
  }

  onOpen = () => {
    this.connected = true
    this.authenticated = false
    this.error = null
    if (!this.ws) return
    this.ws.send(
      writePacket('adminAuth', {
        code: this.code,
        subscriptions: this.subscriptions,
        networkId: this.id,
      })
    )
  }

  onPacket = event => {
    const [method, data] = readPacket(event.data)
    if (!method) return
    this.enqueue(method, data)
  }

  onClose = () => {
    this.connected = false
    this.authenticated = false
    this.ws = null
  }

  onError = () => {
    this.error = 'connection_error'
    this.world.emit('admin-auth', { ok: false, error: this.error })
  }

  enqueue(method, data) {
    this.queue.push([method, data])
  }

  flush() {
    while (this.queue.length) {
      const [method, data] = this.queue.shift()
      try {
        this[method]?.(data)
      } catch (err) {
        console.error(err)
      }
    }
  }

  getTime() {
    return (performance.now() + this.serverTimeOffset) / 1000
  }

  send() {
    // admin clients do not send gameplay packets over /admin
  }

  onAdminAuthOk = () => {
    this.authenticated = true
    this.error = null
    this.world.emit('admin-auth', { ok: true })
  }

  onAdminAuthError = data => {
    this.authenticated = false
    this.error = data?.error || 'auth_error'
    this.world.emit('admin-auth', { ok: false, error: this.error })
  }

  onSnapshot = data => {
    this.serverTimeOffset = data.serverTime - performance.now()
    this.maxUploadSize = data.maxUploadSize
    this.world.assetsUrl = data.assetsUrl
    this.world.settings.deserialize(data.settings)
    this.world.settings.setHasAdminCode(!!data.hasAdminCode)

    this.world.blueprints.destroy()
    this.world.entities.destroy()

    this.world.blueprints.deserialize(data.blueprints)
    this.world.entities.deserialize(data.entities)

    for (const player of data.players || []) {
      this.world.entities.add({
        id: player.id,
        type: 'player',
        position: player.position,
        quaternion: player.quaternion,
        name: player.name,
        avatar: player.avatar,
        sessionAvatar: player.sessionAvatar,
        rank: player.rank,
        enteredAt: player.enteredAt,
      })
    }

    if (data.spawn) {
      this.spawn = data.spawn
      this.world.freeCam?.setSpawn?.(data.spawn)
    }

    this.world.admin?.onSnapshot?.(data)
    this.world.emit('ready', true)
  }

  onEntityAdded = data => {
    const payload = data?.entity || data
    if (!payload) return
    this.world.entities.add(payload)
  }

  onEntityModified = data => {
    const payload = data?.entity || data
    if (!payload) return
    const entity = this.world.entities.get(payload.id)
    if (!entity) return console.error('onEntityModified: no entity found', payload)
    entity.modify(payload)
  }

  onEntityRemoved = data => {
    const id = data?.id || data
    if (!id) return
    this.world.entities.remove(id)
  }

  onBlueprintAdded = data => {
    const payload = data?.blueprint || data
    if (!payload) return
    this.world.blueprints.add(payload)
  }

  onBlueprintModified = data => {
    const payload = data?.blueprint || data
    if (!payload) return
    this.world.blueprints.modify(payload)
  }

  onSettingsModified = data => {
    const payload = data?.data || data
    if (!payload) return
    this.world.settings.set(payload.key, payload.value)
  }

  onSpawnModified = data => {
    const payload = data?.spawn || data
    if (!payload) return
    this.spawn = payload
  }

  onPlayerJoined = data => {
    if (!data?.id) return
    const existing = this.world.entities.get(data.id)
    if (existing) {
      existing.modify({
        name: data.name,
        avatar: data.avatar,
        sessionAvatar: data.sessionAvatar,
        rank: data.rank,
        position: data.position,
        quaternion: data.quaternion,
        enteredAt: data.enteredAt,
      })
      return
    }
    this.world.entities.add({
      id: data.id,
      type: 'player',
      position: data.position,
      quaternion: data.quaternion,
      name: data.name,
      avatar: data.avatar,
      sessionAvatar: data.sessionAvatar,
      rank: data.rank,
      enteredAt: data.enteredAt,
    })
  }

  onPlayerUpdated = data => {
    if (!data?.id) return
    const entity = this.world.entities.get(data.id)
    if (!entity) return
    entity.modify({
      position: data.position,
      quaternion: data.quaternion,
      name: data.name,
      avatar: data.avatar,
      sessionAvatar: data.sessionAvatar,
      rank: data.rank,
    })
  }

  onPlayerLeft = data => {
    const id = data?.id || data
    if (!id) return
    this.world.entities.remove(id)
  }

  destroy() {
    this.disconnect()
    this.world.off('admin-code', this.onAdminCode)
  }
}
