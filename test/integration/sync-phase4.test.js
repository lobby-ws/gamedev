import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
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

const BLUEPRINT_ID = 'phase4app__main'
const BLUEPRINT_SCOPE = 'phase4app'

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

function buildBlueprintPayload({ id, name, props = {} }) {
  return {
    id,
    scope: BLUEPRINT_SCOPE,
    version: 0,
    name,
    script: '',
    props,
  }
}

function buildEntityPayload({ id, blueprint, props = {} }) {
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
    props,
    state: {},
  }
}

async function withWorldEnv(world, fn) {
  const saved = {
    WORLD_ID: process.env.WORLD_ID,
    WORLD_URL: process.env.WORLD_URL,
  }
  process.env.WORLD_ID = world.worldId
  process.env.WORLD_URL = world.worldUrl
  try {
    return await fn()
  } finally {
    process.env.WORLD_ID = saved.WORLD_ID
    process.env.WORLD_URL = saved.WORLD_URL
  }
}

async function getHeadCursor(world) {
  const { data } = await fetchJson(`${world.worldUrl}/admin/changes`, {
    adminCode: world.adminCode,
  })
  return data?.headCursor ?? data?.cursor ?? null
}

async function seedLocalProjectFromWorld(world, rootDir) {
  await withWorldEnv(world, async () => {
    const seeder = new DirectAppServer({
      worldUrl: world.worldUrl,
      adminCode: world.adminCode,
      rootDir,
    })
    try {
      const snapshot = await seeder.connect()
      await seeder.exportWorldToDisk(snapshot)
    } finally {
      await stopAppServer(seeder)
    }
  })
}

async function setupWorldFixture(world) {
  const admin = new AdminWsClient({
    worldUrl: world.worldUrl,
    adminCode: world.adminCode,
  })
  await admin.connect()
  const entityId = `phase4-entity-${Date.now()}`
  try {
    await admin.request('blueprint_add', {
      blueprint: buildBlueprintPayload({
        id: BLUEPRINT_ID,
        name: 'Phase4 App',
        props: { text: 'v1' },
      }),
    })
    await admin.request('entity_add', {
      entity: buildEntityPayload({
        id: entityId,
        blueprint: BLUEPRINT_ID,
        props: { text: 'v1' },
      }),
    })
  } finally {
    admin.close()
  }
  return { entityId }
}

test('phase 4 startup no-op produces zero runtime writes when local and remote are unchanged', async t => {
  if (!(await canListenOnLoopback())) {
    t.skip('loopback sockets are unavailable in this environment')
    return
  }

  await withWorldServer(async world => {
    const { entityId } = await setupWorldFixture(world)
    const rootDir = await createTempDir('hyperfy-sync-phase4-noop-')
    await seedLocalProjectFromWorld(world, rootDir)

    const beforeCursor = await getHeadCursor(world)

    await withWorldEnv(world, async () => {
      const appServer = new DirectAppServer({
        worldUrl: world.worldUrl,
        adminCode: world.adminCode,
        rootDir,
      })
      try {
        await appServer.start()
      } finally {
        await stopAppServer(appServer)
      }
    })

    const afterCursor = await getHeadCursor(world)
    assert.equal(afterCursor, beforeCursor)

    const { data: snapshot } = await fetchJson(`${world.worldUrl}/admin/snapshot`, {
      adminCode: world.adminCode,
    })
    const entity = snapshot.entities?.find(item => item.id === entityId)
    assert.equal(entity?.props?.text, 'v1')
  })
})

