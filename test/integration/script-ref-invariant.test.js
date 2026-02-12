import assert from 'node:assert/strict'
import net from 'node:net'
import { test } from 'node:test'

import { AdminWsClient, fetchJson, startWorldServer } from './helpers.js'

async function withWorldServer(fn) {
  const world = await startWorldServer()
  try {
    return await fn(world)
  } finally {
    await world.stop()
  }
}

async function canListenOnLoopback() {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => {
      server.close(() => resolve(true))
    })
  })
}

async function acquireGlobalLock(world, owner = 'script-ref-test') {
  const { res, data } = await fetchJson(`${world.worldUrl}/admin/deploy-lock`, {
    adminCode: world.adminCode,
    method: 'POST',
    body: {
      owner,
      scope: 'global',
    },
  })
  assert.equal(res.status, 200)
  assert.ok(typeof data?.token === 'string' && data.token.length > 0)
  return data.token
}

async function releaseGlobalLock(world, token) {
  if (!token) return
  await fetchJson(`${world.worldUrl}/admin/deploy-lock`, {
    adminCode: world.adminCode,
    method: 'DELETE',
    body: {
      token,
      scope: 'global',
    },
  })
}

async function fetchBlueprint(world, id) {
  const { res, data } = await fetchJson(`${world.worldUrl}/admin/blueprints/${encodeURIComponent(id)}`, {
    adminCode: world.adminCode,
  })
  assert.equal(res.status, 200)
  return data?.blueprint || null
}

test('scriptRef variants normalize stale script module fields on add and modify', async t => {
  if (!(await canListenOnLoopback())) {
    t.skip('loopback sockets are unavailable in this environment')
    return
  }

  await withWorldServer(async world => {
    const admin = new AdminWsClient({
      worldUrl: world.worldUrl,
      adminCode: world.adminCode,
    })
    await admin.connect()

    const lockToken = await acquireGlobalLock(world)
    try {
      await admin.request('blueprint_add', {
        blueprint: {
          id: 'ScriptRoot',
          version: 0,
          scope: 'global',
          name: 'ScriptRoot',
          script: 'asset://root.js',
          scriptEntry: 'index.js',
          scriptFiles: {
            'index.js': 'asset://root.js',
          },
          scriptFormat: 'module',
          props: {},
        },
        lockToken,
      })

      await admin.request('blueprint_add', {
        blueprint: {
          id: 'ScriptRoot_2',
          version: 0,
          scope: 'global',
          name: 'ScriptRoot_2',
          script: 'asset://stale.js',
          scriptRef: 'ScriptRoot',
          scriptEntry: 'index.js',
          scriptFiles: {
            'index.js': 'asset://stale.js',
          },
          scriptFormat: 'module',
          props: {},
        },
        lockToken,
      })

      const added = await fetchBlueprint(world, 'ScriptRoot_2')
      assert.ok(added)
      assert.equal(added.scriptRef, 'ScriptRoot')
      assert.equal(added.script, 'asset://root.js')
      assert.equal(added.scriptEntry, null)
      assert.equal(added.scriptFiles, null)
      assert.equal(added.scriptFormat, null)

      await admin.request('blueprint_modify', {
        change: {
          id: 'ScriptRoot_2',
          version: (added.version || 0) + 1,
          scope: 'global',
          script: 'asset://stale-2.js',
          scriptRef: 'ScriptRoot',
          scriptEntry: 'index.js',
          scriptFiles: {
            'index.js': 'asset://stale-2.js',
          },
          scriptFormat: 'module',
        },
        lockToken,
      })

      const modified = await fetchBlueprint(world, 'ScriptRoot_2')
      assert.ok(modified)
      assert.equal(modified.scriptRef, 'ScriptRoot')
      assert.equal(modified.script, 'asset://root.js')
      assert.equal(modified.scriptEntry, null)
      assert.equal(modified.scriptFiles, null)
      assert.equal(modified.scriptFormat, null)
    } finally {
      admin.close()
      await releaseGlobalLock(world, lockToken)
    }
  })
})
