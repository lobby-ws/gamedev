import moment from 'moment'
import { writePacket } from '../packets'
import { Socket } from '../Socket'
import { uuid } from '../utils'
import { System } from './System'
import { createJWT, readJWT } from '../utils-server'
import { cloneDeep, isNumber } from 'lodash-es'
import * as THREE from '../extras/three'
import { Ranks } from '../extras/ranks'

const SAVE_INTERVAL = parseInt(process.env.SAVE_INTERVAL || '60') // seconds
const PING_RATE = 10 // seconds
const defaultSpawn = '{ "position": [0, 0, 0], "quaternion": [0, 0, 0, 1] }'

const HEALTH_MAX = 100
const PUBLIC_ADMIN_URL =
  process.env.PUBLIC_ADMIN_URL || (process.env.PUBLIC_API_URL || '').replace(/\/api\/?$/, '')

/**
 * Server Network System
 *
 * - runs on the server
 * - provides abstract network methods matching ClientNetwork
 *
 */
export class ServerNetwork extends System {
  constructor(world) {
    super(world)
    this.id = 0
    this.ids = -1
    this.sockets = new Map()
    this.socketIntervalId = setInterval(() => this.checkSockets(), PING_RATE * 1000)
    this.saveTimerId = null
    this.dirtyBlueprints = new Set()
    this.dirtyApps = new Set()
    this.isServer = true
    this.queue = []
  }

  init({ db }) {
    this.db = db
  }

  async start() {
    // get spawn
    const spawnRow = await this.db('config').where('key', 'spawn').first()
    this.spawn = JSON.parse(spawnRow?.value || defaultSpawn)
    // hydrate blueprints
    const blueprints = await this.db('blueprints')
    for (const blueprint of blueprints) {
      const data = JSON.parse(blueprint.data)
      this.world.blueprints.add(data, true)
    }
    // hydrate entities
    const entities = await this.db('entities')
    for (const entity of entities) {
      const data = JSON.parse(entity.data)
      data.state = {}
      this.world.entities.add(data, true)
    }
    // hydrate settings
    let settingsRow = await this.db('config').where('key', 'settings').first()
    try {
      const settings = JSON.parse(settingsRow?.value || '{}')
      this.world.settings.deserialize(settings)
      this.world.settings.setHasAdminCode(!!process.env.ADMIN_CODE)
    } catch (err) {
      console.error(err)
    }
    // watch settings changes
    this.world.settings.on('change', this.saveSettings)
    // queue first save
    if (SAVE_INTERVAL) {
      this.saveTimerId = setTimeout(this.save, SAVE_INTERVAL * 1000)
    }
  }

  preFixedUpdate() {
    this.flush()
  }

  send(name, data, ignoreSocketId) {
    // console.log('->>>', name, data)
    const packet = writePacket(name, data)
    this.sockets.forEach(socket => {
      if (socket.id === ignoreSocketId) return
      socket.sendPacket(packet)
    })
  }

  sendTo(socketId, name, data) {
    const socket = this.sockets.get(socketId)
    socket?.send(name, data)
  }

  checkSockets() {
    // see: https://www.npmjs.com/package/ws#how-to-detect-and-close-broken-connections
    const dead = []
    this.sockets.forEach(socket => {
      if (!socket.alive) {
        dead.push(socket)
      } else {
        socket.ping()
      }
    })
    dead.forEach(socket => socket.disconnect())
  }

  enqueue(socket, method, data) {
    this.queue.push([socket, method, data])
  }

  flush() {
    while (this.queue.length) {
      try {
        const [socket, method, data] = this.queue.shift()
        this[method]?.(socket, data)
      } catch (err) {
        console.error(err)
      }
    }
  }

  getTime() {
    return performance.now() / 1000 // seconds
  }

