import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'

import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import ws from '@fastify/websocket'

import { admin } from '../../src/server/admin.js'

function createMockWorld() {
  const network = new EventEmitter()
  network.db = null
  network.spawn = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] }
  return {
    settings: {
      title: 'Test',
      desc: '',
      image: null,
      serialize() {
        return {}
      },
    },
    resolveURL() {
      return ''
    },
    blueprints: {
      serialize() {
        return []
      },
      get() {
        return null
      },
    },
    entities: {
      serialize() {
        return []
      },
      players: new Map(),
    },
    network,
  }
}

test('admin upload preserves requested nested filename path', async () => {
  const previousAdminCode = process.env.ADMIN_CODE
  process.env.ADMIN_CODE = 'admin'

  const uploaded = []
  const mockAssets = {
    url: 'http://127.0.0.1/assets',
    async exists() {
      return false
    },
    async upload(file) {
      uploaded.push(file.name)
    },
  }

  const fastify = Fastify({ logger: false })
  await fastify.register(ws)
  await fastify.register(multipart)
  await fastify.register(admin, {
    world: createMockWorld(),
    assets: mockAssets,
    adminHtmlPath: null,
  })

  try {
    const source = Buffer.from('export default 1;\n', 'utf8')
    const hash = crypto.createHash('sha256').update(source).digest('hex')
    const targetFilename = `mods/${hash}.js`

    const boundary = '----mods-upload-boundary'
    const multipartBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`, 'utf8'),
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="${hash}.js"\r\n`, 'utf8'),
      Buffer.from('Content-Type: text/javascript\r\n\r\n', 'utf8'),
      source,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ])

    const res = await fastify.inject({
      method: 'POST',
      url: `/admin/upload?filename=${encodeURIComponent(targetFilename)}`,
      headers: {
        'x-admin-code': 'admin',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartBody,
    })
    assert.equal(res.statusCode, 200)

    const payload = res.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.filename, targetFilename)
    assert.deepEqual(uploaded, [targetFilename])
  } finally {
    await fastify.close().catch(() => {})
    if (previousAdminCode === undefined) {
      delete process.env.ADMIN_CODE
    } else {
      process.env.ADMIN_CODE = previousAdminCode
    }
  }
})
