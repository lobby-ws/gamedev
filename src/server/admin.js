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
  fastify.get('/admin', { websocket: true }, (ws, req) => {
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

  fastify.get('/admin/upload-check', async (req, reply) => {
    const code = getAdminCodeFromRequest(req)
    if (!isAdminCodeValid(code)) {
      return reply.code(403).send({ error: 'admin_required' })
    }
    const exists = await assets.exists(req.query.filename)
    return { exists }
  })

  fastify.post('/admin/upload', async (req, reply) => {
    const code = getAdminCodeFromRequest(req)
    if (!isAdminCodeValid(code)) {
      return reply.code(403).send({ error: 'admin_required' })
    }
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
