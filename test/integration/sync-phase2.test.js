import assert from 'node:assert/strict'
import net from 'node:net'
import path from 'path'
import { test } from 'node:test'

import { DirectAppServer } from '../../app-server/direct.js'
import {
  AdminWsClient,
  createTempDir,
  fetchJson,
  readJsonFile,
  startWorldServer,
  stopAppServer,
  waitFor,
} from './helpers.js'

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

function buildEntityPayload({ id, blueprint }) {
  return {
    id,
    type: 'app',
    blueprint,
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    mover: null,
    uploader: null,
    pinned: false,
    props: {},
    state: {},
  }
}

function assertOperationEnvelope(operation) {
  assert.equal(typeof operation.cursor, 'number')
  assert.ok(operation.cursor > 0)
  assert.equal(typeof operation.opId, 'string')
  assert.ok(operation.opId.length > 0)
  assert.equal(typeof operation.ts, 'string')
  assert.ok(Number.isFinite(Date.parse(operation.ts)))
  assert.equal(typeof operation.actor, 'string')
  assert.ok(operation.actor.length > 0)
  assert.equal(typeof operation.source, 'string')
  assert.ok(operation.source.length > 0)
  assert.equal(typeof operation.kind, 'string')
  assert.ok(operation.kind.length > 0)
  assert.equal(typeof operation.objectUid, 'string')
  assert.ok(operation.objectUid.length > 0)
}

test('phase 2 changefeed supports ordered cursor replay', async t => {
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

    const blueprintId = 'phase2app__main'
    const entityId = `phase2-entity-${Date.now()}`
    await admin.request('blueprint_add', {
      blueprint: {
        id: blueprintId,
        version: 0,
        name: 'Phase2 App',
        model: null,
        props: {},
      },
    })
    await admin.request('entity_add', {
      entity: buildEntityPayload({ id: entityId, blueprint: blueprintId }),
    })
    await admin.request('entity_modify', {
      change: {
        id: entityId,
        pinned: true,
      },
    })

    const page1 = await fetchJson(`${world.worldUrl}/admin/changes?cursor=0&limit=2`, {
      adminCode: world.adminCode,
    })
    assert.equal(page1.res.status, 200)
    assert.equal(page1.data?.operations?.length, 2)
    const [opA, opB] = page1.data.operations
    assertOperationEnvelope(opA)
    assertOperationEnvelope(opB)
    assert.equal(opA.kind, 'blueprint.add')
    assert.equal(opB.kind, 'entity.add')
    assert.ok(opB.cursor > opA.cursor)
    assert.equal(page1.data.cursor, opB.cursor)
    assert.equal(typeof page1.data.headCursor, 'number')
    assert.ok(page1.data.headCursor >= page1.data.cursor)

    const page2 = await fetchJson(`${world.worldUrl}/admin/changes?cursor=${page1.data.cursor}&limit=10`, {
      adminCode: world.adminCode,
    })
    assert.equal(page2.res.status, 200)
    assert.ok(Array.isArray(page2.data?.operations))
    assert.ok(page2.data.operations.length >= 1)
    const opC = page2.data.operations[0]
    assertOperationEnvelope(opC)
    assert.equal(opC.kind, 'entity.update')
    assert.ok(opC.cursor > page1.data.cursor)

    const replay = await fetchJson(`${world.worldUrl}/admin/changes?cursor=0&limit=1`, {
      adminCode: world.adminCode,
    })
    assert.equal(replay.res.status, 200)
    assert.equal(replay.data?.operations?.length, 1)
    assert.equal(replay.data.operations[0].opId, opA.opId)

    const headOnly = await fetchJson(`${world.worldUrl}/admin/changes`, {
      adminCode: world.adminCode,
    })
    assert.equal(headOnly.res.status, 200)
    assert.equal(headOnly.data?.operations?.length, 0)
    assert.ok(headOnly.data.cursor >= page2.data.cursor)

    admin.close()
  })
})

test('phase 2 app-server cursor advances across reconnect', async t => {
  if (!(await canListenOnLoopback())) {
    t.skip('loopback sockets are unavailable in this environment')
    return
  }

  await withWorldServer(async world => {
    const rootDir = await createTempDir('hyperfy-sync-phase2-')
    const syncStatePath = path.join(rootDir, '.lobby', 'sync-state.json')
    const admin = new AdminWsClient({
      worldUrl: world.worldUrl,
      adminCode: world.adminCode,
    })
    await admin.connect()

    const blueprintId = 'phase2cursor__main'
    const entityId = `phase2-cursor-entity-${Date.now()}`
    await admin.request('blueprint_add', {
      blueprint: {
        id: blueprintId,
        version: 0,
        name: 'Phase2 Cursor',
        model: null,
        props: {},
      },
    })
    await admin.request('entity_add', {
      entity: buildEntityPayload({ id: entityId, blueprint: blueprintId }),
    })

    const savedEnv = {
      WORLD_ID: process.env.WORLD_ID,
      WORLD_URL: process.env.WORLD_URL,
    }
    process.env.WORLD_ID = world.worldId
    process.env.WORLD_URL = world.worldUrl

    let firstCursor = null
    let appServer = null
    try {
      appServer = new DirectAppServer({
        worldUrl: world.worldUrl,
        adminCode: world.adminCode,
        rootDir,
      })
      await appServer.connect()
      await waitFor(() => {
        const state = readJsonFile(syncStatePath)
        return typeof state?.cursor === 'number' ? state : false
      })
      const firstState = readJsonFile(syncStatePath)
      firstCursor = firstState.cursor
      assert.ok(firstCursor > 0)
    } finally {
      await stopAppServer(appServer)
    }

    await admin.request('entity_modify', {
      change: {
        id: entityId,
        pinned: true,
      },
    })

    let reconnectServer = null
    try {
      reconnectServer = new DirectAppServer({
        worldUrl: world.worldUrl,
        adminCode: world.adminCode,
        rootDir,
      })
      await reconnectServer.connect()
      await waitFor(() => {
        const state = readJsonFile(syncStatePath)
        if (typeof state?.cursor !== 'number') return false
        return state.cursor > firstCursor ? state : false
      })
      const secondState = readJsonFile(syncStatePath)
      assert.ok(secondState.cursor > firstCursor)
    } finally {
      process.env.WORLD_ID = savedEnv.WORLD_ID
      process.env.WORLD_URL = savedEnv.WORLD_URL
      await stopAppServer(reconnectServer)
      admin.close()
    }
  })
})
