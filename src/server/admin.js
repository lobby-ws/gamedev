import crypto from 'crypto'

function normalizeHeader(value) {
  if (Array.isArray(value)) return value[0]
  return value
}

function isAdminCodeValid(code) {
  const adminCode = process.env.ADMIN_CODE
  if (!adminCode) return true
  if (typeof code !== 'string') return false
  const adminBuf = Buffer.from(adminCode)
  const codeBuf = Buffer.from(code)
  if (adminBuf.length !== codeBuf.length) return false
  return crypto.timingSafeEqual(adminBuf, codeBuf)
}

function getAdminCodeFromRequest(req) {
  const header = normalizeHeader(req.headers['x-admin-code'])
  return typeof header === 'string' ? header : null
}

function sendJson(ws, payload) {
  try {
    ws.send(JSON.stringify(payload))
  } catch (err) {
    console.error('[admin] failed to send message', err)
  }
}

export async function admin(fastify, { world, assets }) {
  const subscribers = new Set()

  function broadcast(message, { ignore } = {}) {
    for (const ws of subscribers) {
      if (ignore && ws === ignore) continue
      sendJson(ws, message)
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

  fastify.get('/admin', { websocket: true }, (ws, _req) => {
    let authed = false
    let defaultNetworkId = null

    ws.on('message', async raw => {
      let msg
      try {
        const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
        msg = JSON.parse(text)
      } catch (err) {
        sendJson(ws, { type: 'error', error: 'invalid_json' })
        return
      }

      if (!authed) {
        if (msg?.type !== 'auth') {
          sendJson(ws, { type: 'auth_error', error: 'unauthorized' })
          ws.close()
          return
        }
        if (!isAdminCodeValid(msg.code)) {
          sendJson(ws, { type: 'auth_error', error: 'invalid_code' })
          ws.close()
          return
        }
        authed = true
        defaultNetworkId = msg.networkId || null
        subscribers.add(ws)
        ws.on('close', () => {
          subscribers.delete(ws)
        })
        sendJson(ws, { type: 'auth_ok' })
        return
      }

      const requestId = msg?.requestId
      const ignoreNetworkId = msg?.networkId || defaultNetworkId || undefined
      const network = world.network

      try {
        if (msg.type === 'blueprint_add') {
          if (!msg.blueprint?.id) {
            sendJson(ws, { type: 'error', error: 'invalid_payload', requestId })
            return
          }
          const result = network.applyBlueprintAdded(msg.blueprint, { ignoreNetworkId })
          if (!result.ok) {
            sendJson(ws, { type: 'error', error: result.error, requestId })
            return
          }
          broadcast({ type: 'blueprintAdded', blueprint: msg.blueprint }, { ignore: ws })
          sendJson(ws, { type: 'ok', requestId })
          return
        }

        if (msg.type === 'blueprint_modify') {
          if (!msg.change?.id) {
            sendJson(ws, { type: 'error', error: 'invalid_payload', requestId })
            return
          }
          const result = network.applyBlueprintModified(msg.change, { ignoreNetworkId })
          if (!result.ok) {
            sendJson(ws, {
              type: 'error',
              error: result.error,
              current: result.current,
              requestId,
            })
            return
          }
          broadcast({ type: 'blueprintModified', blueprint: world.blueprints.get(msg.change.id) }, { ignore: ws })
          sendJson(ws, { type: 'ok', requestId })
          return
        }

        if (msg.type === 'entity_add') {
          if (!msg.entity?.id) {
            sendJson(ws, { type: 'error', error: 'invalid_payload', requestId })
            return
          }
          const result = network.applyEntityAdded(msg.entity, { ignoreNetworkId })
          if (!result.ok) {
            sendJson(ws, { type: 'error', error: result.error, requestId })
            return
          }
          broadcast({ type: 'entityAdded', entity: world.entities.get(msg.entity.id)?.data || msg.entity }, { ignore: ws })
          sendJson(ws, { type: 'ok', requestId })
          return
        }

        if (msg.type === 'entity_modify') {
          if (!msg.change?.id) {
            sendJson(ws, { type: 'error', error: 'invalid_payload', requestId })
            return
          }
          const result = await network.applyEntityModified(msg.change, { ignoreNetworkId })
          if (!result.ok) {
            sendJson(ws, { type: 'error', error: result.error, requestId })
            return
          }
          broadcast({ type: 'entityModified', entity: world.entities.get(msg.change.id)?.data || msg.change }, { ignore: ws })
          sendJson(ws, { type: 'ok', requestId })
          return
        }

        if (msg.type === 'entity_remove') {
          if (!msg.id) {
            sendJson(ws, { type: 'error', error: 'invalid_payload', requestId })
            return
          }
          const result = network.applyEntityRemoved(msg.id, { ignoreNetworkId })
          if (!result.ok) {
            sendJson(ws, { type: 'error', error: result.error, requestId })
            return
          }
          broadcast({ type: 'entityRemoved', id: msg.id }, { ignore: ws })
          sendJson(ws, { type: 'ok', requestId })
          return
        }

        if (msg.type === 'settings_modify') {
          if (!msg.key) {
            sendJson(ws, { type: 'error', error: 'invalid_payload', requestId })
            return
          }
          const result = network.applySettingsModified({ key: msg.key, value: msg.value }, { ignoreNetworkId })
          if (!result.ok) {
            sendJson(ws, { type: 'error', error: result.error, requestId })
            return
          }
          broadcast({ type: 'settingsModified', data: { key: msg.key, value: msg.value } }, { ignore: ws })
          sendJson(ws, { type: 'ok', requestId })
          return
        }

        if (msg.type === 'spawn_modify') {
          if (!msg.op) {
            sendJson(ws, { type: 'error', error: 'invalid_payload', requestId })
            return
          }
          const result = await network.applySpawnModified({
            op: msg.op,
            networkId: msg.networkId || defaultNetworkId,
          })
          if (!result.ok) {
            sendJson(ws, { type: 'error', error: result.error, requestId })
            return
          }
          broadcast({ type: 'spawnModified', spawn: world.network.spawn }, { ignore: ws })
          sendJson(ws, { type: 'ok', requestId })
          return
        }

        sendJson(ws, { type: 'error', error: 'unknown_type', requestId })
      } catch (err) {
        console.error('[admin] handler error', err)
        sendJson(ws, { type: 'error', error: 'server_error', requestId })
      }
    })
  })

  fastify.get('/admin/snapshot', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const network = world.network
    return {
      assetsUrl: assets.url,
      settings: world.settings.serialize(),
      spawn: network.spawn,
      blueprints: world.blueprints.serialize(),
      entities: world.entities.serialize(),
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

  fastify.get('/admin/entities', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const type = req.query?.type
    const entities = world.entities.serialize()
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
