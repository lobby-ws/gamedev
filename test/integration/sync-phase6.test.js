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
} from './helpers.js'

const BLUEPRINT_ID = 'phase6app__main'
const BLUEPRINT_SCOPE = 'phase6app'

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
    ADMIN_CODE: process.env.ADMIN_CODE,
  }
  process.env.WORLD_ID = world.worldId
  process.env.WORLD_URL = world.worldUrl
  process.env.ADMIN_CODE = world.adminCode
  try {
    return await fn()
  } finally {
    process.env.WORLD_ID = saved.WORLD_ID
    process.env.WORLD_URL = saved.WORLD_URL
    process.env.ADMIN_CODE = saved.ADMIN_CODE
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
  const entityId = `phase6-entity-${Date.now()}`
  try {
    await admin.request('blueprint_add', {
      blueprint: buildBlueprintPayload({
        id: BLUEPRINT_ID,
        name: 'Phase6 App',
        props: { text: 'phase6' },
      }),
    })
    await admin.request('entity_add', {
      entity: buildEntityPayload({
        id: entityId,
        blueprint: BLUEPRINT_ID,
        props: { text: 'phase6' },
      }),
    })
  } finally {
    admin.close()
  }

  const { data: snapshot } = await fetchJson(`${world.worldUrl}/admin/snapshot`, {
    adminCode: world.adminCode,
  })
  const blueprint = snapshot.blueprints?.find(item => item.id === BLUEPRINT_ID) || null
  const entity = snapshot.entities?.find(item => item.id === entityId) || null
  return {
    entityId,
    blueprintUid: blueprint?.uid || null,
    entityUid: entity?.uid || null,
  }
}

test('phase 6 startup resolves renamed app folders through metadata index without runtime recreation', async t => {
  if (!(await canListenOnLoopback())) {
    t.skip('loopback sockets are unavailable in this environment')
    return
  }

  await withWorldServer(async world => {
    const fixture = await setupWorldFixture(world)
    const rootDir = await createTempDir('hyperfy-sync-phase6-startup-')
    await seedLocalProjectFromWorld(world, rootDir)

    const oldAppDir = path.join(rootDir, 'apps', 'phase6app')
    const newAppDir = path.join(rootDir, 'apps', 'phase6renamed')
    const oldBlueprintPath = path.join(oldAppDir, 'main.json')
    const cfg = readJsonFile(oldBlueprintPath)
    delete cfg.id
    delete cfg.uid
    fs.writeFileSync(oldBlueprintPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
    fs.renameSync(oldAppDir, newAppDir)

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
    const blueprint = snapshot.blueprints?.find(item => item.id === BLUEPRINT_ID)
    const entity = snapshot.entities?.find(item => item.id === fixture.entityId)
    assert.ok(blueprint)
    assert.ok(entity)
    if (fixture.blueprintUid) {
      assert.equal(blueprint.uid, fixture.blueprintUid)
    }
    if (fixture.entityUid) {
      assert.equal(entity.uid, fixture.entityUid)
    }
    assert.equal(entity.blueprint, BLUEPRINT_ID)
    assert.ok(!snapshot.blueprints?.some(item => item.id === 'phase6renamed__main'))

    const metadataPath = path.join(rootDir, '.lobby', 'blueprint-index.json')
    const metadata = readJsonFile(metadataPath)
    assert.ok(metadata?.blueprints?.byId?.[BLUEPRINT_ID])
    assert.equal(metadata.blueprints.byId[BLUEPRINT_ID].path, 'apps/phase6renamed/main.json')
  })
})

test('phase 6 live app folder rename does not trigger remote blueprint removal/recreation', async t => {
  if (!(await canListenOnLoopback())) {
    t.skip('loopback sockets are unavailable in this environment')
    return
  }

  await withWorldServer(async world => {
    const fixture = await setupWorldFixture(world)
    const rootDir = await createTempDir('hyperfy-sync-phase6-live-')
    await seedLocalProjectFromWorld(world, rootDir)

    await withWorldEnv(world, async () => {
      const appServer = new DirectAppServer({
        worldUrl: world.worldUrl,
        adminCode: world.adminCode,
        rootDir,
      })
      try {
        await appServer.start()
        const beforeCursor = await getHeadCursor(world)

        const oldAppDir = path.join(rootDir, 'apps', 'phase6app')
        const newAppDir = path.join(rootDir, 'apps', 'phase6renamed-live')
        fs.renameSync(oldAppDir, newAppDir)

        await new Promise(resolve => setTimeout(resolve, 1800))

        const afterCursor = await getHeadCursor(world)
        assert.equal(afterCursor, beforeCursor)

        const { data: snapshot } = await fetchJson(`${world.worldUrl}/admin/snapshot`, {
          adminCode: world.adminCode,
        })
        const blueprint = snapshot.blueprints?.find(item => item.id === BLUEPRINT_ID)
        const entity = snapshot.entities?.find(item => item.id === fixture.entityId)
        assert.ok(blueprint)
        assert.ok(entity)
        if (fixture.blueprintUid) {
          assert.equal(blueprint.uid, fixture.blueprintUid)
        }
        if (fixture.entityUid) {
          assert.equal(entity.uid, fixture.entityUid)
        }
      } finally {
        await stopAppServer(appServer)
      }
    })
  })
})
