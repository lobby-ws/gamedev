import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { pathToFileURL } from 'url'
import { test } from 'node:test'

import { ModsDeployer } from '../../app-server/mods.js'
import { loadServerMods } from '../../src/core/mods/loadServerMods.js'
import { loadClientMods } from '../../src/core/mods/loadClientMods.js'
import { loadClientUIMods } from '../../src/core/mods/loadClientUIMods.js'
import { createTempDir } from './helpers.js'

async function writeFile(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, contents, 'utf8')
}

function toAssetsUrl(assetsDir) {
  return pathToFileURL(assetsDir).href.replace(/\/+$/, '')
}

class InMemoryModsAdminClient {
  constructor() {
    this.manifest = null
    this.loadOrderOverride = null
    this.uploads = new Map()
    this.lockToken = null
  }

  async getModsState() {
    return {
      manifest: this.manifest,
      loadOrderOverride: this.loadOrderOverride,
    }
  }

  async acquireDeployLock() {
    this.lockToken = 'mods-lock-token'
    return { token: this.lockToken }
  }

  async releaseDeployLock() {
    this.lockToken = null
    return { ok: true }
  }

  async uploadAsset({ filename, buffer, mimeType }) {
    this.uploads.set(filename, { buffer, mimeType })
    return { ok: true }
  }

  async putModsManifest({ manifest, lockToken }) {
    assert.equal(lockToken, this.lockToken)
    this.manifest = manifest
    return { ok: true, manifest }
  }
}

test('mods workflow: deploy pipeline writes manifest and uploads bundles', async () => {
  const rootDir = await createTempDir('hyperfy-mods-workflow-deploy-')
  await writeFile(
    path.join(rootDir, 'mods', 'core', 'server', 'EchoServer.js'),
    'export default class EchoServer { start() {} }\n'
  )
  await writeFile(
    path.join(rootDir, 'mods', 'core', 'client', 'EchoClient.js'),
    'export default class EchoClient { start() {} }\n'
  )
  await writeFile(
    path.join(rootDir, 'mods', 'client', 'components', 'Panel.js'),
    'export default function Panel() { return null }\n'
  )
  await writeFile(
    path.join(rootDir, 'mods', 'client', 'sidebar', 'Tools.js'),
    'export function ToolsButton() { return null }\nexport function ToolsPane() { return null }\n'
  )
  await writeFile(
    path.join(rootDir, 'mods', 'load-order.json'),
    JSON.stringify(['core.server.EchoServer', 'core.client.EchoClient'], null, 2)
  )

  const adminClient = new InMemoryModsAdminClient()
  const deployer = new ModsDeployer({ rootDir, adminClient })
  const result = await deployer.deploy({ note: 'workflow-test' })

  assert.equal(result.dryRun, false)
  assert.ok(adminClient.manifest)
  assert.equal(adminClient.manifest.deployNote, 'workflow-test')
  assert.equal(adminClient.manifest.modules.length, 4)
  assert.equal(adminClient.manifest.loadOrder.order.length, 2)
  assert.ok(typeof adminClient.manifest.deployedAt === 'string')
  assert.ok(adminClient.uploads.size >= 4)
  for (const upload of adminClient.uploads.values()) {
    assert.equal(upload.mimeType, 'text/javascript')
  }
})

test('mods workflow: server loader can be replayed across restarts', async () => {
  const rootDir = await createTempDir('hyperfy-mods-workflow-restart-')
  const assetsDir = path.join(rootDir, 'assets')
  await writeFile(path.join(assetsDir, 'server-mod.js'), 'export default class ServerMod {}\n')

  const manifest = {
    version: 1,
    modules: [
      {
        id: 'core.server.serverMod',
        kind: 'system',
        scope: 'server',
        systemKey: 'mod_server_mod',
        serverUrl: 'asset://server-mod.js',
      },
    ],
  }

  const firstBoot = await loadServerMods({ manifest, assetsDir })
  assert.equal(firstBoot.order[0], 'core.server.serverMod')
  assert.equal(firstBoot.systems[0].key, 'mod_server_mod')
  assert.equal(firstBoot.systems[0].System.name, 'ServerMod')

  const secondBoot = await loadServerMods({ manifest, assetsDir })
  assert.equal(secondBoot.order[0], 'core.server.serverMod')
  assert.equal(secondBoot.systems[0].key, 'mod_server_mod')
  assert.equal(secondBoot.systems[0].System.name, 'ServerMod')
})

