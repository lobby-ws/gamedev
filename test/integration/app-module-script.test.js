import 'ses'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { test } from 'node:test'
import { World } from '../../src/core/World.js'
import { ServerLoader } from '../../src/core/systems/ServerLoader.js'
import { createTempDir, getRepoRoot, waitFor } from './helpers.js'

test('app executes module scripts via scriptRef', async () => {
  const rootDir = await createTempDir('hyperfy-app-modules-')
  const assetsDir = path.join(rootDir, 'assets')
  await fs.mkdir(path.join(assetsDir, 'helpers'), { recursive: true })
  await fs.copyFile(
    path.join(getRepoRoot(), 'src/world/assets/empty.glb'),
    path.join(assetsDir, 'model.glb')
  )
  await fs.writeFile(
    path.join(assetsDir, 'index.js'),
    [
      "import { add } from './helpers/math.js'",
      'export default (world, app, fetch, props) => {',
      '  app.state = { total: add(props.a, props.b) }',
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
  world.environment = { csm: null }
  world.network = {
    id: 'server',
    isServer: true,
    isClient: false,
    getTime: () => 0,
    send: () => {},
    sendTo: () => {},
  }

  const scriptRoot = {
    id: 'mathapp',
    version: 1,
    script: 'asset://index.js',
    scriptFormat: 'module',
    scriptEntry: 'index.js',
    scriptFiles: {
      'index.js': 'asset://index.js',
      'helpers/math.js': 'asset://helpers/math.js',
    },
  }

  const variant = {
    id: 'mathapp__variant',
    version: 1,
    name: 'MathApp',
    model: 'asset://model.glb',
    script: 'asset://index.js',
    scriptRef: 'mathapp',
    props: { a: 2, b: 3 },
  }

  world.blueprints.add(scriptRoot)
  world.blueprints.add(variant)

  const appEntity = world.entities.add({
    id: 'entity-1',
    type: 'app',
    blueprint: variant.id,
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    mover: null,
    uploader: null,
    pinned: false,
    props: {},
    state: {},
  })

  await waitFor(() => appEntity.data.state?.total === 5)
  assert.equal(appEntity.data.state.total, 5)
})
