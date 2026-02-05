import crypto from 'crypto'
import fs from 'fs'
import { cloneDeep } from 'lodash-es'

import { readPacket, writePacket } from '../core/packets.js'
import { getEngineTemplate } from '../core/templates.js'
import { uuid } from '../core/utils.js'

const SCRIPT_BLUEPRINT_FIELDS = new Set([
  'script',
  'scriptEntry',
  'scriptFiles',
  'scriptFormat',
  'scriptRef',
])

function normalizeHeader(value) {
  if (Array.isArray(value)) return value[0]
  return value
}

function isCodeValid(expected, code) {
  if (!expected) return true
  if (typeof code !== 'string') return false
  const expectedBuf = Buffer.from(expected)
  const codeBuf = Buffer.from(code)
  if (expectedBuf.length !== codeBuf.length) return false
  return crypto.timingSafeEqual(expectedBuf, codeBuf)
}

function isAdminCodeValid(code) {
  const adminCode = process.env.ADMIN_CODE
  return isCodeValid(adminCode, code)
}

function isNumberArray(value, length) {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every(item => typeof item === 'number' && Number.isFinite(item))
  )
}

function getAdminCodeFromRequest(req) {
  const header = normalizeHeader(req.headers['x-admin-code'])
  return typeof header === 'string' ? header : null
}

function sendPacket(ws, name, payload) {
  try {
    ws.send(writePacket(name, payload))
  } catch (err) {
    console.error('[admin] failed to send message', err)
  }
}

function serializePlayersForAdmin(world) {
  const players = []
  world.entities.players.forEach(player => {
    players.push({
      id: player.data.id,
      name: player.data.name,
      avatar: player.data.avatar,
      sessionAvatar: player.data.sessionAvatar,
      position: player.data.position,
      quaternion: player.data.quaternion,
      rank: player.data.rank,
      enteredAt: player.data.enteredAt,
    })
  })
  return players
}

function serializeEntitiesForAdmin(world) {
  return world.entities.serialize().filter(entity => entity?.type !== 'player')
}