  save = async () => {
    const counts = {
      upsertedBlueprints: 0,
      upsertedApps: 0,
      deletedApps: 0,
    }
    const now = moment().toISOString()
    // blueprints
    for (const id of this.dirtyBlueprints) {
      const blueprint = this.world.blueprints.get(id)
      try {
        const record = {
          id: blueprint.id,
          data: JSON.stringify(blueprint),
        }
        await this.db('blueprints')
          .insert({ ...record, createdAt: now, updatedAt: now })
          .onConflict('id')
          .merge({ ...record, updatedAt: now })
        counts.upsertedBlueprints++
        this.dirtyBlueprints.delete(id)
      } catch (err) {
        console.log(`error saving blueprint: ${blueprint.id}`)
        console.error(err)
      }
    }
    // app entities
    for (const id of this.dirtyApps) {
      const entity = this.world.entities.get(id)
      if (entity) {
        // it needs creating/updating
        if (entity.data.uploader || entity.data.mover) {
          continue // ignore while uploading or moving
        }
        try {
          const data = cloneDeep(entity.data)
          data.state = null
          const record = {
            id: entity.data.id,
            data: JSON.stringify(entity.data),
          }
          await this.db('entities')
            .insert({ ...record, createdAt: now, updatedAt: now })
            .onConflict('id')
            .merge({ ...record, updatedAt: now })
          counts.upsertedApps++
          this.dirtyApps.delete(id)
        } catch (err) {
          console.log(`error saving entity: ${entity.data.id}`)
          console.error(err)
        }
      } else {
        // it was removed
        await this.db('entities').where('id', id).delete()
        counts.deletedApps++
        this.dirtyApps.delete(id)
      }
    }
    // log
    const didSave = counts.upsertedBlueprints > 0 || counts.upsertedApps > 0 || counts.deletedApps > 0
    if (didSave) {
      console.log(
        `world saved (${counts.upsertedBlueprints} blueprints, ${counts.upsertedApps} apps, ${counts.deletedApps} apps removed)`
      )
    }
    // queue again
    this.saveTimerId = setTimeout(this.save, SAVE_INTERVAL * 1000)
  }

  saveSettings = async () => {
    const data = this.world.settings.serialize()
    const value = JSON.stringify(data)
    await this.db('config')
      .insert({
        key: 'settings',
        value,
      })
      .onConflict('key')
      .merge({
        value,
      })
  }

  async onConnection(ws, params) {
    try {
      // check player limit
      const playerLimit = this.world.settings.playerLimit
      if (isNumber(playerLimit) && playerLimit > 0 && this.sockets.size >= playerLimit) {
        const packet = writePacket('kick', 'player_limit')
        ws.send(packet)
        ws.close()
        return
      }

      // check connection params
      let authToken = params.authToken
      let name = params.name
      let avatar = params.avatar

      // get or create user
      let user
      if (authToken) {
        try {
          const { userId } = await readJWT(authToken)
          user = await this.db('users').where('id', userId).first()
        } catch (err) {
          console.error('failed to read authToken:', authToken)
        }
      }
      if (!user) {
        user = {
          id: uuid(),
          name: 'Anonymous',
          avatar: null,
          rank: 0,
          createdAt: moment().toISOString(),
        }
        await this.db('users').insert(user)
        authToken = await createJWT({ userId: user.id })
      }

      // disconnect if user already in this world
      if (this.sockets.has(user.id)) {
        const packet = writePacket('kick', 'duplicate_user')
        ws.send(packet)
        ws.close()
        return
      }

      // livekit options
      const livekit = await this.world.livekit.serialize(user.id)

      // create socket
      const socket = new Socket({ id: user.id, ws, network: this })

      // spawn player
      socket.player = this.world.entities.add(
        {
          id: user.id,
          type: 'player',
          position: this.spawn.position.slice(),
          quaternion: this.spawn.quaternion.slice(),
          owner: socket.id, // deprecated, same as userId
          userId: user.id, // deprecated, same as userId
          name: name || user.name,
          health: HEALTH_MAX,
          avatar: user.avatar || this.world.settings.avatar?.url || 'asset://avatar.vrm',
          sessionAvatar: avatar || null,
          rank: user.rank,
          enteredAt: Date.now(),
        },
        true
      )

      // send snapshot
      socket.send('snapshot', {
        id: socket.id,
        serverTime: performance.now(),
        assetsUrl: process.env.ASSETS_BASE_URL,
        apiUrl: process.env.PUBLIC_API_URL,
        adminUrl: PUBLIC_ADMIN_URL,
        maxUploadSize: process.env.PUBLIC_MAX_UPLOAD_SIZE,
        settings: this.world.settings.serialize(),
        chat: this.world.chat.serialize(),
        ai: this.world.ai.serialize(),
        blueprints: this.world.blueprints.serialize(),
        entities: this.world.entities.serialize(),
        livekit,
        authToken,
        hasAdminCode: !!process.env.ADMIN_CODE,
      })

      this.sockets.set(socket.id, socket)

      // enter events on the server are sent after the snapshot.
      // on the client these are sent during PlayerRemote.js entity instantiation!
      this.world.events.emit('enter', { playerId: socket.player.data.id })
    } catch (err) {
      console.error(err)
    }
  }

  onChatAdded = async (socket, msg) => {
    this.world.chat.add(msg, false)
    this.send('chatAdded', msg, socket.id)
  }

