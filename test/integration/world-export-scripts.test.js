import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { test } from 'node:test'
import { DirectAppServer } from '../../app-server/direct.js'
import { createTempDir } from './helpers.js'

async function fileExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

test('world export skips scripts by default and includes when requested', async () => {
  const rootDir = await createTempDir('hyperfy-export-')
  const server = new DirectAppServer({ worldUrl: 'http://example.com', rootDir })

  const snapshot = {
    assetsUrl: 'http://example.com/assets',
    settings: {},
    spawn: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
    entities: [],
    blueprints: [
      {
        id: 'TestApp__Main',
        name: 'TestApp',
        script: 'console.log("hi")',
        props: {},
      },
    ],
  }

  await server.exportWorldToDisk(snapshot)
  const scriptPath = path.join(rootDir, 'apps', 'TestApp', 'index.ts')
  assert.equal(await fileExists(scriptPath), false)

  await server.exportWorldToDisk(snapshot, { includeBuiltScripts: true })
  assert.equal(await fileExists(scriptPath), true)
  const content = await fs.readFile(scriptPath, 'utf8')
  assert.ok(content.startsWith('// @ts-nocheck'))
  assert.match(content, /console\.log\("hi"\)/)
})