export async function admin(fastify, { world, assets, adminHtmlPath } = {}) {
  const subscribers = new Set()
  const playerSubscribers = new Set()
  const runtimeSubscribers = new Set()
  const db = world?.network?.db
  const deployLocks = new Map()
  const lockTtlSeconds = Number.parseInt(process.env.DEPLOY_LOCK_TTL || '120', 10)
  const lockTtlMs = Number.isFinite(lockTtlSeconds) && lockTtlSeconds > 0 ? lockTtlSeconds * 1000 : 120000

  function broadcast(name, payload) {
    for (const ws of subscribers) {
      sendPacket(ws, name, payload)
    }
  }

  function broadcastPlayers(name, payload) {
    for (const ws of playerSubscribers) {
      sendPacket(ws, name, payload)
    }
  }

  function requireAdmin(req, reply) {
    const code = getAdminCodeFromRequest(req)
    if (!isAdminCodeValid(code)) {
      reply.code(403).send({ error: 'admin_required' })
      return false
    }
    return true
  }

  function requireDeploy(req, reply) {
    const code = getAdminCodeFromRequest(req)
    if (!isAdminCodeValid(code)) {
      reply.code(403).send({ error: 'admin_required' })
      return false
    }
    return true
  }

  function normalizeLockScope(scope) {
    if (typeof scope !== 'string') return 'global'
    const trimmed = scope.trim()
    return trimmed ? trimmed : 'global'
  }

  function pruneExpiredDeployLocks() {
    const now = Date.now()
    for (const [scope, lock] of deployLocks.entries()) {
      if (!lock || now >= lock.expiresAt) {
        deployLocks.delete(scope)
      }
    }
  }

  function getLockStatus(lock, scope) {
    if (!lock) return { locked: false }
    const ageMs = Math.max(0, Date.now() - lock.acquiredAt)
    const expiresInMs = Math.max(0, lock.expiresAt - Date.now())
    return {
      locked: true,
      owner: lock.owner,
      acquiredAt: lock.acquiredAt,
      ageMs,
      expiresInMs,
      scope,
    }
  }

  function getDeployLockStatus(scope) {
    const normalizedScope = normalizeLockScope(scope)
    pruneExpiredDeployLocks()
    if (normalizedScope !== 'global') {
      const globalLock = deployLocks.get('global')
      if (globalLock) return getLockStatus(globalLock, 'global')
    }
    const lock = deployLocks.get(normalizedScope)
    if (!lock) {
      return { locked: false }
    }
    return getLockStatus(lock, normalizedScope)
  }

  function getBlockingLockStatus(scope) {
    const normalizedScope = normalizeLockScope(scope)
    pruneExpiredDeployLocks()
    const globalLock = deployLocks.get('global')
    if (globalLock) return getLockStatus(globalLock, 'global')
    if (normalizedScope === 'global') {
      for (const [key, lock] of deployLocks.entries()) {
        if (key === 'global') continue
        return getLockStatus(lock, key)
      }
      return null
    }
    const scopedLock = deployLocks.get(normalizedScope)
    if (!scopedLock) return null
    return getLockStatus(scopedLock, normalizedScope)
  }

  function findDeployLockByToken(token) {
    if (!token) return null
    pruneExpiredDeployLocks()
    for (const [scope, lock] of deployLocks.entries()) {
      if (lock?.token === token) {
        return { scope, lock }
      }
    }
    return null
  }

  function ensureDeployLock(token, scope) {
    pruneExpiredDeployLocks()
    const normalizedScope = normalizeLockScope(scope)
    const globalLock = deployLocks.get('global')
    if (globalLock) {
      if (token && token === globalLock.token) {
        return { ok: true }
      }
      return { ok: false, error: 'deploy_locked', lock: getLockStatus(globalLock, 'global') }
    }
    const lock = deployLocks.get(normalizedScope)
    if (!lock) {
      return { ok: false, error: 'deploy_lock_required' }
    }
    if (!token || token !== lock.token) {
      return { ok: false, error: 'deploy_locked', lock: getLockStatus(lock, normalizedScope) }
    }
    return { ok: true }
  }

  function deriveLockScopeFromBlueprintId(id) {
    if (typeof id !== 'string' || !id.trim()) return 'global'
    if (id === '$scene') return '$scene'
    const idx = id.indexOf('__')
    if (idx !== -1) {
      const appName = id.slice(0, idx)
      return appName ? appName : 'global'
    }
    return id
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

  function deriveScriptLockScope(data) {
    const refId =
      data && typeof data.scriptRef === 'string' && data.scriptRef.trim() ? data.scriptRef : data?.id
    return deriveLockScopeFromBlueprintId(refId)
  }

  async function createDeploySnapshot({ ids, target, note, scope } = {}) {
    if (!db) {
      throw new Error('db_unavailable')
    }
    const now = new Date().toISOString()
    const snapshotId = crypto.randomUUID()
    const list = Array.isArray(ids) ? ids : []
    const blueprints = []
    const missing = []
    for (const id of list) {
      const blueprint = world.blueprints.get(id)
      if (blueprint?.id) {
        blueprints.push(blueprint)
      } else {
        missing.push(id)
      }
    }
    const meta = {
      target: typeof target === 'string' ? target : null,
      note: typeof note === 'string' ? note : null,
      scope: typeof scope === 'string' && scope.trim() ? scope.trim() : null,
      worldId: world?.network?.worldId || null,
    }
    await db('deploy_snapshots').insert({
      id: snapshotId,
      data: JSON.stringify(blueprints),
      meta: JSON.stringify(meta),
      createdAt: now,
    })
    return { id: snapshotId, count: blueprints.length, missing, createdAt: now }
  }

  async function getDeploySnapshotById(id) {
    if (!db) {
      throw new Error('db_unavailable')
    }
    return db('deploy_snapshots').where('id', id).first()
  }

  async function getLatestDeploySnapshot() {
    if (!db) {
      throw new Error('db_unavailable')
    }
    return db('deploy_snapshots').orderBy('createdAt', 'desc').first()
  }

  function sendSnapshot(ws, { includePlayers } = {}) {
    sendPacket(ws, 'snapshot', {
      serverTime: performance.now(),
      assetsUrl: assets.url,
      maxUploadSize: process.env.PUBLIC_MAX_UPLOAD_SIZE,
      settings: world.settings.serialize(),
      spawn: world.network.spawn,
      blueprints: world.blueprints.serialize(),
      entities: serializeEntitiesForAdmin(world),
      players: includePlayers ? serializePlayersForAdmin(world) : [],
      hasAdminCode: !!process.env.ADMIN_CODE,
      adminUrl: process.env.PUBLIC_ADMIN_URL,
    })
  }

  world.network.on('entityAdded', data => {
    broadcast('entityAdded', data)
  })
  world.network.on('entityModified', data => {
    broadcast('entityModified', data)
  })
  world.network.on('entityRemoved', id => {
    broadcast('entityRemoved', id)
  })
  world.network.on('blueprintAdded', data => {
    broadcast('blueprintAdded', data)
  })
  world.network.on('blueprintModified', data => {
    broadcast('blueprintModified', data)
  })
  world.network.on('settingsModified', data => {
    broadcast('settingsModified', data)
  })
  world.network.on('spawnModified', data => {
    broadcast('spawnModified', data)
  })
  world.network.on('playerJoined', data => {
    broadcastPlayers('playerJoined', data)
  })
  world.network.on('playerUpdated', data => {
    broadcastPlayers('playerUpdated', data)
  })
  world.network.on('playerLeft', data => {
    broadcastPlayers('playerLeft', data)
  })

  fastify.route({
    method: 'GET',
    url: '/admin',
    handler: async (_req, reply) => {
      if (!adminHtmlPath) {
        return reply.code(404).send()
      }
      const title = world.settings.title || 'World'
      const desc = world.settings.desc || ''
      const image = world.resolveURL(world.settings.image?.url) || ''
      const url = process.env.ASSETS_BASE_URL
      let html = fs.readFileSync(adminHtmlPath, 'utf-8')
      html = html.replaceAll('{url}', url)
      html = html.replaceAll('{title}', title)
      html = html.replaceAll('{desc}', desc)
      html = html.replaceAll('{image}', image)
      reply.type('text/html').send(html)
    },
    wsHandler: (ws, _req) => {
      let authed = false
      let defaultNetworkId = null
      let subscriptions = { snapshot: false, players: false, runtime: false }
      let capabilities = { builder: false, deploy: false }

      const onClose = () => {
        subscribers.delete(ws)
        playerSubscribers.delete(ws)
        runtimeSubscribers.delete(ws)
      }

      ws.on('close', onClose)

      ws.on('message', async raw => {
        const [method, data] = readPacket(raw)
        if (!method) {
          sendPacket(ws, 'adminResult', { ok: false, error: 'invalid_packet' })
          return
        }

        if (!authed) {
          if (method !== 'onAdminAuth') {
            sendPacket(ws, 'adminAuthError', { error: 'unauthorized' })
            ws.close()
            return
          }
          const builderOk = isAdminCodeValid(data?.code)
          const deployOk = builderOk
          if (!builderOk && !deployOk) {
            sendPacket(ws, 'adminAuthError', { error: 'invalid_code' })
            ws.close()
            return
          }
          authed = true
          if (data?.subscriptions && typeof data.subscriptions === 'object') {
            subscriptions = {
              snapshot: !!data.subscriptions.snapshot,
              players: !!data.subscriptions.players,
              runtime: !!data.subscriptions.runtime,
            }
          } else if (data?.needsHeartbeat !== undefined) {
            const wantsHeartbeat = !!data.needsHeartbeat
            subscriptions = { snapshot: wantsHeartbeat, players: wantsHeartbeat, runtime: false }
          }
          defaultNetworkId = data?.networkId || null
          capabilities = { builder: builderOk, deploy: deployOk }
          subscribers.add(ws)
          if (subscriptions.players) playerSubscribers.add(ws)
          if (subscriptions.runtime) runtimeSubscribers.add(ws)
          sendPacket(ws, 'adminAuthOk', { ok: true, capabilities })
          if (subscriptions.snapshot) {
            sendSnapshot(ws, { includePlayers: subscriptions.players })
          }
          return
        }

        if (method !== 'onAdminCommand') {
          sendPacket(ws, 'adminResult', { ok: false, error: 'unknown_type', requestId: data?.requestId })
          return
        }

        const requestId = data?.requestId
        const ignoreNetworkId = data?.networkId || defaultNetworkId || undefined
        const network = world.network

        try {
          if (data.type === 'blueprint_add') {
            if (!capabilities.builder) {
              sendPacket(ws, 'adminResult', { ok: false, error: 'builder_required', requestId })
              return
            }
            if (!data.blueprint?.id) {
              sendPacket(ws, 'adminResult', { ok: false, error: 'invalid_payload', requestId })
              return
            }
            if (hasScriptFields(data.blueprint)) {
              const scope = deriveScriptLockScope(data.blueprint)
              const lockCheck = ensureDeployLock(data?.lockToken, scope)
              if (!lockCheck.ok) {
                sendPacket(ws, 'adminResult', {
                  ok: false,
                  error: lockCheck.error,
                  lock: lockCheck.lock,
                  requestId,
                })
                return
              }
            }
            const result = network.applyBlueprintAdded(data.blueprint, { ignoreNetworkId })
            if (!result.ok) {
              sendPacket(ws, 'adminResult', { ok: false, error: result.error, requestId })
              return
            }
            sendPacket(ws, 'adminResult', { ok: true, requestId })
            return
          }

          if (data.type === 'blueprint_modify') {
            if (!data.change?.id) {
              sendPacket(ws, 'adminResult', { ok: false, error: 'invalid_payload', requestId })
              return
            }
            const change = data.change
            const hasScriptChange = hasScriptFields(change)
            const nonScriptKeys = Object.keys(change).filter(
              key => !['id', 'version', ...SCRIPT_BLUEPRINT_FIELDS].includes(key)
            )
            if (nonScriptKeys.length > 0 && !capabilities.builder) {
              sendPacket(ws, 'adminResult', { ok: false, error: 'builder_required', requestId })
              return
            }
            if (hasScriptChange && !capabilities.deploy) {
              sendPacket(ws, 'adminResult', { ok: false, error: 'admin_required', requestId })
              return
            }
            if (hasScriptChange) {
              const scope = deriveScriptLockScope(change)
              const lockCheck = ensureDeployLock(data?.lockToken, scope)
              if (!lockCheck.ok) {
                sendPacket(ws, 'adminResult', {
                  ok: false,
                  error: lockCheck.error,
                  lock: lockCheck.lock,
                  requestId,
                })
                return
              }
            }
            const result = network.applyBlueprintModified(data.change, { ignoreNetworkId })
            if (!result.ok) {
              sendPacket(ws, 'adminResult', {
                ok: false,
                error: result.error,
                current: result.current,
                requestId,
              })
              if (result.current) {
                sendPacket(ws, 'blueprintModified', result.current)
              }
              return
            }
            sendPacket(ws, 'adminResult', { ok: true, requestId })
            return
          }

          if (data.type === 'template_spawn') {
            if (!capabilities.builder) {
              sendPacket(ws, 'adminResult', { ok: false, error: 'builder_required', requestId })
              return
            }
            const templateId = typeof data.templateId === 'string' ? data.templateId.trim() : ''
            const template = templateId ? getEngineTemplate(templateId) : null
            if (!template) {
              sendPacket(ws, 'adminResult', { ok: false, error: 'template_not_found', requestId })
              return
            }
            const blueprintId = uuid()
            const blueprint = {
              id: blueprintId,
              version: 0,
              name: template.name || template.id || 'Template',
              image: template.image ? cloneDeep(template.image) : null,
              author: null,
              url: null,
              desc: null,
              model: template.model || null,
              script: template.script || null,
              scriptEntry: template.scriptEntry || null,
              scriptFiles: template.scriptFiles ? cloneDeep(template.scriptFiles) : null,
              scriptFormat: template.scriptFormat || null,
              props: template.props ? cloneDeep(template.props) : {},
              preload: !!template.preload,
              public: !!template.public,
              locked: !!template.locked,
              frozen: !!template.frozen,
              unique: !!template.unique,
              scene: false,
              disabled: !!template.disabled,
            }
            const addResult = network.applyBlueprintAdded(blueprint)
            if (!addResult.ok) {
              sendPacket(ws, 'adminResult', { ok: false, error: addResult.error, requestId })
              return
            }

            const position = isNumberArray(data.position, 3) ? data.position : [0, 0, 0]
            const quaternion = isNumberArray(data.quaternion, 4) ? data.quaternion : [0, 0, 0, 1]
            const scale = isNumberArray(data.scale, 3) ? data.scale : [1, 1, 1]
            const mover = data?.mover === false ? null : defaultNetworkId || null
            const entityId = uuid()
            const entity = {
              id: entityId,
              type: 'app',
              blueprint: blueprintId,
              position,
              quaternion,
              scale,
              mover,
              uploader: null,
              pinned: false,
              props: {},
              state: {},
            }
            network.applyEntityAdded(entity)
            sendPacket(ws, 'adminResult', { ok: true, requestId, blueprintId, entityId })
            return
          }

          if (data.type === 'entity_add') {
            if (!capabilities.builder) {
              sendPacket(ws, 'adminResult', { ok: false, error: 'builder_required', requestId })
              return
            }
            if (!data.entity?.id) {
              sendPacket(ws, 'adminResult', { ok: false, error: 'invalid_payload', requestId })
              return
            }
            const result = network.applyEntityAdded(data.entity, { ignoreNetworkId })
            if (!result.ok) {
              sendPacket(ws, 'adminResult', { ok: false, error: result.error, requestId })
              return
            }
            sendPacket(ws, 'adminResult', { ok: true, requestId })
            return
          }

          if (data.type === 'entity_modify') {
            if (!capabilities.builder) {
              sendPacket(ws, 'adminResult', { ok: false, error: 'builder_required', requestId })
              return
            }
            if (!data.change?.id) {
              sendPacket(ws, 'adminResult', { ok: false, error: 'invalid_payload', requestId })
              return
            }
            const result = await network.applyEntityModified(data.change, { ignoreNetworkId })
            if (!result.ok) {
              sendPacket(ws, 'adminResult', { ok: false, error: result.error, requestId })
              return
            }
            sendPacket(ws, 'adminResult', { ok: true, requestId })
            return
          }

          if (data.type === 'entity_remove') {
            if (!capabilities.builder) {
              sendPacket(ws, 'adminResult', { ok: false, error: 'builder_required', requestId })
              return
            }
            if (!data.id) {
              sendPacket(ws, 'adminResult', { ok: false, error: 'invalid_payload', requestId })
              return
            }
            const result = network.applyEntityRemoved(data.id, { ignoreNetworkId })
            if (!result.ok) {
              sendPacket(ws, 'adminResult', { ok: false, error: result.error, requestId })
              return
            }
            sendPacket(ws, 'adminResult', { ok: true, requestId })
            return
          }

          if (data.type === 'settings_modify') {
            if (!capabilities.builder) {
              sendPacket(ws, 'adminResult', { ok: false, error: 'builder_required', requestId })
              return
            }
            if (!data.key) {
              sendPacket(ws, 'adminResult', { ok: false, error: 'invalid_payload', requestId })
              return
            }
            const result = network.applySettingsModified({ key: data.key, value: data.value }, { ignoreNetworkId })
            if (!result.ok) {
              sendPacket(ws, 'adminResult', { ok: false, error: result.error, requestId })
              return
            }
            sendPacket(ws, 'adminResult', { ok: true, requestId })
            return
          }

          if (data.type === 'spawn_modify') {
            if (!capabilities.builder) {
              sendPacket(ws, 'adminResult', { ok: false, error: 'builder_required', requestId })
              return
            }
            if (!data.op) {
              sendPacket(ws, 'adminResult', { ok: false, error: 'invalid_payload', requestId })
              return
            }
            const result = await network.applySpawnModified({
              op: data.op,
              networkId: data.networkId || defaultNetworkId,
            })
            if (!result.ok) {
              sendPacket(ws, 'adminResult', { ok: false, error: result.error, requestId })
              return
            }
            sendPacket(ws, 'adminResult', { ok: true, requestId })
            return
          }

          if (data.type === 'modify_rank') {
            if (!capabilities.builder) {
              sendPacket(ws, 'adminResult', { ok: false, error: 'builder_required', requestId })
              return
            }
            if (!data.playerId || typeof data.rank !== 'number') {
              sendPacket(ws, 'adminResult', { ok: false, error: 'invalid_payload', requestId })
              return
            }
            const result = await network.applyModifyRank({ playerId: data.playerId, rank: data.rank })
            if (!result.ok) {
              sendPacket(ws, 'adminResult', { ok: false, error: result.error, requestId })
              return
            }
            sendPacket(ws, 'adminResult', { ok: true, requestId })
            return
          }

          if (data.type === 'kick') {
            if (!capabilities.builder) {
              sendPacket(ws, 'adminResult', { ok: false, error: 'builder_required', requestId })
              return
            }
            if (!data.playerId) {
              sendPacket(ws, 'adminResult', { ok: false, error: 'invalid_payload', requestId })
              return
            }
            const result = network.applyKick(data.playerId)
            if (!result.ok) {
              sendPacket(ws, 'adminResult', { ok: false, error: result.error, requestId })
              return
            }
            sendPacket(ws, 'adminResult', { ok: true, requestId })
            return
          }

          if (data.type === 'mute') {
            if (!capabilities.builder) {
              sendPacket(ws, 'adminResult', { ok: false, error: 'builder_required', requestId })
              return
            }
            if (!data.playerId || typeof data.muted !== 'boolean') {
              sendPacket(ws, 'adminResult', { ok: false, error: 'invalid_payload', requestId })
              return
            }
            const result = network.applyMute({ playerId: data.playerId, muted: data.muted })
            if (!result.ok) {
              sendPacket(ws, 'adminResult', { ok: false, error: result.error, requestId })
              return
            }
            sendPacket(ws, 'adminResult', { ok: true, requestId })
            return
          }

          sendPacket(ws, 'adminResult', { ok: false, error: 'unknown_type', requestId })
        } catch (err) {
          console.error('[admin] handler error', err)
          sendPacket(ws, 'adminResult', { ok: false, error: 'server_error', requestId })
        }
      })
    },
  })

  fastify.get('/admin/snapshot', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const network = world.network
    return {
      worldId: network.worldId,
      assetsUrl: assets.url,
      maxUploadSize: process.env.PUBLIC_MAX_UPLOAD_SIZE,
      settings: world.settings.serialize(),
      spawn: network.spawn,
      blueprints: world.blueprints.serialize(),
      entities: serializeEntitiesForAdmin(world),
      players: serializePlayersForAdmin(world),
      hasAdminCode: !!process.env.ADMIN_CODE,
      adminUrl: process.env.PUBLIC_ADMIN_URL,
    }
  })

  fastify.get('/admin/deploy-lock', async (req, reply) => {
    if (!requireDeploy(req, reply)) return
    const scope = normalizeHeader(req.query?.scope)
    return getDeployLockStatus(scope)
  })

  fastify.post('/admin/deploy-lock', async (req, reply) => {
    if (!requireDeploy(req, reply)) return
    const rawScope = normalizeHeader(req.body?.scope)
    const status = getBlockingLockStatus(rawScope)
    if (status?.locked) {
      return reply.code(409).send({ error: 'locked', lock: status })
    }
    const scope = normalizeLockScope(rawScope)
    const owner = typeof req.body?.owner === 'string' && req.body.owner.trim() ? req.body.owner.trim() : 'unknown'
    const ttlSeconds = Number.parseInt(req.body?.ttl, 10)
    const ttlMs =
      Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds * 1000 : lockTtlMs
    const token = crypto.randomUUID()
    const now = Date.now()
    deployLocks.set(scope, {
      token,
      owner,
      acquiredAt: now,
      expiresAt: now + ttlMs,
    })
    return { ok: true, token, ttlMs }
  })

  fastify.put('/admin/deploy-lock', async (req, reply) => {
    if (!requireDeploy(req, reply)) return
    const token = req.body?.token
    const rawScope = normalizeHeader(req.body?.scope)
    const hasExplicitScope = typeof rawScope === 'string' && rawScope.trim()
    let scope = normalizeLockScope(rawScope)
    if (!hasExplicitScope) {
      const found = findDeployLockByToken(token)
      if (found) scope = found.scope
    }
    pruneExpiredDeployLocks()
    const lock = deployLocks.get(scope)
    if (!lock) {
      return reply.code(409).send({ error: 'not_locked' })
    }
    if (!token || token !== lock.token) {
      return reply.code(409).send({ error: 'not_owner', lock: getLockStatus(lock, scope) })
    }
    const ttlSeconds = Number.parseInt(req.body?.ttl, 10)
    const ttlMs =
      Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds * 1000 : lockTtlMs
    lock.expiresAt = Date.now() + ttlMs
    return { ok: true, ttlMs }
  })

  fastify.delete('/admin/deploy-lock', async (req, reply) => {
    if (!requireDeploy(req, reply)) return
    const token = req.body?.token
    const rawScope = normalizeHeader(req.body?.scope)
    const hasExplicitScope = typeof rawScope === 'string' && rawScope.trim()
    let scope = normalizeLockScope(rawScope)
    if (!hasExplicitScope) {
      const found = findDeployLockByToken(token)
      if (found) scope = found.scope
    }
    pruneExpiredDeployLocks()
    const lock = deployLocks.get(scope)
    if (!lock) {
      return reply.code(409).send({ error: 'not_locked' })
    }
    if (!token || token !== lock.token) {
      return reply.code(409).send({ error: 'not_owner', lock: getLockStatus(lock, scope) })
    }
    deployLocks.delete(scope)
    return { ok: true }
  })

  fastify.post('/admin/deploy-snapshots', async (req, reply) => {
    if (!requireDeploy(req, reply)) return
    const ids = req.body?.ids
    const scopeSet = new Set()
    if (Array.isArray(ids)) {
      for (const id of ids) {
        scopeSet.add(deriveLockScopeFromBlueprintId(id))
      }
    }
    if (scopeSet.size > 1) {
      return reply.code(400).send({ error: 'multi_scope_not_supported' })
    }
    const scope = normalizeHeader(req.body?.scope)
    const lockCheck = ensureDeployLock(req.body?.lockToken, scope)
    if (!lockCheck.ok) {
      return reply.code(409).send({ error: lockCheck.error, lock: lockCheck.lock })
    }
    try {
      const result = await createDeploySnapshot({
        ids,
        target: req.body?.target,
        note: req.body?.note,
        scope,
      })
      return { ok: true, ...result }
    } catch (err) {
      console.error('[admin] deploy snapshot failed', err)
      return reply.code(500).send({ error: 'snapshot_failed' })
    }
  })

  fastify.post('/admin/deploy-snapshots/rollback', async (req, reply) => {
    if (!requireDeploy(req, reply)) return
    const scope = normalizeHeader(req.body?.scope)
    const lockCheck = ensureDeployLock(req.body?.lockToken, scope)
    if (!lockCheck.ok) {
      return reply.code(409).send({ error: lockCheck.error, lock: lockCheck.lock })
    }
    try {
      const snapshotId = req.body?.id
      const row = snapshotId ? await getDeploySnapshotById(snapshotId) : await getLatestDeploySnapshot()
      if (!row) {
        return reply.code(404).send({ error: 'not_found' })
      }
      const blueprints = JSON.parse(row.data || '[]')
      const restored = []
      const failed = []
      for (const blueprint of blueprints) {
        if (!blueprint?.id) continue
        const current = world.blueprints.get(blueprint.id)
        if (!current) {
          const result = world.network.applyBlueprintAdded(blueprint)
          if (result.ok) {
            restored.push(blueprint.id)
          } else {
            failed.push({ id: blueprint.id, error: result.error })
          }
          continue
        }
        const change = { ...blueprint, version: (current.version || 0) + 1 }
        const result = world.network.applyBlueprintModified(change)
        if (result.ok) {
          restored.push(blueprint.id)
        } else {
          failed.push({ id: blueprint.id, error: result.error })
        }
      }
      return { ok: true, snapshotId: row.id, restored, failed }
    } catch (err) {
      console.error('[admin] rollback failed', err)
      return reply.code(500).send({ error: 'rollback_failed' })
    }
  })

  fastify.get('/admin/blueprints/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const blueprint = world.blueprints.get(req.params.id)
    if (!blueprint) {
      return reply.code(404).send({ error: 'not_found' })
    }
    return { blueprint }
  })

  fastify.delete('/admin/blueprints/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const result = await world.network.applyBlueprintRemoved({ id: req.params.id })
    if (!result.ok) {
      if (result.error === 'not_found') {
        return reply.code(404).send({ error: result.error })
      }
      if (result.error === 'in_use') {
        return reply.code(409).send({ error: result.error })
      }
      return reply.code(400).send({ error: result.error })
    }
    broadcast('blueprintRemoved', { id: req.params.id })
    return { ok: true }
  })

  fastify.get('/admin/entities', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const type = req.query?.type
    const entities = serializeEntitiesForAdmin(world)
    if (typeof type !== 'string' || !type) {
      return { entities }
    }
    return { entities: entities.filter(e => e?.type === type) }
  })

  fastify.get('/admin/upload-check', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const exists = await assets.exists(req.query.filename)
    return { exists }
  })

  fastify.put('/admin/spawn', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const { position, quaternion } = req.body || {}
    const result = await world.network.applySpawnSet({ position, quaternion })
    if (!result.ok) {
      return reply.code(400).send({ error: result.error })
    }
    broadcast('spawnModified', world.network.spawn)
    return { ok: true, spawn: world.network.spawn }
  })

  fastify.post('/admin/upload', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const mp = await req.file()
    // collect into buffer
    const chunks = []
    for await (const chunk of mp.file) {
      chunks.push(chunk)
    }
    const buffer = Buffer.concat(chunks)
    // convert to file
    const file = new File([buffer], mp.filename, {
      type: mp.mimetype || 'application/octet-stream',
    })
    await assets.upload(file)
    return { ok: true, filename: mp.filename }
  })
}
