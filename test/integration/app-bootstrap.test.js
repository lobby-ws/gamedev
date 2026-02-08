import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { test } from 'node:test'
import { DirectAppServer } from '../../app-server/direct.js'
import { createTempDir } from './helpers.js'

async function readJson(filePath) {
  const content = await fs.readFile(filePath, 'utf8')
  return JSON.parse(content)
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

test('scaffold writes scene scaffold and world manifest', async () => {
  const rootDir = await createTempDir('hyperfy-bootstrap-')
  const server = new DirectAppServer({ worldUrl: 'http://example.com', rootDir })

  const manifest = await server._scaffoldLocalProject()
  assert.equal(manifest.entities.length, 1)
  assert.equal(manifest.entities[0].blueprint, '$scene')

  const worldPath = path.join(rootDir, 'world.json')
  const world = await readJson(worldPath)
  assert.equal(world.formatVersion, 2)
  assert.equal(world.entities.length, 1)
  assert.equal(world.entities[0].blueprint, '$scene')

  const tsconfigPath = path.join(rootDir, 'tsconfig.json')
  const tsconfig = await readJson(tsconfigPath)
  assert.ok(tsconfig.compilerOptions.types.includes('gamedev'))
  assert.equal(await fileExists(path.join(rootDir, 'hyperfy.app-runtime.d.ts')), false)

  assert.equal(await fileExists(path.join(rootDir, 'apps', 'Model', 'Model.json')), false)
  assert.equal(await fileExists(path.join(rootDir, 'apps', 'Model', 'index.js')), false)

  const sceneConfig = await readJson(path.join(rootDir, 'apps', '$scene', '$scene.json'))
  assert.equal(sceneConfig.scene, true)
  assert.equal(sceneConfig.model, 'assets/Model.glb')
  assert.equal(sceneConfig.scriptFormat, 'module')

  const sceneScript = await fs.readFile(path.join(rootDir, 'apps', '$scene', 'index.js'), 'utf8')
  assert.ok(!sceneScript.startsWith('// @ts-nocheck'))
  assert.match(sceneScript, /app\.configure/)
})
