import moment from 'moment'
import { writePacket } from '../packets'
import { Socket } from '../Socket'
import { uuid } from '../utils'
import { System } from './System'
import { createJWT, readJWT } from '../utils-server'
import { isNumber } from 'lodash-es'
import * as THREE from '../extras/three'
import { Ranks } from '../extras/ranks'
import { validateBlueprintScriptFields } from '../blueprintValidation'
import { ensureBlueprintSyncMetadata, ensureEntitySyncMetadata } from '../../server/syncMetadata.js'

const SAVE_INTERVAL = parseInt(process.env.SAVE_INTERVAL || '60') // seconds
const PING_RATE = 10 // seconds
const defaultSpawn = '{ "position": [0, 0, 0], "quaternion": [0, 0, 0, 1] }'
const SCRIPT_BLUEPRINT_FIELDS = new Set([
  'script',
  'scriptEntry',
  'scriptFiles',
  'scriptFormat',
  'scriptRef',
])

const HEALTH_MAX = 100
const PUBLIC_ADMIN_URL = process.env.PUBLIC_ADMIN_URL || ''

function normalizeForwardedPrefix(value) {
  if (typeof value !== 'string') return ''
  const first = value.split(',')[0].trim()
  if (!first || first === '/') return ''
  const prefixed = first.startsWith('/') ? first : `/${first}`
  return prefixed.replace(/\/+$/, '')
}

function extractWorldPrefixFromPath(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  const [pathname] = trimmed.split('?')
  const match = pathname.match(/^(\/worlds\/[^/]+)/)
  return match ? match[1] : ''
}

function deriveAdminUrlFromRequest(req) {
  const headers = req?.headers || {}
  let host = headers['x-forwarded-host'] || headers['host']
  if (Array.isArray(host)) host = host[0]
  if (!host) return null

  let proto = headers['x-forwarded-proto']
  if (Array.isArray(proto)) proto = proto[0]
  if (proto) proto = String(proto).split(',')[0].trim()
  if (proto === 'wss') proto = 'https'
  if (proto === 'ws') proto = 'http'
  if (!proto && req?.protocol) proto = req.protocol
  if (!proto) proto = 'https'

  let prefix = normalizeForwardedPrefix(headers['x-forwarded-prefix'])
  if (!prefix) {
    const forwardedUri = headers['x-forwarded-uri'] || headers['x-original-uri'] || headers['x-rewrite-url']
    prefix = extractWorldPrefixFromPath(Array.isArray(forwardedUri) ? forwardedUri[0] : forwardedUri)
  }
  if (!prefix) {
    prefix = extractWorldPrefixFromPath(req?.url)
  }

  return `${proto}://${host}${prefix}`
}

function deriveAdminUrlFromEnv() {
  return (
    (process.env.PUBLIC_WS_URL || '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/ws\/?$/, '') ||
    (process.env.PUBLIC_API_URL || '').replace(/\/api\/?$/, '')
  )
}

function isNumberArray(value, length) {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every(item => typeof item === 'number' && Number.isFinite(item))
  )
}

function serializePlayerForAdmin(player) {
  if (!player?.data) return null
  return {
    id: player.data.id,
    name: player.data.name,
    avatar: player.data.avatar,
    sessionAvatar: player.data.sessionAvatar,
    position: player.data.position,
    quaternion: player.data.quaternion,
    rank: player.data.rank,
    enteredAt: player.data.enteredAt,
  }
}

function normalizeMetadataString(value, fallback) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return fallback
}

function normalizeBlueprintFieldString(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function resolveScriptRootBlueprint(scriptRef, currentBlueprint, world) {
  if (!scriptRef) return null
  const currentId = normalizeBlueprintFieldString(currentBlueprint?.id)
  if (currentBlueprint && currentId === scriptRef) return currentBlueprint
  return world?.blueprints?.get(scriptRef) || null
}

function normalizeScriptReferenceBlueprint(data, { currentBlueprint = null, world } = {}) {
  if (!data || typeof data !== 'object') return data
  const scriptRef = normalizeBlueprintFieldString(data.scriptRef)
  if (!scriptRef) return data

  const blueprintId = normalizeBlueprintFieldString(data.id) || normalizeBlueprintFieldString(currentBlueprint?.id)
  if (blueprintId && blueprintId === scriptRef) {
    return { ...data, scriptRef: null }
  }

  const normalized = {
    ...data,
    scriptRef,
    scriptEntry: null,
    scriptFiles: null,
    scriptFormat: null,
  }

  const scriptRoot = resolveScriptRootBlueprint(scriptRef, currentBlueprint, world)
  const rootScript = normalizeBlueprintFieldString(scriptRoot?.script)
  if (rootScript) {
    normalized.script = rootScript
  }

  return normalized
}

function hasScriptFields(data) {
  if (!data || typeof data !== 'object') return false
  for (const field of SCRIPT_BLUEPRINT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(data, field)) continue
    if (field === 'script' && data.script === '') continue
    return true
  }
  return false
}

