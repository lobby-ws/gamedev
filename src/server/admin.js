import crypto from 'crypto'
import fs from 'fs'

import { readPacket, writePacket } from '../core/packets.js'
import { cleaner } from './cleaner'

const SCRIPT_BLUEPRINT_FIELDS = new Set([
  'script',
  'scriptEntry',
  'scriptFiles',
  'scriptFormat',
  'scriptRef',
])
const CHANGEFEED_TABLE = 'sync_changes'
const CHANGEFEED_DEFAULT_LIMIT = 200
const CHANGEFEED_MAX_LIMIT = 1000

function normalizeHeader(value) {
  if (Array.isArray(value)) return value[0]
  return value
}

function normalizeOperationValue(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function normalizeIsoTimestamp(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Date.parse(trimmed)
  if (!Number.isFinite(parsed)) return null
  return new Date(parsed).toISOString()
}

function toCursorNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value))
  }
  if (typeof value === 'bigint') {
    const asNumber = Number(value)
    if (Number.isFinite(asNumber)) {
      return Math.max(0, Math.floor(asNumber))
    }
    return 0
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return 0
    if (!/^\d+$/.test(trimmed)) return 0
    const parsed = Number.parseInt(trimmed, 10)
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
  }
  return 0
}

function parseChangefeedCursor(value) {
  if (value === undefined || value === null) {
    return { ok: true, mode: 'head', cursor: null }
  }
  const normalized = typeof value === 'string' ? value.trim() : value
  if (normalized === '') {
    return { ok: true, mode: 'head', cursor: null }
  }
  if (typeof normalized === 'string' && normalized.toLowerCase() === 'latest') {
    return { ok: true, mode: 'head', cursor: null }
  }
  if (typeof normalized === 'number' && Number.isFinite(normalized) && Number.isInteger(normalized) && normalized >= 0) {
    return { ok: true, mode: 'after', cursor: normalized }
  }
  if (typeof normalized === 'string' && /^\d+$/.test(normalized)) {
    const cursor = Number.parseInt(normalized, 10)
    return { ok: true, mode: 'after', cursor }
  }
  return { ok: false, error: 'invalid_cursor' }
}

function parseChangefeedLimit(value) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, limit: CHANGEFEED_DEFAULT_LIMIT }
  }
  const normalized = typeof value === 'string' ? value.trim() : value
  if (typeof normalized === 'number' && Number.isFinite(normalized) && Number.isInteger(normalized)) {
    if (normalized < 1 || normalized > CHANGEFEED_MAX_LIMIT) {
      return { ok: false, error: 'invalid_limit' }
    }
    return { ok: true, limit: normalized }
  }
  if (typeof normalized === 'string' && /^\d+$/.test(normalized)) {
    const parsed = Number.parseInt(normalized, 10)
    if (parsed < 1 || parsed > CHANGEFEED_MAX_LIMIT) {
      return { ok: false, error: 'invalid_limit' }
    }
    return { ok: true, limit: parsed }
  }
  return { ok: false, error: 'invalid_limit' }
}

