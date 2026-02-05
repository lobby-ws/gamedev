import assert from 'node:assert/strict'
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

function assertSyncMetadata(record, { expectedScope = null, expectedSource = null } = {}) {
  assert.equal(typeof record.uid, 'string')
  assert.ok(record.uid.length > 0)
  assert.equal(typeof record.scope, 'string')
  assert.ok(record.scope.length > 0)
  if (expectedScope) {
    assert.equal(record.scope, expectedScope)
  }
  assert.ok(['local', 'runtime', 'shared'].includes(record.managedBy))
  assert.equal(typeof record.updatedAt, 'string')
  assert.ok(Number.isFinite(Date.parse(record.updatedAt)))
  assert.equal(typeof record.updatedBy, 'string')
  assert.ok(record.updatedBy.length > 0)
  assert.equal(typeof record.updateSource, 'string')
  if (expectedSource) {
    assert.equal(record.updateSource, expectedSource)
  }
  assert.ok(Object.prototype.hasOwnProperty.call(record, 'lastOpId'))
}

async function withWorldServer(fn) {
  const world = await startWorldServer()
  try {
    return await fn(world)
  } finally {
    await world.stop()
  }
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

test('phase 1 runtime metadata is present and stable across blueprint/entity updates', async () => {
  await withWorldServer(async world => {
    const { res: initialRes, data: initialSnapshot } = await fetchJson(`${world.worldUrl}/admin/snapshot`, {
      adminCode: world.adminCode,
    })
    assert.equal(initialRes.status, 200)

    for (const blueprint of initialSnapshot.blueprints || []) {
      assertSyncMetadata(blueprint)
    }
    for (const entity of initialSnapshot.entities || []) {
      assertSyncMetadata(entity)
    }

    const admin = new AdminWsClient({
      worldUrl: world.worldUrl,
      adminCode: world.adminCode,
    })
    await admin.connect()

    try {
      const blueprintId = 'phase1app__main'
      await admin.request('blueprint_add', {
        blueprint: {
          id: blueprintId,
          version: 0,
          name: 'Phase1 App',
          model: 'asset://Model.glb',
          props: {},
        },
      })

      const entityId = `phase1-entity-${Date.now()}`
      await admin.request('entity_add', {
        entity: buildEntityPayload({ id: entityId, blueprint: blueprintId }),
      })

      const { data: afterAdd } = await fetchJson(`${world.worldUrl}/admin/snapshot`, {
        adminCode: world.adminCode,
      })
      const addedBlueprint = afterAdd.blueprints.find(item => item.id === blueprintId)
      const addedEntity = afterAdd.entities.find(item => item.id === entityId)
      assert.ok(addedBlueprint)
      assert.ok(addedEntity)
      assertSyncMetadata(addedBlueprint, { expectedScope: 'phase1app', expectedSource: 'admin' })
      assertSyncMetadata(addedEntity, { expectedScope: 'phase1app', expectedSource: 'admin' })

      const blueprintUid = addedBlueprint.uid
      const blueprintUpdatedAt = Date.parse(addedBlueprint.updatedAt)
      const entityUid = addedEntity.uid
      const entityUpdatedAt = Date.parse(addedEntity.updatedAt)

      await admin.request('blueprint_modify', {
        change: {
          id: blueprintId,
          version: (addedBlueprint.version || 0) + 1,
          name: 'Phase1 App Updated',
        },
      })

      await admin.request('entity_modify', {
        change: {
          id: entityId,
          pinned: true,
        },
      })

      const { data: afterModify } = await fetchJson(`${world.worldUrl}/admin/snapshot`, {
        adminCode: world.adminCode,
      })
      const modifiedBlueprint = afterModify.blueprints.find(item => item.id === blueprintId)
      const modifiedEntity = afterModify.entities.find(item => item.id === entityId)
      assert.ok(modifiedBlueprint)
      assert.ok(modifiedEntity)
      assert.equal(modifiedBlueprint.uid, blueprintUid)
      assert.equal(modifiedEntity.uid, entityUid)
      assert.ok(Date.parse(modifiedBlueprint.updatedAt) >= blueprintUpdatedAt)
      assert.ok(Date.parse(modifiedEntity.updatedAt) >= entityUpdatedAt)
      assertSyncMetadata(modifiedBlueprint, { expectedScope: 'phase1app', expectedSource: 'admin' })
      assertSyncMetadata(modifiedEntity, { expectedScope: 'phase1app', expectedSource: 'admin' })
    } finally {
      admin.close()
    }
  })
})

test('phase 1 app-server writes .lobby/sync-state.json baselines', async () => {
  await withWorldServer(async world => {
    const rootDir = await createTempDir('hyperfy-sync-state-')
    const syncStatePath = path.join(rootDir, '.lobby', 'sync-state.json')

    const savedEnv = {
      WORLD_ID: process.env.WORLD_ID,
      WORLD_URL: process.env.WORLD_URL,
    }
    process.env.WORLD_ID = world.worldId
    process.env.WORLD_URL = world.worldUrl

    const appServer = new DirectAppServer({
      worldUrl: world.worldUrl,
      adminCode: world.adminCode,
      rootDir,
    })

    try {
      await appServer.start()

      await waitFor(() => {
        const state = readJsonFile(syncStatePath)
        return state || false
      })

      const state = readJsonFile(syncStatePath)
      assert.ok(state)
      assert.equal(state.formatVersion, 1)
      assert.equal(state.worldId, world.worldId)
      assert.equal(state.cursor, null)
      assert.ok(Array.isArray(state.lastConflictSnapshots))
      assert.ok(state.objects && typeof state.objects === 'object')
      assert.ok(state.objects.blueprints && typeof state.objects.blueprints === 'object')
      assert.ok(state.objects.entities && typeof state.objects.entities === 'object')

      const blueprintEntries = Object.values(state.objects.blueprints)
      const entityEntries = Object.values(state.objects.entities)
      assert.equal(blueprintEntries.length, appServer.snapshot.blueprints.size)
      assert.equal(entityEntries.length, appServer.snapshot.entities.size)
      assert.ok(blueprintEntries.length > 0)

      for (const entry of [...blueprintEntries, ...entityEntries]) {
        assert.equal(typeof entry.id, 'string')
        assert.match(entry.hash, /^[a-f0-9]{64}$/)
        assert.equal(typeof entry.lastSyncedAt, 'string')
        assert.ok(Object.prototype.hasOwnProperty.call(entry, 'lastSyncedRevision'))
        assert.ok(Object.prototype.hasOwnProperty.call(entry, 'lastOpId'))
      }

      const admin = new AdminWsClient({
        worldUrl: world.worldUrl,
        adminCode: world.adminCode,
      })
      await admin.connect()
      try {
        const blueprintId = 'phase1sync__main'
        await admin.request('blueprint_add', {
          blueprint: {
            id: blueprintId,
            version: 0,
            name: 'Phase1 Sync Blueprint',
            model: null,
            script: '',
            props: {},
          },
        })

        await waitFor(() => {
          const nextState = readJsonFile(syncStatePath)
          if (!nextState?.objects?.blueprints) return false
          return Object.values(nextState.objects.blueprints).find(entry => entry.id === blueprintId) || false
        }, { timeoutMs: 8000 })
      } finally {
        admin.close()
      }
    } finally {
      process.env.WORLD_ID = savedEnv.WORLD_ID
      process.env.WORLD_URL = savedEnv.WORLD_URL
      await stopAppServer(appServer)
    }
  })
})
