import crypto from 'crypto'
import fs from 'fs'

import { readPacket, writePacket } from '../core/packets.js'

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

function isDeployCodeValid(code, builderOk) {
  const deployCode = process.env.DEPLOY_CODE
  if (deployCode) {
    return isCodeValid(deployCode, code)
  }
  return builderOk
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
  const heartbeatSubscribers = new Set()

  function broadcast(name, payload) {
    for (const ws of subscribers) {
      sendPacket(ws, name, payload)
    }
  }

  function broadcastHeartbeat(name, payload) {
    for (const ws of heartbeatSubscribers) {
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

  function sendSnapshot(ws) {
    sendPacket(ws, 'snapshot', {
      serverTime: performance.now(),
      assetsUrl: assets.url,
      maxUploadSize: process.env.PUBLIC_MAX_UPLOAD_SIZE,
      settings: world.settings.serialize(),
      spawn: world.network.spawn,
      blueprints: world.blueprints.serialize(),
      entities: serializeEntitiesForAdmin(world),
      players: serializePlayersForAdmin(world),
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
    broadcastHeartbeat('playerJoined', data)
  })
  world.network.on('playerUpdated', data => {
    broadcastHeartbeat('playerUpdated', data)
  })
  world.network.on('playerLeft', data => {
    broadcastHeartbeat('playerLeft', data)
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
      let needsHeartbeat = false
      let capabilities = { builder: false, deploy: false }

      const onClose = () => {
        subscribers.delete(ws)
        heartbeatSubscribers.delete(ws)
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
          const deployOk = isDeployCodeValid(data?.deployCode, builderOk)
          if (!builderOk && !deployOk) {
            sendPacket(ws, 'adminAuthError', { error: 'invalid_code' })
            ws.close()
            return
          }
          authed = true
          needsHeartbeat = !!data?.needsHeartbeat
          defaultNetworkId = data?.networkId || null
          capabilities = { builder: builderOk, deploy: deployOk }
          subscribers.add(ws)
          if (needsHeartbeat) heartbeatSubscribers.add(ws)
          sendPacket(ws, 'adminAuthOk', { ok: true, capabilities })
          if (needsHeartbeat) {
            sendSnapshot(ws)
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
            const hasScriptChange = Object.prototype.hasOwnProperty.call(change, 'script')
            const nonScriptKeys = Object.keys(change).filter(key => !['id', 'version', 'script'].includes(key))
            if (nonScriptKeys.length > 0 && !capabilities.builder) {
              sendPacket(ws, 'adminResult', { ok: false, error: 'builder_required', requestId })
              return
            }
            if (hasScriptChange && !capabilities.deploy) {
              sendPacket(ws, 'adminResult', { ok: false, error: 'deploy_required', requestId })
              return
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