  onCommand = async (socket, data) => {
    const { args } = data
    // handle slash commands
    const player = socket.player
    const playerId = player.data.id
    const [cmd, arg1, arg2] = args
    // become admin command
    if (cmd === 'admin') {
      const code = arg1
      if (process.env.ADMIN_CODE && process.env.ADMIN_CODE === code) {
        const id = player.data.id
        const userId = player.data.userId
        const granted = !player.isAdmin()
        let rank
        if (granted) {
          rank = Ranks.ADMIN
        } else {
          rank = Ranks.VISITOR
        }
        player.modify({ rank })
        this.send('entityModified', { id, rank })
        socket.send('chatAdded', {
          id: uuid(),
          from: null,
          fromId: null,
          body: granted ? 'Admin granted!' : 'Admin revoked!',
          createdAt: moment().toISOString(),
        })
        await this.db('users').where('id', userId).update({ rank })
      }
    }
    if (cmd === 'name') {
      const name = arg1
      if (name) {
        const id = player.data.id
        const userId = player.data.userId
        player.data.name = name
        player.modify({ name })
        this.send('entityModified', { id, name })
        socket.send('chatAdded', {
          id: uuid(),
          from: null,
          fromId: null,
          body: `Name set to ${name}!`,
          createdAt: moment().toISOString(),
        })
        await this.db('users').where('id', userId).update({ name })
      }
    }
    if (cmd === 'spawn') {
      const op = arg1
      this.onSpawnModified(socket, op)
    }
    if (cmd === 'chat') {
      const op = arg1
      if (op === 'clear' && socket.player.isBuilder()) {
        this.world.chat.clear(true)
      }
    }
    if (cmd === 'server') {
      const op = arg1
      if (op === 'stats') {
        function send(body) {
          socket.send('chatAdded', {
            id: uuid(),
            from: null,
            fromId: null,
            body,
            createdAt: moment().toISOString(),
          })
        }
        const stats = await this.world.monitor.getStats()
        send(`CPU: ${stats.currentCPU.toFixed(3)}%`)
        send(
          `Memory: ${stats.currentMemory} / ${stats.maxMemory} MB (${((stats.currentMemory / stats.maxMemory) * 100).toFixed(1)}%)`
        )
      }
    }
    // emit event for all except admin
    if (cmd !== 'admin') {
      this.world.events.emit('command', { playerId, args })
    }
  }

  onModifyRank = async (socket, data) => {
    console.warn('rejected modifyRank over /ws', { playerId: socket.id })
  }

  onKick = (socket, playerId) => {
    console.warn('rejected kick over /ws', { playerId: socket.id })
  }

  onMute = (socket, data) => {
    console.warn('rejected mute over /ws', { playerId: socket.id })
  }

  applyModifyRank = async ({ playerId, rank }) => {
    if (!playerId) return { ok: false, error: 'invalid_payload' }
    if (!isNumber(rank)) return { ok: false, error: 'invalid_payload' }
    const player = this.world.entities.get(playerId)
    if (!player || !player.isPlayer) return { ok: false, error: 'not_found' }
    player.modify({ rank })
    this.send('entityModified', { id: playerId, rank })
    await this.db('users').where('id', playerId).update({ rank })
    return { ok: true }
  }

  applyKick(playerId) {
    if (!playerId) return { ok: false, error: 'invalid_payload' }
    const player = this.world.entities.get(playerId)
    if (!player || !player.isPlayer) return { ok: false, error: 'not_found' }
    const tSocket = this.sockets.get(playerId)
    if (!tSocket) return { ok: false, error: 'not_connected' }
    tSocket.send('kick', 'moderation')
    tSocket.disconnect()
    return { ok: true }
  }

  applyMute({ playerId, muted }) {
    if (!playerId) return { ok: false, error: 'invalid_payload' }
    const player = this.world.entities.get(playerId)
    if (!player || !player.isPlayer) return { ok: false, error: 'not_found' }
    this.world.livekit.setMuted(playerId, muted)
    return { ok: true }
  }

  applyBlueprintAdded(blueprint, { ignoreNetworkId } = {}) {
    this.world.blueprints.add(blueprint)
    this.send('blueprintAdded', blueprint, ignoreNetworkId)
    this.dirtyBlueprints.add(blueprint.id)
    return { ok: true }
  }

  applyBlueprintModified(change, { ignoreNetworkId } = {}) {
    const blueprint = this.world.blueprints.get(change.id)
    if (!blueprint) {
      return { ok: false, error: 'not_found' }
    }
    // if new version is greater than current version, allow it
    if (change.version > blueprint.version) {
      this.world.blueprints.modify(change)
      this.send('blueprintModified', change, ignoreNetworkId)
      this.dirtyBlueprints.add(change.id)
      return { ok: true }
    }
    // otherwise, send a revert back to client, because someone else modified before them
    if (ignoreNetworkId) {
      this.sendTo(ignoreNetworkId, 'blueprintModified', blueprint)
    }
    return { ok: false, error: 'version_mismatch', current: blueprint }
  }

