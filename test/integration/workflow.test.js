import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { test } from 'node:test'
import { DirectAppServer } from '../../app-server/direct.js'
import { runAppCommand } from '../../app-server/commands.js'
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

function buildBlueprintPayload({ id, name, script }) {
  return {
    id,
    version: 0,
    name,
    script,
    props: { text: 'default' },
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

test('workflow vnext integrations (server/app-server)', { timeout: 120000 }, async t => {
  await t.test('A2 instance props round-trip via app-server', async () => {
    await withWorldServer(async world => {
      const rootDir = await createTempDir('hyperfy-project-')
      const savedEnv = {
        WORLD_ID: process.env.WORLD_ID,
        WORLD_URL: process.env.WORLD_URL,
      }
      process.env.WORLD_ID = world.worldId
      process.env.WORLD_URL = world.worldUrl
      const appServer = new DirectAppServer({
        worldUrl: world.worldUrl,
        adminCode: world.adminCode,
        deployCode: world.deployCode,
        rootDir,
      })
      try {
        await appServer.start()

        const admin = new AdminWsClient({
          worldUrl: world.worldUrl,
          adminCode: world.adminCode,
          deployCode: world.deployCode,
        })
        await admin.connect()

        const blueprintId = 'testapp__main'
        await admin.request('blueprint_add', {
          blueprint: buildBlueprintPayload({ id: blueprintId, name: 'TestApp', script: '' }),
        })
        const entityId = `entity-${Date.now()}`
        await admin.request('entity_add', {
          entity: buildEntityPayload({ id: entityId, blueprint: blueprintId }),
        })

        const worldPath = path.join(rootDir, 'world.json')
        await waitFor(() => {
          const data = readJsonFile(worldPath)
          if (!data) return false
          return data.entities?.find(entity => entity.id === entityId) || false
        })

        await admin.request('entity_modify', {
          change: { id: entityId, props: { text: 'hello' } },
        })

        await waitFor(() => {
          const data = readJsonFile(worldPath)
          if (!data) return false
          const entity = data.entities?.find(item => item.id === entityId)
          return entity?.props?.text === 'hello'
        })

        await assert.rejects(
          () => admin.request('entity_modify', { change: { id: entityId, props: [] } }),
          err => err?.code === 'invalid_payload'
        )

        const manifest = readJsonFile(worldPath)
        const target = manifest.entities.find(item => item.id === entityId)
        target.props = { text: 'from-file' }
        fs.writeFileSync(worldPath, JSON.stringify(manifest, null, 2))
        await appServer._onWorldFileChanged()

        await waitFor(async () => {
          const { res, data } = await fetchJson(`${world.worldUrl}/admin/snapshot`, {
            adminCode: world.adminCode,
          })
          if (!res.ok) return false
          const entity = data.entities?.find(item => item.id === entityId)
          return entity?.props?.text === 'from-file'
        }, { timeoutMs: 6000 })

        admin.close()
      } finally {
        process.env.WORLD_ID = savedEnv.WORLD_ID
        process.env.WORLD_URL = savedEnv.WORLD_URL
        await stopAppServer(appServer)
      }
    })
  })

  await t.test('B1 deploy capability blocks script changes', async () => {
    await withWorldServer(async world => {
      const adminDeploy = new AdminWsClient({
        worldUrl: world.worldUrl,
        adminCode: world.adminCode,
        deployCode: world.deployCode,
      })
      await adminDeploy.connect()

      const { data: lock } = await fetchJson(`${world.worldUrl}/admin/deploy-lock`, {
        adminCode: world.adminCode,
        deployCode: world.deployCode,
        method: 'POST',
        body: { owner: 'b1-test' },
      })

      const blueprintId = 'b1app__main'
      await adminDeploy.request('blueprint_add', {
        blueprint: buildBlueprintPayload({ id: blueprintId, name: 'B1App', script: 'console.log("v1")' }),
        lockToken: lock.token,
      })

      await fetchJson(`${world.worldUrl}/admin/deploy-lock`, {
        adminCode: world.adminCode,
        deployCode: world.deployCode,
        method: 'DELETE',
        body: { token: lock.token },
      })

      const adminBuilder = new AdminWsClient({
        worldUrl: world.worldUrl,
        adminCode: world.adminCode,
      })
      await adminBuilder.connect()

      const { data: current } = await fetchJson(`${world.worldUrl}/admin/blueprints/${blueprintId}`, {
        adminCode: world.adminCode,
      })
      const nextVersion = (current.blueprint?.version || 0) + 1

      await assert.rejects(
        () =>
          adminBuilder.request('blueprint_modify', {
            change: { id: blueprintId, version: nextVersion, script: 'console.log("v2")' },
          }),
        err => err?.code === 'deploy_required'
      )

      await assert.rejects(
        () =>
          adminBuilder.request('blueprint_modify', {
            change: {
              id: blueprintId,
              version: nextVersion,
              scriptFiles: { 'index.js': 'asset://entry.js' },
            },
          }),
        err => err?.code === 'deploy_required'
      )

      await adminBuilder.request('blueprint_modify', {
        change: { id: blueprintId, version: nextVersion, name: 'B1AppUpdated' },
      })

      adminBuilder.close()
      adminDeploy.close()
    })
  })

  await t.test('C1 admin subscriptions gate player streams', async () => {
    await withWorldServer(async world => {
      const adminQuiet = new AdminWsClient({
        worldUrl: world.worldUrl,
        adminCode: world.adminCode,
        subscriptions: { snapshot: true, players: false, runtime: false },
      })
      const adminLive = new AdminWsClient({
        worldUrl: world.worldUrl,
        adminCode: world.adminCode,
        subscriptions: { snapshot: true, players: true, runtime: false },
      })
      await adminQuiet.connect()
      await adminLive.connect()

      const quietWait = adminQuiet.waitForEvent('playerJoined', { timeoutMs: 1000 })
      const liveWait = adminLive.waitForEvent('playerJoined', { timeoutMs: 3000 })

      const playerWs = new WebSocket(`${world.wsUrl}?name=IntegrationTester`)
      await new Promise(resolve => playerWs.addEventListener('open', resolve, { once: true }))

      await assert.rejects(quietWait, /timeout/)
      const joined = await liveWait
      assert.ok(joined?.id)

      playerWs.close()
      adminQuiet.close()
      adminLive.close()
    })
  })

  await t.test('D1 targets config resolves without env', async () => {
    await withWorldServer(async world => {
      const rootDir = await createTempDir('hyperfy-targets-')
      const targetDir = path.join(rootDir, '.lobby')
      fs.mkdirSync(targetDir, { recursive: true })
      const targetsPath = path.join(targetDir, 'targets.json')
      fs.writeFileSync(
        targetsPath,
        JSON.stringify(
          {
            dev: {
              worldUrl: world.worldUrl,
              worldId: world.worldId,
              adminCode: world.adminCode,
              deployCode: world.deployCode,
            },
          },
          null,
          2
        )
      )

      const savedEnv = {
        WORLD_URL: process.env.WORLD_URL,
        WORLD_ID: process.env.WORLD_ID,
        ADMIN_CODE: process.env.ADMIN_CODE,
        DEPLOY_CODE: process.env.DEPLOY_CODE,
        HYPERFY_TARGET: process.env.HYPERFY_TARGET,
        HYPERFY_TARGET_CONFIRM: process.env.HYPERFY_TARGET_CONFIRM,
      }
      delete process.env.WORLD_URL
      delete process.env.WORLD_ID
      delete process.env.ADMIN_CODE
      delete process.env.DEPLOY_CODE
      delete process.env.HYPERFY_TARGET
      delete process.env.HYPERFY_TARGET_CONFIRM

      try {
        const exitCode = await runAppCommand({
          command: 'status',
          args: ['--target', 'dev'],
          rootDir,
        })
        assert.equal(exitCode, 0)
      } finally {
        process.env.WORLD_URL = savedEnv.WORLD_URL
        process.env.WORLD_ID = savedEnv.WORLD_ID
        process.env.ADMIN_CODE = savedEnv.ADMIN_CODE
        process.env.DEPLOY_CODE = savedEnv.DEPLOY_CODE
        process.env.HYPERFY_TARGET = savedEnv.HYPERFY_TARGET
        process.env.HYPERFY_TARGET_CONFIRM = savedEnv.HYPERFY_TARGET_CONFIRM
      }
    })
  })

  await t.test('D2 deploy locks enforce script changes', async () => {
    await withWorldServer(async world => {
      const admin = new AdminWsClient({
        worldUrl: world.worldUrl,
        adminCode: world.adminCode,
        deployCode: world.deployCode,
      })
      await admin.connect()

      const { data: lockA } = await fetchJson(`${world.worldUrl}/admin/deploy-lock`, {
        adminCode: world.adminCode,
        deployCode: world.deployCode,
        method: 'POST',
        body: { owner: 'lock-a' },
      })

      const blueprintId = 'd2app__main'
      await admin.request('blueprint_add', {
        blueprint: buildBlueprintPayload({ id: blueprintId, name: 'D2App', script: 'console.log("v1")' }),
        lockToken: lockA.token,
      })

      await fetchJson(`${world.worldUrl}/admin/deploy-lock`, {
        adminCode: world.adminCode,
        deployCode: world.deployCode,
        method: 'DELETE',
        body: { token: lockA.token },
      })

      const { data: current } = await fetchJson(`${world.worldUrl}/admin/blueprints/${blueprintId}`, {
        adminCode: world.adminCode,
      })
      const version = (current.blueprint?.version || 0) + 1

      await assert.rejects(
        () =>
          admin.request('blueprint_modify', {
            change: { id: blueprintId, version, script: 'console.log("v2")' },
          }),
        err => err?.code === 'deploy_lock_required'
      )

      await assert.rejects(
        () =>
          admin.request('blueprint_modify', {
            change: { id: blueprintId, version, scriptFiles: { 'index.js': 'asset://entry.js' } },
          }),
        err => err?.code === 'deploy_lock_required'
      )

      const { data: lockB } = await fetchJson(`${world.worldUrl}/admin/deploy-lock`, {
        adminCode: world.adminCode,
        deployCode: world.deployCode,
        method: 'POST',
        body: { owner: 'lock-b' },
      })

      await assert.rejects(
        () =>
          admin.request('blueprint_modify', {
            change: { id: blueprintId, version, script: 'console.log("v2")' },
            lockToken: 'wrong-token',
          }),
        err => err?.code === 'deploy_locked'
      )

      const { data: latest } = await fetchJson(`${world.worldUrl}/admin/blueprints/${blueprintId}`, {
        adminCode: world.adminCode,
      })
      const nextVersion = (latest.blueprint?.version || 0) + 1

      await admin.request('blueprint_modify', {
        change: { id: blueprintId, version: nextVersion, script: 'console.log("v2")' },
        lockToken: lockB.token,
      })

      await fetchJson(`${world.worldUrl}/admin/deploy-lock`, {
        adminCode: world.adminCode,
        deployCode: world.deployCode,
        method: 'DELETE',
        body: { token: lockB.token },
      })

      admin.close()
    })
  })

  await t.test('D3 deploy snapshots allow rollback', async () => {
    await withWorldServer(async world => {
      const admin = new AdminWsClient({
        worldUrl: world.worldUrl,
        adminCode: world.adminCode,
        deployCode: world.deployCode,
      })
      await admin.connect()

      const { data: lock } = await fetchJson(`${world.worldUrl}/admin/deploy-lock`, {
        adminCode: world.adminCode,
        deployCode: world.deployCode,
        method: 'POST',
        body: { owner: 'snapshot-test' },
      })

      const blueprintId = 'd3app__main'
      await admin.request('blueprint_add', {
        blueprint: buildBlueprintPayload({ id: blueprintId, name: 'D3App', script: 'console.log("v1")' }),
        lockToken: lock.token,
      })

      const snapshot = await fetchJson(`${world.worldUrl}/admin/deploy-snapshots`, {
        adminCode: world.adminCode,
        deployCode: world.deployCode,
        method: 'POST',
        body: { ids: [blueprintId], note: 'before-change', lockToken: lock.token },
      })
      assert.ok(snapshot.data?.id)

      const { data: current } = await fetchJson(`${world.worldUrl}/admin/blueprints/${blueprintId}`, {
        adminCode: world.adminCode,
      })
      const nextVersion = (current.blueprint?.version || 0) + 1

      await admin.request('blueprint_modify', {
        change: { id: blueprintId, version: nextVersion, script: 'console.log("v2")' },
        lockToken: lock.token,
      })

      const rollback = await fetchJson(`${world.worldUrl}/admin/deploy-snapshots/rollback`, {
        adminCode: world.adminCode,
        deployCode: world.deployCode,
        method: 'POST',
        body: { id: snapshot.data.id, lockToken: lock.token },
      })
      assert.equal(rollback.res.ok, true)

      const { data: restored } = await fetchJson(`${world.worldUrl}/admin/blueprints/${blueprintId}`, {
        adminCode: world.adminCode,
      })
      assert.equal(restored.blueprint?.script, 'console.log("v1")')

      await fetchJson(`${world.worldUrl}/admin/deploy-lock`, {
        adminCode: world.adminCode,
        deployCode: world.deployCode,
        method: 'DELETE',
        body: { token: lock.token },
      })

      admin.close()
    })
  })

  await t.test('D4 dry-run does not mutate the world', async () => {
    await withWorldServer(async world => {
      const savedEnv = {
        WORLD_ID: process.env.WORLD_ID,
        WORLD_URL: process.env.WORLD_URL,
      }
      process.env.WORLD_ID = world.worldId
      process.env.WORLD_URL = world.worldUrl

      const rootDir = await createTempDir('hyperfy-dryrun-')
      const appDir = path.join(rootDir, 'apps', 'dryapp')
      fs.mkdirSync(appDir, { recursive: true })

      fs.writeFileSync(path.join(appDir, 'index.js'), `export const foo = "bar";\n`)
      fs.writeFileSync(
        path.join(appDir, 'main.json'),
        JSON.stringify({ props: { text: 'hello' } }, null, 2)
      )

      const server = new DirectAppServer({
        worldUrl: world.worldUrl,
        adminCode: world.adminCode,
        deployCode: world.deployCode,
        rootDir,
      })
      try {
        await server.connect()

        await server.deployApp('dryapp', { dryRun: true })

        const res = await fetch(`${world.worldUrl}/admin/blueprints/dryapp__main`, {
          headers: { 'X-Admin-Code': world.adminCode },
        })
        assert.equal(res.status, 404)

      } finally {
        process.env.WORLD_ID = savedEnv.WORLD_ID
        process.env.WORLD_URL = savedEnv.WORLD_URL
        await stopAppServer(server)
      }
    })
  })
})
