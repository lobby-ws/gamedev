import 'ses'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { test } from 'node:test'
import { World } from '../../src/core/World.js'
import { ServerLoader } from '../../src/core/systems/ServerLoader.js'
import { createTempDir } from './helpers.js'

test('module scripts load and execute on server runtime', async () => {
  const rootDir = await createTempDir('hyperfy-modules-')
  const assetsDir = path.join(rootDir, 'assets')
  await fs.mkdir(path.join(assetsDir, 'helpers'), { recursive: true })
  await fs.writeFile(
    path.join(assetsDir, 'entry.js'),
    [
      "import { add } from './helpers/math.js'",
      'export default (world, app, fetch, props) => {',
      '  world.total = add(props.a, props.b)',
      '}',
    ].join('\n'),
    'utf8'
  )
  await fs.writeFile(
    path.join(assetsDir, 'helpers', 'math.js'),
    'export const add = (a, b) => a + b',
    'utf8'
  )

  const world = new World()
  world.register('loader', ServerLoader)
  world.assetsDir = assetsDir

  const blueprint = {
    id: 'mathapp',
    version: 1,
    scriptFormat: 'module',
    scriptEntry: 'index.js',
    scriptFiles: {
      'index.js': 'asset://entry.js',
      'helpers/math.js': 'asset://helpers/math.js',
    },
  }

  const { exec } = await world.scripts.loadModuleScript({ blueprint })
  const runtimeWorld = { total: 0 }
  exec(runtimeWorld, {}, null, { a: 2, b: 3 }, () => {})
  assert.equal(runtimeWorld.total, 5)
})

test('legacy-body entry preserves imports and wraps body', async () => {
  const rootDir = await createTempDir('hyperfy-legacy-body-')
  const assetsDir = path.join(rootDir, 'assets')
  await fs.mkdir(path.join(assetsDir, 'helpers'), { recursive: true })
  await fs.writeFile(
    path.join(assetsDir, 'entry.js'),
    [
      "import { add } from './helpers/math.js'",
      'if (!shared.count) shared.count = 0',
      'shared.count += 1',
      'world.sharedCount = shared.count',
      'world.total = add(config.a, config.b)',
    ].join('\n'),
    'utf8'
  )
  await fs.writeFile(
    path.join(assetsDir, 'helpers', 'math.js'),
    'export const add = (a, b) => a + b',
    'utf8'
  )

  const world = new World()
  world.register('loader', ServerLoader)
  world.assetsDir = assetsDir

  const blueprint = {
    id: 'legacyapp',
    version: 1,
    scriptFormat: 'legacy-body',
    scriptEntry: 'index.js',
    scriptFiles: {
      'index.js': 'asset://entry.js',
      'helpers/math.js': 'asset://helpers/math.js',
    },
  }

  const { exec } = await world.scripts.loadModuleScript({ blueprint })
  const runtimeWorld = { total: 0, sharedCount: 0 }
  exec(runtimeWorld, {}, null, { a: 2, b: 3 }, () => {})
  assert.equal(runtimeWorld.total, 5)
  assert.equal(runtimeWorld.sharedCount, 1)
  exec(runtimeWorld, {}, null, { a: 1, b: 1 }, () => {})
  assert.equal(runtimeWorld.total, 2)
  assert.equal(runtimeWorld.sharedCount, 2)
})

test('shared import aliases resolve to shared script files', async () => {
  const rootDir = await createTempDir('hyperfy-shared-modules-')
  const assetsDir = path.join(rootDir, 'assets')
  await fs.mkdir(assetsDir, { recursive: true })
  await fs.writeFile(
    path.join(assetsDir, 'entry.js'),
    [
      "import { add } from 'shared/math.js'",
      'export default (world, app, fetch, props) => {',
      '  world.total = add(props.a, props.b)',
      '}',
    ].join('\n'),
    'utf8'
  )
  await fs.writeFile(
    path.join(assetsDir, 'shared-math.js'),
    'export const add = (a, b) => a + b',
    'utf8'
  )

  const world = new World()
  world.register('loader', ServerLoader)
  world.assetsDir = assetsDir

  const blueprint = {
    id: 'sharedapp',
    version: 1,
    scriptFormat: 'module',
    scriptEntry: 'index.js',
    scriptFiles: {
      'index.js': 'asset://entry.js',
      '@shared/math.js': 'asset://shared-math.js',
    },
  }

  const { exec } = await world.scripts.loadModuleScript({ blueprint })
  const runtimeWorld = { total: 0 }
  exec(runtimeWorld, {}, null, { a: 7, b: 4 }, () => {})
  assert.equal(runtimeWorld.total, 11)
})