  applyEntityAdded(data, { ignoreNetworkId } = {}) {
    const entity = this.world.entities.add(data)
    this.send('entityAdded', data, ignoreNetworkId)
    if (entity?.isApp) {
      this.dirtyApps.add(entity.data.id)
    }
    return { ok: true }
  }

  applyEntityModified = async (data, { ignoreNetworkId } = {}) => {
    const entity = this.world.entities.get(data.id)
    if (!entity) return { ok: false, error: 'not_found' }
    entity.modify(data)
    this.send('entityModified', data, ignoreNetworkId)
    if (entity.isApp) {
      this.dirtyApps.add(entity.data.id)
    }
    if (entity.isPlayer) {
      const changes = {}
      let changed
      if (data.hasOwnProperty('name')) {
        changes.name = data.name
        changed = true
      }
      if (data.hasOwnProperty('avatar')) {
        changes.avatar = data.avatar
        changed = true
      }
      if (changed) {
        await this.db('users').where('id', entity.data.userId).update(changes)
      }
    }
    return { ok: true }
  }

  applyEntityRemoved(id, { ignoreNetworkId } = {}) {
    const entity = this.world.entities.get(id)
    this.world.entities.remove(id)
    this.send('entityRemoved', id, ignoreNetworkId)
    if (entity?.isApp) {
      this.dirtyApps.add(id)
    }
    return { ok: true }
  }

  applySettingsModified(data, { ignoreNetworkId } = {}) {
    this.world.settings.set(data.key, data.value)
    this.send('settingsModified', data, ignoreNetworkId)
    return { ok: true }
  }

  applySpawnModified = async ({ op, networkId }) => {
    if (op === 'set') {
      const player = this.world.entities.get(networkId)
      if (!player || !player.isPlayer) return { ok: false, error: 'player_not_found' }
      this.spawn = { position: player.data.position.slice(), quaternion: player.data.quaternion.slice() }
    } else if (op === 'clear') {
      this.spawn = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] }
    } else {
      return { ok: false, error: 'invalid_op' }
    }
    const value = JSON.stringify(this.spawn)
    await this.db('config')
      .insert({
        key: 'spawn',
        value,
      })
      .onConflict('key')
      .merge({
        value,
      })
    return { ok: true }
  }

  onBlueprintAdded = (socket, blueprint) => {
    console.warn('rejected blueprint add over /ws', { playerId: socket.id })
  }

  onBlueprintModified = (socket, data) => {
    console.warn('rejected blueprint modify over /ws', { playerId: socket.id })
  }

  onEntityAdded = (socket, data) => {
    console.warn('rejected entity add over /ws', { playerId: socket.id })
  }

  onEntityModified = async (socket, data) => {
    const entity = this.world.entities.get(data.id)
    if (!entity) return console.error('onEntityModified: no entity found', data)
    if (!entity.isPlayer) {
      return console.warn('rejected entity modify over /ws', { playerId: socket.id, entityId: data.id })
    }
    if (entity.data.id !== socket.id) {
      return console.warn('rejected entity modify over /ws for non-owner', {
        playerId: socket.id,
        entityId: data.id,
      })
    }
    await this.applyEntityModified(data, { ignoreNetworkId: socket.id })
  }

  onEntityEvent = (socket, event) => {
    const [id, version, name, data] = event
    const entity = this.world.entities.get(id)
    entity?.onEvent(version, name, data, socket.id)
  }

  onEntityRemoved = (socket, id) => {
    console.warn('rejected entity remove over /ws', { playerId: socket.id })
  }

  onSettingsModified = (socket, data) => {
    console.warn('rejected settings modify over /ws', { playerId: socket.id })
  }

  onSpawnModified = async (socket, op) => {
    console.warn('rejected spawn modify over /ws', { playerId: socket.id })
  }

  onPlayerTeleport = (socket, data) => {
    this.sendTo(data.networkId, 'playerTeleport', data)
  }

  onPlayerPush = (socket, data) => {
    this.sendTo(data.networkId, 'playerPush', data)
  }

  onPlayerSessionAvatar = (socket, data) => {
    this.sendTo(data.networkId, 'playerSessionAvatar', data.avatar)
  }

  onAi = (socket, action) => {
    if (!socket.player.isBuilder()) {
      return console.error('player attempted to use ai but they are not a builder')
    }
    this.world.ai.onAction(action)
  }

  onPing = (socket, time) => {
    socket.send('pong', time)
  }

  onDisconnect = (socket, code) => {
    this.world.livekit.clearModifiers(socket.id)
    socket.player.destroy(true)
    this.sockets.delete(socket.id)
  }
}
