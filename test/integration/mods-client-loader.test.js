import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { pathToFileURL } from 'url'
import { test } from 'node:test'

import { loadClientMods } from '../../src/core/mods/loadClientMods.js'
import { createTempDir } from './helpers.js'

async function writeFile(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, contents, 'utf8')
}

function createWorldRecorder() {
  const calls = []
  return {
    calls,
    register(key, System) {
      calls.push({ key, System })
    },
  }
}

test('loadClientMods registers client/shared systems in effective order', async () => {
  const rootDir = await createTempDir('hyperfy-client-mod-loader-')
  const assetsDir = path.join(rootDir, 'assets')
  await writeFile(path.join(assetsDir, 'client-a.js'), 'export default class ClientA {}\n')
  await writeFile(path.join(assetsDir, 'shared-b.js'), 'export default class SharedB {}\n')
  const assetsUrl = pathToFileURL(assetsDir).href.replace(/\/+$/, '')

  const manifest = {
    version: 1,
    modules: [
      {
        id: 'core.client.a',
        kind: 'system',
        scope: 'client',
        clientUrl: 'asset://client-a.js',
      },
      {
        id: 'core.shared.b',
        kind: 'system',
        scope: 'shared',
        serverUrl: 'asset://shared-b.js',
        clientUrl: 'asset://shared-b.js',
      },
    ],
    loadOrder: ['core.shared.b', 'core.client.a'],
  }

  const world = createWorldRecorder()
  const loaded = await loadClientMods(world, {
    manifest,
    loadOrderOverride: ['core.client.a', 'core.shared.b'],
    assetsUrl,
  })

  assert.equal(loaded.source, 'override')
  assert.deepEqual(loaded.loaded, ['core.client.a', 'core.shared.b'])
  assert.equal(world.calls.length, 2)
})

test('loadClientMods can fetch manifest payload and ignore invalid override', async () => {
  const rootDir = await createTempDir('hyperfy-client-mod-loader-fetch-')
  const assetsDir = path.join(rootDir, 'assets')
  await writeFile(path.join(assetsDir, 'one.js'), 'export default class One {}\n')
  await writeFile(path.join(assetsDir, 'two.js'), 'export default class Two {}\n')
  const assetsUrl = pathToFileURL(assetsDir).href.replace(/\/+$/, '')

  const manifest = {
    version: 1,
    modules: [
      {
        id: 'core.client.one',
        kind: 'system',
        scope: 'client',
        clientUrl: 'asset://one.js',
      },
      {
        id: 'core.client.two',
        kind: 'system',
        scope: 'client',
        clientUrl: 'asset://two.js',
      },
    ],
    loadOrder: ['core.client.two', 'core.client.one'],
  }

  const fetcher = async () => ({
    ok: true,
    async json() {
      return {
        manifest,
        loadOrderOverride: ['missing.mod'],
        assetsUrl,
      }
    },
  })

  const world = createWorldRecorder()
  const loaded = await loadClientMods(world, {
    fetcher,
  })

  assert.equal(loaded.source, 'manifest')
  assert.deepEqual(loaded.loaded, ['core.client.two', 'core.client.one'])
  assert.ok(loaded.warnings.some(item => item.includes('mods_load_order_override_ignored')))
  assert.equal(world.calls.length, 2)
})

test('loadClientMods resolves asset URLs against http assets base (s3 style)', async () => {
  const world = createWorldRecorder()
  const manifest = {
    version: 1,
    modules: [
      {
        id: 'core.client.remote',
        kind: 'system',
        scope: 'client',
        clientUrl: 'asset://remote.js',
      },
    ],
  }

  const seen = []
  await loadClientMods(world, {
    manifest,
    assetsUrl: 'https://cdn.example.com/assets',
    importModule: async specifier => {
      seen.push(specifier)
      return { default: class RemoteClientSystem {} }
    },
  })

  assert.deepEqual(seen, ['https://cdn.example.com/assets/remote.js'])
  assert.equal(world.calls.length, 1)
})
