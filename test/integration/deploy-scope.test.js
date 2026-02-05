import assert from 'node:assert/strict'
import net from 'node:net'
import { test } from 'node:test'

import { DirectAppServer } from '../../app-server/direct.js'
import { AdminWsClient, fetchJson, startWorldServer, createTempDir } from './helpers.js'

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

test('deploy snapshots require global scope for multi-scope id batches', async t => {
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
    await admin.request('blueprint_add', {
      blueprint: {
        id: 'ScopeA',
        version: 0,
        name: 'ScopeA',
        props: {},
      },
    })
    await admin.request('blueprint_add', {
      blueprint: {
        id: 'ScopeB',
        version: 0,
        name: 'ScopeB',
        props: {},
      },
    })
    admin.close()

    const scopedLock = await fetchJson(`${world.worldUrl}/admin/deploy-lock`, {
      adminCode: world.adminCode,
      method: 'POST',
      body: { owner: 'scope-lock', scope: 'ScopeA' },
    })
    assert.equal(scopedLock.res.status, 200)
    const scopedSnapshot = await fetchJson(`${world.worldUrl}/admin/deploy-snapshots`, {
      adminCode: world.adminCode,
      method: 'POST',
      body: {
        ids: ['ScopeA', 'ScopeB'],
        lockToken: scopedLock.data.token,
        scope: 'ScopeA',
      },
    })
    assert.equal(scopedSnapshot.res.status, 400)
    assert.equal(scopedSnapshot.data?.error, 'multi_scope_not_supported')
    await fetchJson(`${world.worldUrl}/admin/deploy-lock`, {
      adminCode: world.adminCode,
      method: 'DELETE',
      body: { token: scopedLock.data.token, scope: 'ScopeA' },
    })

    const globalLock = await fetchJson(`${world.worldUrl}/admin/deploy-lock`, {
      adminCode: world.adminCode,
      method: 'POST',
      body: { owner: 'global-lock' },
    })
    assert.equal(globalLock.res.status, 200)
    const globalSnapshot = await fetchJson(`${world.worldUrl}/admin/deploy-snapshots`, {
      adminCode: world.adminCode,
      method: 'POST',
      body: {
        ids: ['ScopeA', 'ScopeB'],
        lockToken: globalLock.data.token,
      },
    })
    assert.equal(globalSnapshot.res.status, 200)
    assert.equal(globalSnapshot.data?.ok, true)
    assert.equal(globalSnapshot.data?.count, 2)
    await fetchJson(`${world.worldUrl}/admin/deploy-lock`, {
      adminCode: world.adminCode,
      method: 'DELETE',
      body: { token: globalLock.data.token },
    })
  })
})

test('direct app-server falls back to global deploy scope for mixed blueprint scopes', async () => {
  const rootDir = await createTempDir('hyperfy-deploy-scope-')
  const server = new DirectAppServer({ worldUrl: 'http://example.com', rootDir })

  const infos = [
    {
      id: 'Mixed',
      appName: 'Mixed',
      fileBase: 'Mixed',
      configPath: '/tmp/Mixed.json',
      scriptPath: '/tmp/index.js',
    },
    {
      id: 'Mixed_2',
      appName: 'Mixed',
      fileBase: 'Mixed_2',
      configPath: '/tmp/Mixed_2.json',
      scriptPath: '/tmp/index.js',
    },
  ]
  const index = new Map(infos.map(info => [info.id, info]))

  const lockScopes = []
  const snapshotCalls = []
  server._logTarget = () => {}
  server._buildDeployPlan = async (_appName, list) => ({
    scriptInfo: null,
    changes: list.map(info => ({
      info,
      desired: {},
      current: {},
      type: 'update',
      scriptChanged: true,
      otherChanged: false,
    })),
  })
  server._withDeployLock = async (fn, options = {}) => {
    lockScopes.push(options.scope)
    return fn({ token: 'token', scope: options.scope })
  }
  server._createDeploySnapshot = async (ids, options = {}) => {
    snapshotCalls.push({ ids: [...ids], scope: options.scope })
    return { ok: true }
  }
  server._uploadScriptForApp = async () => ({
    mode: 'module',
    scriptUrl: 'asset://script.js',
    scriptEntry: 'index.js',
    scriptFiles: { 'index.js': 'asset://script.js' },
    scriptFormat: 'module',
  })
  server._resolveScriptRootId = () => 'Mixed'
  server._deployBlueprint = async () => {}

  await server._deployBlueprintsForAppInternal('Mixed', infos, index)

  assert.equal(lockScopes.length, 1)
  assert.equal(lockScopes[0], null)
  assert.equal(snapshotCalls.length, 1)
  assert.deepEqual(snapshotCalls[0].ids.sort(), ['Mixed', 'Mixed_2'])
  assert.equal(snapshotCalls[0].scope, null)
})
