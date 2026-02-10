import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { test } from 'node:test'

import { ModsDeployer } from '../../app-server/mods.js'
import { createTempDir } from './helpers.js'

async function writeFile(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, contents, 'utf8')
}

test('mods deployer builds manifest and bundles per target', async () => {
  const rootDir = await createTempDir('hyperfy-mods-build-')
  await writeFile(
    path.join(rootDir, 'mods', 'core', 'server', 'EchoServer.js'),
    'export default class EchoServer { start() { this.world.__serverEcho = true } }\n'
  )
  await writeFile(
    path.join(rootDir, 'mods', 'core', 'shared', 'EchoShared.js'),
    'export default class EchoShared { start() { this.world.__sharedEcho = true } }\n'
  )
  await writeFile(
    path.join(rootDir, 'mods', 'client', 'components', 'Panel.jsx'),
    'export default function Panel() { return null }\n'
  )
  await writeFile(
    path.join(rootDir, 'mods', 'client', 'sidebar', 'Tools.jsx'),
    'export function ToolsButton() { return null }\nexport function ToolsPane() { return null }\n'
  )
  await writeFile(
    path.join(rootDir, 'mods', 'load-order.json'),
    JSON.stringify(['core.shared.EchoShared', 'core.server.EchoServer'], null, 2)
  )

  const deployer = new ModsDeployer({
    rootDir,
    adminClient: {
      getModsState: async () => ({ manifest: null, loadOrderOverride: null }),
    },
  })

  const { manifest, bundles } = await deployer.buildManifest({ note: 'integration' })
  assert.equal(manifest.modules.length, 4)
  assert.equal(manifest.loadOrder.order.length, 2)
  assert.equal(manifest.deployNote, 'integration')

  const shared = manifest.modules.find(module => module.id === 'core.shared.EchoShared')
  assert.equal(shared.kind, 'system')
  assert.ok(shared.serverUrl?.startsWith('asset://mods/'))
  assert.ok(shared.clientUrl?.startsWith('asset://mods/'))

  const sidebar = manifest.modules.find(module => module.id === 'client.sidebar.Tools')
  assert.equal(sidebar.buttonExport, 'ToolsButton')
  assert.equal(sidebar.paneExport, 'ToolsPane')

  assert.ok(bundles.size >= 4)
  for (const filename of bundles.keys()) {
    assert.ok(filename.startsWith('mods/'))
  }
})

test('mods deployer infers sidebar exports when module contains JSX', async () => {
  const rootDir = await createTempDir('hyperfy-mods-sidebar-jsx-')
  await writeFile(
    path.join(rootDir, 'mods', 'client', 'sidebar', 'Tools.js'),
    `
export function ToolsButton() {
  return 'Tools'
}

export function ToolsPane({ hidden }) {
  if (hidden) return null
  return <div>pane</div>
}
`
  )

  const deployer = new ModsDeployer({
    rootDir,
    adminClient: {
      getModsState: async () => ({ manifest: null, loadOrderOverride: null }),
    },
  })

  const { manifest } = await deployer.buildManifest()
  const sidebar = manifest.modules.find(module => module.id === 'client.sidebar.Tools')
  assert.equal(sidebar.buttonExport, 'ToolsButton')
  assert.equal(sidebar.paneExport, 'ToolsPane')
})

test('mods deployer dry-run does not upload or publish', async () => {
  const rootDir = await createTempDir('hyperfy-mods-dryrun-')
  await writeFile(
    path.join(rootDir, 'mods', 'core', 'client', 'EchoClient.js'),
    'export default class EchoClient { start() { this.world.__clientEcho = true } }\n'
  )

  const calls = {
    upload: 0,
    putManifest: 0,
    lock: 0,
  }
  const adminClient = {
    getModsState: async () => ({ manifest: null, loadOrderOverride: null }),
    acquireDeployLock: async () => {
      calls.lock += 1
      return { token: 'lock-token' }
    },
    releaseDeployLock: async () => {},
    uploadAsset: async () => {
      calls.upload += 1
    },
    putModsManifest: async () => {
      calls.putManifest += 1
    },
  }

  const deployer = new ModsDeployer({ rootDir, adminClient })
  const result = await deployer.deploy({ dryRun: true })
  assert.equal(result.dryRun, true)
  assert.equal(calls.lock, 0)
  assert.equal(calls.upload, 0)
  assert.equal(calls.putManifest, 0)
  assert.ok(result.plan.uploads.length >= 1)
})

test('mods deployer rejects invalid load-order references', async () => {
  const rootDir = await createTempDir('hyperfy-mods-order-invalid-')
  await writeFile(
    path.join(rootDir, 'mods', 'core', 'client', 'OnlyClient.js'),
    'export default class OnlyClient { start() {} }\n'
  )
  await writeFile(
    path.join(rootDir, 'mods', 'load-order.json'),
    JSON.stringify(['missing.mod'], null, 2)
  )

  const deployer = new ModsDeployer({
    rootDir,
    adminClient: {
      getModsState: async () => ({ manifest: null, loadOrderOverride: null }),
    },
  })

  await assert.rejects(() => deployer.buildManifest(), /unknown_order_id:missing.mod/)
})