test('phase 4 startup fast-forwards remote-only edits into local files without overwriting runtime', async t => {
  if (!(await canListenOnLoopback())) {
    t.skip('loopback sockets are unavailable in this environment')
    return
  }

  await withWorldServer(async world => {
    const { entityId } = await setupWorldFixture(world)
    const rootDir = await createTempDir('hyperfy-sync-phase4-remote-only-')
    await seedLocalProjectFromWorld(world, rootDir)

    const admin = new AdminWsClient({
      worldUrl: world.worldUrl,
      adminCode: world.adminCode,
    })
    await admin.connect()
    try {
      const { data: current } = await fetchJson(
        `${world.worldUrl}/admin/blueprints/${encodeURIComponent(BLUEPRINT_ID)}`,
        { adminCode: world.adminCode }
      )
      const nextVersion = (current?.blueprint?.version || 0) + 1
      await admin.request('blueprint_modify', {
        change: {
          id: BLUEPRINT_ID,
          version: nextVersion,
          desc: 'remote-only desc',
        },
      })
      await admin.request('entity_modify', {
        change: {
          id: entityId,
          props: { text: 'remote-only' },
        },
      })
    } finally {
      admin.close()
    }

    const beforeCursor = await getHeadCursor(world)
    const blueprintPath = path.join(rootDir, 'apps', 'phase4app', 'main.json')
    const worldPath = path.join(rootDir, 'world.json')

    await withWorldEnv(world, async () => {
      const appServer = new DirectAppServer({
        worldUrl: world.worldUrl,
        adminCode: world.adminCode,
        rootDir,
      })
      try {
        await appServer.start()
        await waitFor(() => {
          const blueprintCfg = readJsonFile(blueprintPath)
          if (blueprintCfg?.desc !== 'remote-only desc') return false
          const manifest = readJsonFile(worldPath)
          const entity = manifest?.entities?.find(item => item.id === entityId)
          return entity?.props?.text === 'remote-only' ? true : false
        }, { timeoutMs: 10000 })
      } finally {
        await stopAppServer(appServer)
      }
    })

    const afterCursor = await getHeadCursor(world)
    assert.equal(afterCursor, beforeCursor)

    const { data: snapshot } = await fetchJson(`${world.worldUrl}/admin/snapshot`, {
      adminCode: world.adminCode,
    })
    const blueprint = snapshot.blueprints?.find(item => item.id === BLUEPRINT_ID)
    const entity = snapshot.entities?.find(item => item.id === entityId)
    assert.equal(blueprint?.desc, 'remote-only desc')
    assert.equal(entity?.props?.text, 'remote-only')
  })
})

test('phase 4 startup pushes local-only edits to runtime', async t => {
  if (!(await canListenOnLoopback())) {
    t.skip('loopback sockets are unavailable in this environment')
    return
  }

  await withWorldServer(async world => {
    const { entityId } = await setupWorldFixture(world)
    const rootDir = await createTempDir('hyperfy-sync-phase4-local-only-')
    await seedLocalProjectFromWorld(world, rootDir)

    const blueprintPath = path.join(rootDir, 'apps', 'phase4app', 'main.json')
    const worldPath = path.join(rootDir, 'world.json')
    const blueprintCfg = readJsonFile(blueprintPath)
    blueprintCfg.desc = 'local-only desc'
    fs.writeFileSync(blueprintPath, JSON.stringify(blueprintCfg, null, 2) + '\n', 'utf8')

    const manifest = readJsonFile(worldPath)
    const target = manifest.entities.find(item => item.id === entityId)
    target.props = { text: 'local-only' }
    fs.writeFileSync(worldPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

    const beforeCursor = await getHeadCursor(world)

    await withWorldEnv(world, async () => {
      const appServer = new DirectAppServer({
        worldUrl: world.worldUrl,
        adminCode: world.adminCode,
        rootDir,
      })
      try {
        await appServer.start()
        await waitFor(async () => {
          const { data: snapshot } = await fetchJson(`${world.worldUrl}/admin/snapshot`, {
            adminCode: world.adminCode,
          })
          const blueprint = snapshot.blueprints?.find(item => item.id === BLUEPRINT_ID)
          const entity = snapshot.entities?.find(item => item.id === entityId)
          return blueprint?.desc === 'local-only desc' && entity?.props?.text === 'local-only'
        }, { timeoutMs: 10000 })
      } finally {
        await stopAppServer(appServer)
      }
    })

    const afterCursor = await getHeadCursor(world)
    assert.ok(typeof afterCursor === 'number')
    assert.ok(afterCursor > beforeCursor)
  })
})
