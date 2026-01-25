import assert from 'node:assert/strict'
import fs from 'fs/promises'
import http from 'node:http'
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

async function startAssetServer(assets) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://localhost')
      if (!url.pathname.startsWith('/assets/')) {
        res.statusCode = 404
        res.end()
        return
      }
      const filename = url.pathname.slice('/assets/'.length)
      if (!Object.prototype.hasOwnProperty.call(assets, filename)) {
        res.statusCode = 404
        res.end()
        return
      }
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/javascript')
      res.end(assets[filename])
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        url: `http://127.0.0.1:${address.port}/assets`,
        close: () => new Promise(closeResolve => server.close(closeResolve)),
      })
    })
  })
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
  const scriptPath = path.join(rootDir, 'apps', 'TestApp', 'index.js')
  assert.equal(await fileExists(scriptPath), false)

  await server.exportWorldToDisk(snapshot, { includeBuiltScripts: true })
  assert.equal(await fileExists(scriptPath), true)
  const content = await fs.readFile(scriptPath, 'utf8')
  assert.ok(!content.startsWith('// @ts-nocheck'))
  assert.match(content, /console\.log\("hi"\)/)
})

test('world export includes module sources by default', async () => {
  const rootDir = await createTempDir('hyperfy-export-modules-')
  const assets = {
    'entry.js': 'export default () => {\n  return 42\n}\n',
    'helper.js': 'export const value = 3\n',
  }
  const assetServer = await startAssetServer(assets)
  const server = new DirectAppServer({ worldUrl: 'http://example.com', rootDir })

  const snapshot = {
    assetsUrl: assetServer.url,
    settings: {},
    spawn: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
    entities: [],
    blueprints: [
      {
        id: 'ModuleApp',
        name: 'ModuleApp',
        script: 'asset://entry.js',
        scriptFormat: 'module',
        scriptEntry: 'index.js',
        scriptFiles: {
          'index.js': 'asset://entry.js',
          'helpers/util.js': 'asset://helper.js',
        },
        props: {},
      },
    ],
  }

  try {
    await server.exportWorldToDisk(snapshot)
    const appDir = path.join(rootDir, 'apps', 'ModuleApp')
    const entryPath = path.join(appDir, 'index.js')
    const helperPath = path.join(appDir, 'helpers', 'util.js')
    assert.equal(await fileExists(entryPath), true)
    assert.equal(await fileExists(helperPath), true)
    const entry = await fs.readFile(entryPath, 'utf8')
    assert.match(entry, /export default/)
  } finally {
    await assetServer.close()
  }
})
