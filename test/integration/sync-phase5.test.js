import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { test } from 'node:test'

import { runSyncCommand } from '../../app-server/commands.js'
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

const BLUEPRINT_ID = 'phase5app__main'
const BLUEPRINT_SCOPE = 'phase5app'

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

function buildBlueprintPayload({ id, name, desc, props = {} }) {
  return {
    id,
    scope: BLUEPRINT_SCOPE,
    version: 0,
    name,
    desc,
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
  const entityId = `phase5-entity-${Date.now()}`
  try {
    await admin.request('blueprint_add', {
      blueprint: buildBlueprintPayload({
        id: BLUEPRINT_ID,
        name: 'Phase5 App',
        desc: 'base-desc',
        props: { text: 'base' },
      }),
    })
    await admin.request('entity_add', {
      entity: buildEntityPayload({
        id: entityId,
        blueprint: BLUEPRINT_ID,
        props: { text: 'base' },
      }),
    })
  } finally {
    admin.close()
  }
  return { entityId }
}

function listConflictArtifacts(conflictsDir) {
  if (!fs.existsSync(conflictsDir)) return []
  const files = fs
    .readdirSync(conflictsDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => path.join(conflictsDir, entry.name))
  return files
    .map(filePath => ({ filePath, data: readJsonFile(filePath) }))
    .filter(item => item.data && typeof item.data === 'object')
}

test('phase 5 startup auto-merges concurrent non-overlapping blueprint fields', async t => {
  if (!(await canListenOnLoopback())) {
    t.skip('loopback sockets are unavailable in this environment')
    return
  }

  await withWorldServer(async world => {
    await setupWorldFixture(world)
    const rootDir = await createTempDir('hyperfy-sync-phase5-merge-')
    await seedLocalProjectFromWorld(world, rootDir)

    const blueprintPath = path.join(rootDir, 'apps', 'phase5app', 'main.json')
    const localBlueprint = readJsonFile(blueprintPath)
    localBlueprint.desc = 'local-desc'
    fs.writeFileSync(blueprintPath, JSON.stringify(localBlueprint, null, 2) + '\n', 'utf8')

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
          name: 'remote-name',
        },
      })
    } finally {
      admin.close()
    }

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
          if (!blueprint) return false
          return blueprint.name === 'remote-name' && blueprint.desc === 'local-desc'
        })
      } finally {
        await stopAppServer(appServer)
      }
    })

    const updatedLocal = readJsonFile(blueprintPath)
    assert.equal(updatedLocal.name, 'remote-name')
    assert.equal(updatedLocal.desc, 'local-desc')

    const artifacts = listConflictArtifacts(path.join(rootDir, '.lobby', 'conflicts')).filter(
      item => item.data.status !== 'resolved'
    )
    assert.equal(artifacts.length, 0)
  })
})

test('phase 5 writes conflict artifacts and sync resolve can finalize them', async t => {
  if (!(await canListenOnLoopback())) {
    t.skip('loopback sockets are unavailable in this environment')
    return
  }

  await withWorldServer(async world => {
    await setupWorldFixture(world)
    const rootDir = await createTempDir('hyperfy-sync-phase5-conflict-')
    await seedLocalProjectFromWorld(world, rootDir)

    const blueprintPath = path.join(rootDir, 'apps', 'phase5app', 'main.json')
    const localBlueprint = readJsonFile(blueprintPath)
    localBlueprint.desc = 'local-conflict'
    fs.writeFileSync(blueprintPath, JSON.stringify(localBlueprint, null, 2) + '\n', 'utf8')

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
          desc: 'remote-conflict',
        },
      })
    } finally {
      admin.close()
    }

    await withWorldEnv(world, async () => {
      const appServer = new DirectAppServer({
        worldUrl: world.worldUrl,
        adminCode: world.adminCode,
        rootDir,
      })
      try {
        await assert.rejects(
          () => appServer.start(),
          err =>
            typeof err?.message === 'string' &&
            err.message.includes('Sync conflict detected') &&
            err.message.includes('gamedev sync conflicts')
        )
      } finally {
        await stopAppServer(appServer)
      }
    })

    const artifacts = listConflictArtifacts(path.join(rootDir, '.lobby', 'conflicts')).filter(
      item => item.data.status === 'open'
    )
    assert.ok(artifacts.length >= 1)
    const blueprintConflict = artifacts.find(item => item.data.kind === 'blueprint' && item.data.objectId === BLUEPRINT_ID)
    assert.ok(blueprintConflict)
    assert.ok(Array.isArray(blueprintConflict.data.unresolvedFields))
    assert.ok(blueprintConflict.data.unresolvedFields.some(item => item.path === 'desc'))
    assert.equal(blueprintConflict.data.local?.desc, 'local-conflict')
    assert.equal(blueprintConflict.data.remote?.desc, 'remote-conflict')

    await withWorldEnv(world, async () => {
      const exitCode = await runSyncCommand({
        command: 'resolve',
        args: [blueprintConflict.data.id, '--use', 'remote'],
        rootDir,
      })
      assert.equal(exitCode, 0)
    })

    const resolvedArtifact = readJsonFile(blueprintConflict.filePath)
    assert.equal(resolvedArtifact.status, 'resolved')
    assert.equal(resolvedArtifact.resolvedWith, 'remote')

    const resolvedBlueprint = readJsonFile(blueprintPath)
    assert.equal(resolvedBlueprint.desc, 'remote-conflict')
  })
})