test('mods workflow: client system + ui modules load from one manifest', async () => {
  const rootDir = await createTempDir('hyperfy-mods-workflow-client-')
  const assetsDir = path.join(rootDir, 'assets')
  await writeFile(path.join(assetsDir, 'client-system.js'), 'export default class ClientSystem {}\n')
  await writeFile(path.join(assetsDir, 'component.js'), 'export default function Component() { return null }\n')
  await writeFile(
    path.join(assetsDir, 'sidebar.js'),
    'export function SidebarButton() { return null }\nexport function SidebarPane() { return null }\n'
  )
  const assetsUrl = toAssetsUrl(assetsDir)

  const manifest = {
    version: 1,
    modules: [
      {
        id: 'core.client.clientSystem',
        kind: 'system',
        scope: 'client',
        clientUrl: 'asset://client-system.js',
      },
      {
        id: 'client.components.component',
        kind: 'component',
        clientUrl: 'asset://component.js',
      },
      {
        id: 'client.sidebar.sidebar',
        kind: 'sidebar',
        clientUrl: 'asset://sidebar.js',
        buttonExport: 'SidebarButton',
        paneExport: 'SidebarPane',
      },
    ],
    loadOrder: ['core.client.clientSystem', 'client.components.component', 'client.sidebar.sidebar'],
  }

  const registered = []
  const events = []
  const world = {
    register(key, System) {
      registered.push({ key, System })
    },
    emit(name, payload) {
      events.push({ name, payload })
    },
    modUI: null,
  }

  const mods = await loadClientMods(world, {
    manifest,
    assetsUrl,
  })
  const ui = await loadClientUIMods(world, {
    manifest: mods.manifest,
    loadOrderOverride: mods.loadOrderOverride,
    assetsUrl: mods.assetsUrl,
  })

  assert.equal(registered.length, 1)
  assert.equal(mods.loaded[0], 'core.client.clientSystem')
  assert.equal(ui.components.length, 1)
  assert.equal(ui.sidebar.length, 1)
  assert.ok(events.some(event => event.name === 'mods-ui'))
})

test('mods workflow: DB override order takes precedence over manifest order', async () => {
  const rootDir = await createTempDir('hyperfy-mods-workflow-order-')
  const assetsDir = path.join(rootDir, 'assets')
  await writeFile(path.join(assetsDir, 'a.js'), 'export default class A {}\n')
  await writeFile(path.join(assetsDir, 'b.js'), 'export default class B {}\n')
  const assetsUrl = toAssetsUrl(assetsDir)

  const manifest = {
    version: 1,
    modules: [
      {
        id: 'core.client.a',
        kind: 'system',
        scope: 'client',
        clientUrl: 'asset://a.js',
      },
      {
        id: 'core.client.b',
        kind: 'system',
        scope: 'client',
        clientUrl: 'asset://b.js',
      },
    ],
    loadOrder: ['core.client.a', 'core.client.b'],
  }

  const worldOverride = {
    order: [],
    register(key) {
      this.order.push(key)
    },
  }
  const withOverride = await loadClientMods(worldOverride, {
    manifest,
    loadOrderOverride: ['core.client.b', 'core.client.a'],
    assetsUrl,
  })
  assert.deepEqual(withOverride.loaded, ['core.client.b', 'core.client.a'])

  const worldManifestOnly = {
    order: [],
    register(key) {
      this.order.push(key)
    },
  }
  const manifestOnly = await loadClientMods(worldManifestOnly, {
    manifest,
    assetsUrl,
  })
  assert.deepEqual(manifestOnly.loaded, ['core.client.a', 'core.client.b'])
})
