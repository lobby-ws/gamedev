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

test('scaffold writes builtins and world manifest', async () => {
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

  const typesPath = path.join(rootDir, 'hyperfy.app-runtime.d.ts')
  const typesContent = await fs.readFile(typesPath, 'utf8')
  assert.equal(typesContent.trim(), '/// <reference types="gamedev/app-runtime" />')

  const modelConfig = await readJson(path.join(rootDir, 'apps', 'Model', 'Model.json'))
  assert.equal(modelConfig.model, 'asset://Model.glb')
  assert.equal(modelConfig.image?.url, 'asset://Model.png')

  const sceneConfig = await readJson(path.join(rootDir, 'apps', '$scene', '$scene.json'))
  assert.equal(sceneConfig.scene, true)
  assert.equal(sceneConfig.model, 'asset://The_Meadow.glb')

  const modelScript = await fs.readFile(path.join(rootDir, 'apps', 'Model', 'index.ts'), 'utf8')
  assert.ok(modelScript.startsWith('// @ts-nocheck'))
  assert.match(modelScript, /app\.configure/)
})