function applySyncMetadata(target, source) {
  if (!target || !source) return
  target.uid = source.uid
  target.scope = source.scope
  target.managedBy = source.managedBy
  target.updatedAt = source.updatedAt
  target.updatedBy = source.updatedBy
  target.updateSource = source.updateSource
  target.lastOpId = source.lastOpId
}

function normalizeIsoTimestamp(value, fallback) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed) {
      const parsed = Date.parse(trimmed)
      if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
    }
  }
  return fallback
}

function cloneOperationPayload(value) {
  if (value === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return null
  }
}

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

  init({ db, deploymentId }) {
    this.db = db
    this.deploymentId = deploymentId
  }

  async start() {
    // get spawn
    const spawnRow = await this.db('config').where({ deployment_id: this.deploymentId, key: 'spawn' }).first()
    this.spawn = JSON.parse(spawnRow?.value || defaultSpawn)
    // get worldId
    const worldIdRow = await this.db('config').where({ deployment_id: this.deploymentId, key: 'worldId' }).first()
    let worldId = worldIdRow?.value
    if (!worldId) {
      worldId = process.env.WORLD_ID || uuid()
      await this.db('config')
        .insert({ deployment_id: this.deploymentId, key: 'worldId', value: worldId })
        .onConflict(['deployment_id', 'key'])
        .merge({ value: worldId })
    }
    if (process.env.WORLD_ID && process.env.WORLD_ID !== worldId) {
      throw new Error(`[envs] WORLD_ID mismatch: env=${process.env.WORLD_ID} db=${worldId}`)
    }
    this.worldId = worldId
    // hydrate blueprints
    const blueprints = await this.db('blueprints').where('deployment_id', this.deploymentId)
    for (const blueprint of blueprints) {
      const data = JSON.parse(blueprint.data)
      if (blueprint?.createdAt) data.createdAt = blueprint.createdAt
      if (data.keep === undefined) data.keep = false
      ensureBlueprintSyncMetadata(data, {
        touch: false,
        now: blueprint.updatedAt || moment().toISOString(),
        updatedBy: 'runtime',
        updateSource: 'runtime',
      })
      this.world.blueprints.add(data, true)
    }
    // hydrate entities
    const entities = await this.db('entities').where('deployment_id', this.deploymentId)
    for (const entity of entities) {
      const data = JSON.parse(entity.data)
      const blueprintScope =
        typeof data.blueprint === 'string' ? this.world.blueprints.get(data.blueprint)?.scope : null
      ensureEntitySyncMetadata(data, {
        touch: false,
        now: entity.updatedAt || moment().toISOString(),
        updatedBy: 'runtime',
        updateSource: 'runtime',
        blueprintScope,
      })
      data.state = {}
      this.world.entities.add(data, true)
    }
    // hydrate settings
    let settingsRow = await this.db('config').where({ deployment_id: this.deploymentId, key: 'settings' }).first()
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

  createOperationMetadata({ actor, source, lastOpId } = {}, now = moment().toISOString()) {
    return {
      opId: normalizeMetadataString(lastOpId, uuid()),
      ts: normalizeIsoTimestamp(now, moment().toISOString()),
      actor: normalizeMetadataString(actor, 'runtime'),
      source: normalizeMetadataString(source, 'runtime'),
    }
  }

  emitOperation({ kind, objectUid, patch, snapshot, opId, actor, source, ts } = {}) {
    const normalizedKind = normalizeMetadataString(kind, null)
    const normalizedObjectUid = normalizeMetadataString(objectUid, null)
    if (!normalizedKind || !normalizedObjectUid) return
    const payload = {
      opId: normalizeMetadataString(opId, uuid()),
      ts: normalizeIsoTimestamp(ts, moment().toISOString()),
      actor: normalizeMetadataString(actor, 'runtime'),
      source: normalizeMetadataString(source, 'runtime'),
      kind: normalizedKind,
      objectUid: normalizedObjectUid,
    }
    if (patch !== undefined) {
      payload.patch = cloneOperationPayload(patch)
    }
    if (snapshot !== undefined) {
      payload.snapshot = cloneOperationPayload(snapshot)
    }
    this.emit('operation', payload)
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
        const createdAt = blueprint.createdAt || now
        if (!blueprint.createdAt) blueprint.createdAt = createdAt
        if (blueprint.keep === undefined) blueprint.keep = false
        ensureBlueprintSyncMetadata(blueprint, {
          touch: true,
          now,
          updatedBy: normalizeMetadataString(blueprint.updatedBy, 'runtime'),
          updateSource: normalizeMetadataString(blueprint.updateSource, 'runtime'),
        })
        const record = {
          id: blueprint.id,
          data: JSON.stringify(blueprint),
        }
        await this.db('blueprints')
          .insert({ deployment_id: this.deploymentId, ...record, createdAt, updatedAt: now })
          .onConflict(['deployment_id', 'id'])
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
          const blueprintScope =
            typeof entity.data.blueprint === 'string' ? this.world.blueprints.get(entity.data.blueprint)?.scope : null
          ensureEntitySyncMetadata(entity.data, {
            touch: true,
            now,
            updatedBy: normalizeMetadataString(entity.data.updatedBy, 'runtime'),
            updateSource: normalizeMetadataString(entity.data.updateSource, 'runtime'),
            blueprintScope,
          })
          const record = {
            id: entity.data.id,
            data: JSON.stringify(entity.data),
          }
          await this.db('entities')
            .insert({ deployment_id: this.deploymentId, ...record, createdAt: now, updatedAt: now })
            .onConflict(['deployment_id', 'id'])
            .merge({ ...record, updatedAt: now })
          counts.upsertedApps++
          this.dirtyApps.delete(id)
        } catch (err) {
          console.log(`error saving entity: ${entity.data.id}`)
          console.error(err)
        }
      } else {
        // it was removed
        await this.db('entities').where({ deployment_id: this.deploymentId, id }).delete()
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
        deployment_id: this.deploymentId,
        key: 'settings',
        value,
      })
      .onConflict(['deployment_id', 'key'])
      .merge({
        value,
      })
  }

  async onConnection(ws, params, req) {
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
      const adminUrl = deriveAdminUrlFromRequest(req) || PUBLIC_ADMIN_URL || deriveAdminUrlFromEnv()
      socket.send('snapshot', {
        id: socket.id,
        serverTime: performance.now(),
        assetsUrl: process.env.ASSETS_BASE_URL,
        apiUrl: process.env.PUBLIC_API_URL,
        adminUrl,
        maxUploadSize: process.env.PUBLIC_MAX_UPLOAD_SIZE,
        settings: this.world.settings.serialize(),
        chat: this.world.chat.serialize(),
        blueprints: this.world.blueprints.serialize(),
        entities: this.world.entities.serialize(),
        livekit,
        ai: this.world.ai?.serialize?.() || null,
        authToken,
        hasAdminCode: !!process.env.ADMIN_CODE,
      })

      this.sockets.set(socket.id, socket)

      // enter events on the server are sent after the snapshot.
      // on the client these are sent during PlayerRemote.js entity instantiation!
      this.world.events.emit('enter', { playerId: socket.player.data.id })
      const joined = serializePlayerForAdmin(socket.player)
      if (joined) {
        this.emit('playerJoined', joined)
      }
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
    this.emit('entityModified', { id: playerId, rank })
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

  applyBlueprintAdded(blueprint, { ignoreNetworkId, actor, source, lastOpId } = {}) {
    const now = moment().toISOString()
    const operation = this.createOperationMetadata({ actor, source, lastOpId }, now)
    const nextBlueprint = normalizeScriptReferenceBlueprint(blueprint, { world: this.world })
    if (!nextBlueprint.createdAt) {
      nextBlueprint.createdAt = now
    }
    if (nextBlueprint.keep === undefined) {
      nextBlueprint.keep = false
    }
    ensureBlueprintSyncMetadata(nextBlueprint, {
      touch: true,
      now,
      updatedBy: normalizeMetadataString(actor, 'runtime'),
      updateSource: normalizeMetadataString(source, 'runtime'),
      lastOpId: operation.opId,
    })
    const validation = validateBlueprintScriptFields(nextBlueprint)
    if (!validation.ok) return validation
    this.world.blueprints.add(nextBlueprint)
    this.send('blueprintAdded', nextBlueprint, ignoreNetworkId)
    this.dirtyBlueprints.add(nextBlueprint.id)
    const added = this.world.blueprints.get(nextBlueprint.id) || nextBlueprint
    this.emit('blueprintAdded', added)
    this.emitOperation({
      ...operation,
      kind: 'blueprint.add',
      objectUid: added?.uid || added?.id || nextBlueprint.id,
      snapshot: added,
    })
    return { ok: true }
  }

  applyBlueprintModified(change, { ignoreNetworkId, actor, source, lastOpId } = {}) {
    const blueprint = this.world.blueprints.get(change.id)
    if (!blueprint) {
      return { ok: false, error: 'not_found' }
    }
    const normalizedChange = normalizeScriptReferenceBlueprint(change, { currentBlueprint: blueprint, world: this.world })
    const validation = validateBlueprintScriptFields(normalizedChange)
    if (!validation.ok) return validation
    const hasScriptChange = hasScriptFields(normalizedChange)
    if (hasScriptChange && source !== 'ai-scripts') {
      const busy = this.world.aiScripts?.getBusyStateForBlueprint?.(blueprint)
      if (busy?.scriptRootId) {
        return {
          ok: false,
          error: 'ai_request_pending',
          scriptRootId: busy.scriptRootId,
          targetBlueprintId: busy.targetBlueprintId || blueprint.id,
          requestId: busy.requestId || null,
        }
      }
    }
    // if new version is greater than current version, allow it
    if (normalizedChange.version > blueprint.version) {
      const now = moment().toISOString()
      const operation = this.createOperationMetadata({ actor, source, lastOpId }, now)
      const createdAt = blueprint.createdAt || normalizedChange.createdAt || moment().toISOString()
      const nextChange = { ...normalizedChange, createdAt }
      if (blueprint.keep === undefined && nextChange.keep === undefined) {
        nextChange.keep = false
      }
      const merged = { ...blueprint, ...nextChange }
      ensureBlueprintSyncMetadata(merged, {
        touch: true,
        now,
        updatedBy: normalizeMetadataString(actor, 'runtime'),
        updateSource: normalizeMetadataString(source, 'runtime'),
        lastOpId: operation.opId,
      })
      const nextChangeWithSync = { ...nextChange }
      applySyncMetadata(nextChangeWithSync, merged)
      this.world.blueprints.modify(nextChangeWithSync)
      this.send('blueprintModified', nextChangeWithSync, ignoreNetworkId)
      this.dirtyBlueprints.add(normalizedChange.id)
      const updated = this.world.blueprints.get(normalizedChange.id)
      if (updated) {
        this.emit('blueprintModified', updated)
        this.emitOperation({
          ...operation,
          kind: 'blueprint.update',
          objectUid: updated.uid || updated.id || normalizedChange.id,
          patch: nextChangeWithSync,
          snapshot: updated,
        })
      }
      return { ok: true }
    }
    // otherwise, send a revert back to client, because someone else modified before them
    if (ignoreNetworkId) {
      this.sendTo(ignoreNetworkId, 'blueprintModified', blueprint)
    }
    return { ok: false, error: 'version_mismatch', current: blueprint }
  }

  applyBlueprintRemoved = async ({ id }, { ignoreNetworkId, actor, source, lastOpId } = {}) => {
    if (!id) return { ok: false, error: 'invalid_payload' }
    const blueprint = this.world.blueprints.get(id)
    if (!blueprint) return { ok: false, error: 'not_found' }
    for (const entity of this.world.entities.items.values()) {
      if (entity?.data?.blueprint === id) {
        return { ok: false, error: 'in_use' }
      }
    }
    const operation = this.createOperationMetadata({ actor, source, lastOpId })
    this.world.blueprints.remove(id)
    this.send('blueprintRemoved', { id }, ignoreNetworkId)
    this.dirtyBlueprints.delete(id)
    await this.db('blueprints').where({ deployment_id: this.deploymentId, id }).delete()
    this.emit('blueprintRemoved', { id })
    this.emitOperation({
      ...operation,
      kind: 'blueprint.remove',
      objectUid: blueprint.uid || blueprint.id || id,
      patch: { id },
      snapshot: blueprint,
    })
    return { ok: true }
  }

  applyEntityAdded(data, { ignoreNetworkId, actor, source, lastOpId } = {}) {
    const nextData = data && typeof data === 'object' ? { ...data } : data
    const operation =
      nextData?.type === 'app' ? this.createOperationMetadata({ actor, source, lastOpId }, moment().toISOString()) : null
    if (nextData?.type === 'app') {
      const blueprintScope =
        typeof nextData.blueprint === 'string' ? this.world.blueprints.get(nextData.blueprint)?.scope : null
      ensureEntitySyncMetadata(nextData, {
        touch: true,
        now: moment().toISOString(),
        updatedBy: normalizeMetadataString(actor, 'runtime'),
        updateSource: normalizeMetadataString(source, 'runtime'),
        lastOpId: operation?.opId,
        blueprintScope,
      })
    }
    const entity = this.world.entities.add(nextData)
    this.send('entityAdded', nextData, ignoreNetworkId)
    if (entity?.isApp) {
      this.dirtyApps.add(entity.data.id)
      this.emitOperation({
        ...operation,
        kind: 'entity.add',
        objectUid: entity.data.uid || entity.data.id,
        snapshot: entity.data,
      })
    }
    if (entity) {
      this.emit('entityAdded', entity.data)
    }
    return { ok: true }
  }

  applyEntityModified = async (data, { ignoreNetworkId, actor, source, lastOpId } = {}) => {
    const entity = this.world.entities.get(data.id)
    if (!entity) return { ok: false, error: 'not_found' }
    if (data.hasOwnProperty('props')) {
      if (!entity.isApp) return { ok: false, error: 'invalid_payload' }
      if (!data.props || typeof data.props !== 'object' || Array.isArray(data.props)) {
        return { ok: false, error: 'invalid_payload' }
      }
    }
    let nextData = data
    const operation = entity.isApp ? this.createOperationMetadata({ actor, source, lastOpId }, moment().toISOString()) : null
    if (entity.isApp) {
      const merged = { ...entity.data, ...data }
      const blueprintId =
        typeof merged.blueprint === 'string'
          ? merged.blueprint
          : typeof entity.data.blueprint === 'string'
            ? entity.data.blueprint
            : null
      const blueprintScope = blueprintId ? this.world.blueprints.get(blueprintId)?.scope : null
      ensureEntitySyncMetadata(merged, {
        touch: true,
        now: moment().toISOString(),
        updatedBy: normalizeMetadataString(actor, 'runtime'),
        updateSource: normalizeMetadataString(source, 'runtime'),
        lastOpId: operation?.opId,
        blueprintScope,
      })
      nextData = { ...data }
      applySyncMetadata(nextData, merged)
    }

    entity.modify(nextData)
    if (entity.isApp) {
      applySyncMetadata(entity.data, nextData)
    }

    this.send('entityModified', nextData, ignoreNetworkId)
    if (entity.isApp) {
      this.dirtyApps.add(entity.data.id)
      this.emitOperation({
        ...operation,
        kind: 'entity.update',
        objectUid: entity.data.uid || entity.data.id,
        patch: nextData,
        snapshot: entity.data,
      })
    }
    if (entity.isPlayer) {
      const changes = {}
      let changed
      if (nextData.hasOwnProperty('name')) {
        changes.name = nextData.name
        changed = true
      }
      if (nextData.hasOwnProperty('avatar')) {
        changes.avatar = nextData.avatar
        changed = true
      }
      if (changed) {
        await this.db('users').where('id', entity.data.userId).update(changes)
      }
      const playerUpdate = {
        id: entity.data.id,
      }
      let hasPlayerUpdate
      if (nextData.hasOwnProperty('p')) {
        playerUpdate.position = entity.data.position
        hasPlayerUpdate = true
      }
      if (nextData.hasOwnProperty('q')) {
        playerUpdate.quaternion = entity.data.quaternion
        hasPlayerUpdate = true
      }
      if (nextData.hasOwnProperty('name')) {
        playerUpdate.name = entity.data.name
        hasPlayerUpdate = true
      }
      if (nextData.hasOwnProperty('avatar') || nextData.hasOwnProperty('sessionAvatar')) {
        playerUpdate.avatar = entity.data.avatar
        playerUpdate.sessionAvatar = entity.data.sessionAvatar
        hasPlayerUpdate = true
      }
      if (hasPlayerUpdate) {
        this.emit('playerUpdated', playerUpdate)
      }
    }
    this.emit('entityModified', entity.data)
    return { ok: true }
  }

  applyEntityRemoved(id, { ignoreNetworkId, actor, source, lastOpId } = {}) {
    const entity = this.world.entities.get(id)
    const operation = entity?.isApp ? this.createOperationMetadata({ actor, source, lastOpId }) : null
    this.world.entities.remove(id)
    this.send('entityRemoved', id, ignoreNetworkId)
    if (entity?.isApp) {
      this.dirtyApps.add(id)
      this.emitOperation({
        ...operation,
        kind: 'entity.remove',
        objectUid: entity.data.uid || entity.data.id || id,
        patch: { id },
        snapshot: entity.data,
      })
    }
    this.emit('entityRemoved', id)
    return { ok: true }
  }

  applySettingsModified(data, { ignoreNetworkId, actor, source, lastOpId } = {}) {
    this.world.settings.set(data.key, data.value)
    this.send('settingsModified', data, ignoreNetworkId)
    this.emit('settingsModified', data)
    const operation = this.createOperationMetadata({ actor, source, lastOpId })
    this.emitOperation({
      ...operation,
      kind: 'settings.update',
      objectUid: `world:settings:${data.key}`,
      patch: data,
    })
    return { ok: true }
  }

  applySpawnSet = async ({ position, quaternion }, { actor, source, lastOpId } = {}) => {
    if (!isNumberArray(position, 3) || !isNumberArray(quaternion, 4)) {
      return { ok: false, error: 'invalid_payload' }
    }
    this.spawn = { position: position.slice(0, 3), quaternion: quaternion.slice(0, 4) }
    const value = JSON.stringify(this.spawn)
    await this.db('config')
      .insert({
        deployment_id: this.deploymentId,
        key: 'spawn',
        value,
      })
      .onConflict(['deployment_id', 'key'])
      .merge({
        value,
      })
    this.send('spawnModified', this.spawn)
    const operation = this.createOperationMetadata({ actor, source, lastOpId })
    this.emitOperation({
      ...operation,
      kind: 'spawn.update',
      objectUid: 'world:spawn',
      snapshot: this.spawn,
    })
    return { ok: true, spawn: this.spawn }
  }

  applySpawnModified = async ({ op, networkId }, { actor, source, lastOpId } = {}) => {
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
        deployment_id: this.deploymentId,
        key: 'spawn',
        value,
      })
      .onConflict(['deployment_id', 'key'])
      .merge({
        value,
      })
    this.send('spawnModified', this.spawn)
    this.emit('spawnModified', this.spawn)
    const operation = this.createOperationMetadata({ actor, source, lastOpId })
    this.emitOperation({
      ...operation,
      kind: 'spawn.update',
      objectUid: 'world:spawn',
      patch: { op },
      snapshot: this.spawn,
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

  onScriptAiRequest = (socket, data) => {
    const handler = this.world.aiScripts?.handleRequest
    if (!handler) return
    handler(socket, data).catch(err => {
      console.error('[ai-scripts] request failed', err)
    })
  }

  onAiCreateRequest = (socket, data) => {
    const handler = this.world.ai?.handleCreate
    if (!handler) return
    handler(socket, data).catch(err => {
      console.error('[ai-create] request failed', err)
    })
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

  onPing = (socket, time) => {
    socket.send('pong', time)
  }

  onDisconnect = (socket, code) => {
    this.world.livekit.clearModifiers(socket.id)
    socket.player.destroy(true)
    this.sockets.delete(socket.id)
    const playerId = socket.player?.data?.id
    if (playerId) {
      this.emit('playerLeft', { id: playerId })
    }
  }
}