function parseChangePayload(value) {
  if (typeof value !== 'string') return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function serializeChangePayload(value) {
  if (value === undefined) return null
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function serializeChangeRow(operation) {
  if (!operation || typeof operation !== 'object') return null
  const opId = normalizeOperationValue(operation.opId)
  const kind = normalizeOperationValue(operation.kind)
  const objectUid = normalizeOperationValue(operation.objectUid)
  if (!opId || !kind || !objectUid) return null
  const ts = normalizeIsoTimestamp(operation.ts) || new Date().toISOString()
  const actor = normalizeOperationValue(operation.actor) || 'runtime'
  const source = normalizeOperationValue(operation.source) || 'runtime'
  return {
    opId,
    ts,
    actor,
    source,
    kind,
    objectUid,
    patch: serializeChangePayload(operation.patch),
    snapshot: serializeChangePayload(operation.snapshot),
    createdAt: ts,
  }
}

function deserializeChangeRow(row) {
  if (!row || typeof row !== 'object') return null
  const opId = normalizeOperationValue(row.opId)
  const kind = normalizeOperationValue(row.kind)
  const objectUid = normalizeOperationValue(row.objectUid)
  if (!opId || !kind || !objectUid) return null
  const op = {
    cursor: toCursorNumber(row.cursor),
    opId,
    ts: normalizeIsoTimestamp(typeof row.ts === 'string' ? row.ts : row.ts?.toISOString?.()) || new Date().toISOString(),
    actor: normalizeOperationValue(row.actor) || 'runtime',
    source: normalizeOperationValue(row.source) || 'runtime',
    kind,
    objectUid,
  }
  if (row.patch !== null && row.patch !== undefined) {
    op.patch = parseChangePayload(row.patch)
  }
  if (row.snapshot !== null && row.snapshot !== undefined) {
    op.snapshot = parseChangePayload(row.snapshot)
  }
  return op
}

function isUniqueConstraintError(err) {
  const code = normalizeOperationValue(err?.code)
  if (code === '23505' || code === 'SQLITE_CONSTRAINT' || code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return true
  }
  const message = (err?.message || '').toString()
  return /unique|constraint/i.test(message)
}

const AUTH_MODE = (process.env.AUTH_MODE || 'standalone').trim().toLowerCase()
const REQUIRE_ADMIN_CODE = AUTH_MODE === 'platform'

function isCodeValid(expected, code) {
  if (!expected) return !REQUIRE_ADMIN_CODE
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
  let changefeedWriteQueue = Promise.resolve()
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

  function broadcastRuntime(name, payload) {
    for (const ws of runtimeSubscribers) {
      sendPacket(ws, name, payload)
    }
  }

  function queueChangefeedOperation(operation) {
    if (!db) return
    const row = serializeChangeRow(operation)
    if (!row) return
    changefeedWriteQueue = changefeedWriteQueue
      .then(async () => {
        try {
          await db(CHANGEFEED_TABLE).insert(row).onConflict('opId').ignore()
        } catch (err) {
          if (!isUniqueConstraintError(err)) {
            throw err
          }
        }
      })
      .catch(err => {
        console.error('[admin] changefeed insert failed', err)
      })
  }

  async function getChangefeedHeadCursor() {
    if (!db) return 0
    const row = await db(CHANGEFEED_TABLE).max({ cursor: 'cursor' }).first()
    return toCursorNumber(row?.cursor)
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

  function normalizeMetadataScope(scope) {
    if (typeof scope !== 'string') return null
    const trimmed = scope.trim()
    return trimmed || null
  }

  function getBlueprintMetadataScope(blueprint) {
    if (!blueprint || typeof blueprint !== 'object') return null
    return normalizeMetadataScope(blueprint.scope)
  }

  function resolveBlueprintScopeById(id) {
    const normalizedId = normalizeOperationValue(id)
    if (!normalizedId) return null
    const blueprint = world.blueprints.get(normalizedId)
    return getBlueprintMetadataScope(blueprint)
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

  function resolveScriptOperationScope(data, currentBlueprint = null) {
    if (!data || typeof data !== 'object') {
      return { ok: false, error: 'scope_unknown' }
    }
    const explicitScope = getBlueprintMetadataScope(data)
    const currentScope = getBlueprintMetadataScope(currentBlueprint)
    const scriptRef = normalizeOperationValue(data.scriptRef)
    const refScope = scriptRef ? resolveBlueprintScopeById(scriptRef) : null

    if (explicitScope && currentScope && explicitScope !== currentScope) {
      return {
        ok: false,
        error: 'scope_mismatch',
        details: { requestedScope: explicitScope, currentScope },
      }
    }
    if (explicitScope && refScope && explicitScope !== refScope) {
      return {
        ok: false,
        error: 'scope_mismatch',
        details: { requestedScope: explicitScope, refScope, refId: scriptRef },
      }
    }
    if (currentScope && refScope && currentScope !== refScope) {
      return {
        ok: false,
        error: 'scope_mismatch',
        details: { currentScope, refScope, refId: scriptRef },
      }
    }

    const resolvedScope = explicitScope || currentScope || refScope
    if (!resolvedScope) {
      const details = scriptRef ? { refId: scriptRef } : undefined
      return { ok: false, error: 'scope_unknown', details }
    }
    return { ok: true, scope: resolvedScope }
  }

  function collectScopeSetFromBlueprintIds(ids) {
    const list = Array.isArray(ids) ? ids : []
    const scopeSet = new Set()
    const unknown = []
    const missing = []
    for (const rawId of list) {
      const id = normalizeOperationValue(rawId)
      if (!id) continue
      const blueprint = world.blueprints.get(id)
      if (!blueprint) {
        missing.push(id)
        continue
      }
      const scope = getBlueprintMetadataScope(blueprint)
      if (!scope) {
        unknown.push(id)
        continue
      }
      scopeSet.add(scope)
    }
    return { scopeSet, unknown, missing }
  }

  function collectScopeSetFromBlueprintList(blueprints) {
    const list = Array.isArray(blueprints) ? blueprints : []
    const scopeSet = new Set()
    const unknown = []
    for (const blueprint of list) {
      const id = normalizeOperationValue(blueprint?.id) || 'unknown'
      const scope = getBlueprintMetadataScope(blueprint)
      if (!scope) {
        unknown.push(id)
        continue
      }
      scopeSet.add(scope)
    }
    return { scopeSet, unknown }
  }

  function validateScopedOperation(scopeSet, requestedScope) {
    if (!(scopeSet instanceof Set) || scopeSet.size === 0) {
      return { ok: true }
    }
    if (requestedScope === 'global') {
      return { ok: true }
    }
    if (scopeSet.size > 1) {
      return {
        ok: false,
        error: 'multi_scope_not_supported',
        scopes: Array.from(scopeSet.values()),
      }
    }
    const [scope] = Array.from(scopeSet.values())
    if (scope !== requestedScope) {
      return {
        ok: false,
        error: 'scope_mismatch',
        scope: requestedScope,
        scopes: [scope],
      }
    }
    return { ok: true }
  }

  function resolveSnapshotScope(scopeSet, { hasExplicitScope, requestedScope } = {}) {
    if (hasExplicitScope) return requestedScope
    if (scopeSet instanceof Set && scopeSet.size === 1) {
      return Array.from(scopeSet.values())[0]
    }
    return null
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
    return db('deploy_snapshots').where({ id }).first()
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
  world.network.on('blueprintRemoved', data => {
    broadcast('blueprintRemoved', data)
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
  world.network.on('operation', operation => {
    queueChangefeedOperation(operation)
    broadcastRuntime('runtimeOperation', operation)
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
        const actor = normalizeOperationValue(data?.actor) || ignoreNetworkId || 'admin'
        const source = normalizeOperationValue(data?.source) || 'admin'
        const lastOpId = normalizeOperationValue(data?.lastOpId) || undefined

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
              const scopeResult = resolveScriptOperationScope(data.blueprint)
              if (!scopeResult.ok) {
                sendPacket(ws, 'adminResult', {
                  ok: false,
                  error: scopeResult.error,
                  details: scopeResult.details,
                  requestId,
                })
                return
              }
              const lockCheck = ensureDeployLock(data?.lockToken, scopeResult.scope)
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
            const result = network.applyBlueprintAdded(data.blueprint, {
              ignoreNetworkId,
              actor,
              source,
              lastOpId,
            })
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
              const currentBlueprint = world.blueprints.get(change.id)
              if (!currentBlueprint) {
                sendPacket(ws, 'adminResult', { ok: false, error: 'not_found', requestId })
                return
              }
              const scopeResult = resolveScriptOperationScope(change, currentBlueprint)
              if (!scopeResult.ok) {
                sendPacket(ws, 'adminResult', {
                  ok: false,
                  error: scopeResult.error,
                  details: scopeResult.details,
                  requestId,
                })
                return
              }
              const lockCheck = ensureDeployLock(data?.lockToken, scopeResult.scope)
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
            const result = network.applyBlueprintModified(data.change, {
              ignoreNetworkId,
              actor,
              source,
              lastOpId,
            })
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

          if (data.type === 'entity_add') {
            if (!capabilities.builder) {
              sendPacket(ws, 'adminResult', { ok: false, error: 'builder_required', requestId })
              return
            }
            if (!data.entity?.id) {
              sendPacket(ws, 'adminResult', { ok: false, error: 'invalid_payload', requestId })
              return
            }
            const result = network.applyEntityAdded(data.entity, {
              ignoreNetworkId,
              actor,
              source,
              lastOpId,
            })
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
            const result = await network.applyEntityModified(data.change, {
              ignoreNetworkId,
              actor,
              source,
              lastOpId,
            })
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
            const result = network.applyEntityRemoved(data.id, {
              ignoreNetworkId,
              actor,
              source,
              lastOpId,
            })
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
            const result = network.applySettingsModified(
              { key: data.key, value: data.value },
              {
                ignoreNetworkId,
                actor,
                source,
                lastOpId,
              }
            )
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
            }, {
              actor,
              source,
              lastOpId,
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

  fastify.get('/admin/changes', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    if (!db) {
      return reply.code(500).send({ error: 'db_unavailable' })
    }

    const cursorInput = normalizeHeader(req.query?.cursor)
    const limitInput = normalizeHeader(req.query?.limit)
    const cursorResult = parseChangefeedCursor(cursorInput)
    if (!cursorResult.ok) {
      return reply.code(400).send({ error: cursorResult.error })
    }
    const limitResult = parseChangefeedLimit(limitInput)
    if (!limitResult.ok) {
      return reply.code(400).send({ error: limitResult.error })
    }

    await changefeedWriteQueue
    const headCursor = await getChangefeedHeadCursor()
    if (cursorResult.mode === 'head') {
      return {
        cursor: headCursor,
        headCursor,
        operations: [],
        hasMore: false,
      }
    }

    const rows = await db(CHANGEFEED_TABLE)
      .where('cursor', '>', cursorResult.cursor)
      .orderBy('cursor', 'asc')
      .limit(limitResult.limit)
    const operations = rows.map(deserializeChangeRow).filter(Boolean)
    const nextCursor = operations.length > 0 ? operations[operations.length - 1].cursor : cursorResult.cursor

    return {
      cursor: nextCursor,
      headCursor,
      operations,
      hasMore: nextCursor < headCursor,
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
    const rawScope = normalizeHeader(req.body?.scope)
    const hasExplicitScope = typeof rawScope === 'string' && rawScope.trim()
    const normalizedScope = normalizeLockScope(rawScope)
    const ids = req.body?.ids
    const { scopeSet, unknown } = collectScopeSetFromBlueprintIds(ids)
    if (unknown.length > 0) {
      return reply.code(400).send({ error: 'scope_unknown', ids: unknown })
    }
    const scopeValidation = validateScopedOperation(scopeSet, normalizedScope)
    if (!scopeValidation.ok) {
      return reply.code(400).send(scopeValidation)
    }
    const effectiveScope = resolveSnapshotScope(scopeSet, {
      hasExplicitScope,
      requestedScope: normalizedScope,
    })
    const lockCheck = ensureDeployLock(req.body?.lockToken, effectiveScope)
    if (!lockCheck.ok) {
      return reply.code(409).send({ error: lockCheck.error, lock: lockCheck.lock })
    }
    try {
      const result = await createDeploySnapshot({
        ids,
        target: req.body?.target,
        note: req.body?.note,
        scope: effectiveScope,
      })
      return { ok: true, ...result }
    } catch (err) {
      console.error('[admin] deploy snapshot failed', err)
      return reply.code(500).send({ error: 'snapshot_failed' })
    }
  })

  fastify.post('/admin/deploy-snapshots/rollback', async (req, reply) => {
    if (!requireDeploy(req, reply)) return
    const rawScope = normalizeHeader(req.body?.scope)
    const hasExplicitScope = typeof rawScope === 'string' && rawScope.trim()
    const normalizedScope = normalizeLockScope(rawScope)
    try {
      const snapshotId = req.body?.id
      const row = snapshotId ? await getDeploySnapshotById(snapshotId) : await getLatestDeploySnapshot()
      if (!row) {
        return reply.code(404).send({ error: 'not_found' })
      }
      const blueprints = JSON.parse(row.data || '[]')
      const meta = row.meta ? JSON.parse(row.meta) : null
      const { scopeSet, unknown } = collectScopeSetFromBlueprintList(blueprints)
      if (unknown.length > 0) {
        return reply.code(400).send({ error: 'scope_unknown', ids: unknown })
      }
      const scopeValidation = validateScopedOperation(scopeSet, normalizedScope)
      if (!scopeValidation.ok) {
        return reply.code(400).send(scopeValidation)
      }
      const metaScope = normalizeMetadataScope(meta?.scope)
      const effectiveScope =
        resolveSnapshotScope(scopeSet, {
          hasExplicitScope,
          requestedScope: normalizedScope,
        }) || (!hasExplicitScope ? metaScope : null)
      const lockCheck = ensureDeployLock(req.body?.lockToken, effectiveScope)
      if (!lockCheck.ok) {
        return reply.code(409).send({ error: lockCheck.error, lock: lockCheck.lock })
      }

      const restored = []
      const failed = []
      for (const blueprint of blueprints) {
        if (!blueprint?.id) continue
        const current = world.blueprints.get(blueprint.id)
        if (!current) {
          const result = world.network.applyBlueprintAdded(blueprint, {
            actor: 'admin',
            source: 'admin.rollback',
          })
          if (result.ok) {
            restored.push(blueprint.id)
          } else {
            failed.push({ id: blueprint.id, error: result.error })
          }
          continue
        }
        const change = { ...blueprint, version: (current.version || 0) + 1 }
        const result = world.network.applyBlueprintModified(change, {
          actor: 'admin',
          source: 'admin.rollback',
        })
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
    const result = await world.network.applyBlueprintRemoved(
      { id: req.params.id },
      {
        actor: 'admin',
        source: 'admin.http',
      }
    )
    if (!result.ok) {
      if (result.error === 'not_found') {
        return reply.code(404).send({ error: result.error })
      }
      if (result.error === 'in_use') {
        return reply.code(409).send({ error: result.error })
      }
      return reply.code(400).send({ error: result.error })
    }
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
    const result = await world.network.applySpawnSet(
      { position, quaternion },
      {
        actor: 'admin',
        source: 'admin.http',
      }
    )
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

  fastify.post('/admin/clean', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    if (!db) {
      return reply.code(500).send({ error: 'db_unavailable' })
    }
    try {
      if (world?.network?.save) {
        if (world.network.saveTimerId) {
          clearTimeout(world.network.saveTimerId)
          world.network.saveTimerId = null
        }
        await world.network.save()
      }
      const dryrun = req.body?.dryrun === true || req.body?.dryRun === true
      const result = await cleaner.run({
        db,
        dryrun,
        world,
        broadcast,
      })
      return result
    } catch (err) {
      console.error('[admin] clean failed', err)
      return reply.code(500).send({ error: 'clean_failed' })
    }
  })
}
