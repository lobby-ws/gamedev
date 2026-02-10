import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { test } from 'node:test'

import { loadServerMods } from '../../src/core/mods/loadServerMods.js'
import { createTempDir } from './helpers.js'

async function writeFile(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, contents, 'utf8')
}

test('loadServerMods resolves effective order and loads systems', async () => {
  const rootDir = await createTempDir('hyperfy-server-mod-loader-')
  const assetsDir = path.join(rootDir, 'assets')
  await writeFile(
    path.join(assetsDir, 'server-a.js'),
    'export default class ModA { start() { this.world.__modA = true } }\n'
  )
  await writeFile(
    path.join(assetsDir, 'shared-b.js'),
    'export default class ModB { start() { this.world.__modB = true } }\n'
  )

  const manifest = {
    version: 1,
    modules: [
      {
        id: 'core.server.a',
        kind: 'system',
        scope: 'server',
        serverUrl: 'asset://server-a.js',
      },
      {
        id: 'core.shared.b',
        kind: 'system',
        scope: 'shared',
        serverUrl: 'asset://shared-b.js',
        clientUrl: 'asset://shared-b.js',
      },
    ],
    loadOrder: ['core.shared.b', 'core.server.a'],
  }

  const loaded = await loadServerMods({
    manifest,
    assetsDir,
    loadOrderOverride: ['core.server.a', 'core.shared.b'],
  })

  assert.equal(loaded.source, 'override')
  assert.deepEqual(loaded.order, ['core.server.a', 'core.shared.b'])
  assert.equal(loaded.systems.length, 2)
  assert.equal(typeof loaded.systems[0].System, 'function')
  assert.equal(typeof loaded.systems[1].System, 'function')
})

test('loadServerMods ignores invalid override and falls back to manifest order', async () => {
  const rootDir = await createTempDir('hyperfy-server-mod-loader-fallback-')
  const assetsDir = path.join(rootDir, 'assets')
  await writeFile(
    path.join(assetsDir, 'one.js'),
    'export default class One {}\n'
  )
  await writeFile(
    path.join(assetsDir, 'two.js'),
    'export default class Two {}\n'
  )

  const manifest = {
    version: 1,
    modules: [
      {
        id: 'core.server.one',
        kind: 'system',
        scope: 'server',
        serverUrl: 'asset://one.js',
      },
      {
        id: 'core.server.two',
        kind: 'system',
        scope: 'server',
        serverUrl: 'asset://two.js',
      },
    ],
    loadOrder: ['core.server.two', 'core.server.one'],
  }

  const loaded = await loadServerMods({
    manifest,
    assetsDir,
    loadOrderOverride: ['missing.mod'],
  })

  assert.equal(loaded.source, 'manifest')
  assert.deepEqual(loaded.order, ['core.server.two', 'core.server.one'])
  assert.ok(loaded.warnings.some(item => item.includes('mods_load_order_override_ignored')))
})

test('loadServerMods throws when module has no default export', async () => {
  const rootDir = await createTempDir('hyperfy-server-mod-loader-invalid-export-')
  const assetsDir = path.join(rootDir, 'assets')
  await writeFile(path.join(assetsDir, 'bad.js'), 'export const value = 1\n')

  const manifest = {
    version: 1,
    modules: [
      {
        id: 'core.server.bad',
        kind: 'system',
        scope: 'server',
        serverUrl: 'asset://bad.js',
      },
    ],
  }

  await assert.rejects(
    () =>
      loadServerMods({
        manifest,
        assetsDir,
      }),
    /mod_system_default_export_missing:core.server.bad/
  )
})

test('loadServerMods can load from HTTP assets URL (s3 style)', async () => {
  const manifest = {
    version: 1,
    modules: [
      {
        id: 'core.server.remote',
        kind: 'system',
        scope: 'server',
        serverUrl: 'asset://remote.js',
      },
    ],
  }

  const originalFetch = global.fetch
  global.fetch = async url => {
    if (url === 'https://cdn.example.com/assets/remote.js') {
      return {
        ok: true,
        status: 200,
        async text() {
          return 'export default class RemoteSystem {}\n'
        },
      }
    }
    return {
      ok: false,
      status: 404,
      async text() {
        return 'not found'
      },
    }
  }
  try {
    const assetsUrl = 'https://cdn.example.com/assets'
      const loaded = await loadServerMods({
        manifest,
        assetsUrl,
      })
      assert.equal(loaded.systems.length, 1)
      assert.equal(loaded.order[0], 'core.server.remote')
      assert.equal(typeof loaded.systems[0].System, 'function')
  } finally {
    global.fetch = originalFetch
  }
})
