import assert from 'node:assert/strict'
import fs from 'fs/promises'
import http from 'node:http'
import path from 'path'
import { test } from 'node:test'
import { DirectAppServer } from '../../app-server/direct.js'
import { createTempDir, stopAppServer } from './helpers.js'

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

test('remote blueprint sync writes module sources to disk', async () => {
  const rootDir = await createTempDir('hyperfy-sync-')
  const assets = {
    'entry.js': 'export default () => {\n  return true\n}\n',
    'helper.js': 'export const value = 7\n',
    'stale.js': 'export default () => {\n  return false\n}\n',
  }
  const assetServer = await startAssetServer(assets)
  const server = new DirectAppServer({ worldUrl: 'http://example.com', rootDir })
  server.assetsUrl = assetServer.url
  server._initSnapshot({
    worldId: 'test',
    assetsUrl: assetServer.url,
    settings: {},
    spawn: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
    entities: [],
    blueprints: [
      {
        id: 'SyncApp',
        name: 'SyncApp',
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
  })

  const appDir = path.join(rootDir, 'apps', 'SyncApp')
  await fs.mkdir(appDir, { recursive: true })
  await fs.writeFile(path.join(appDir, 'extra.js'), 'console.log("old")\n', 'utf8')

  try {
    await server._onRemoteBlueprint({
      id: 'SyncApp__Variant',
      name: 'SyncApp',
      script: 'asset://entry.js',
      scriptRef: 'SyncApp',
      scriptEntry: 'index.js',
      scriptFiles: {
        'index.js': 'asset://stale.js',
      },
      scriptFormat: 'module',
      props: {},
    })

    const entryPath = path.join(appDir, 'index.js')
    const helperPath = path.join(appDir, 'helpers', 'util.js')
    assert.equal(await fileExists(entryPath), true)
    assert.equal(await fileExists(helperPath), true)
    assert.equal(await fileExists(path.join(appDir, 'extra.js')), false)
    const entry = await fs.readFile(entryPath, 'utf8')
    assert.match(entry, /return true/)
    assert.ok(!entry.includes('return false'))
  } finally {
    await stopAppServer(server)
    await assetServer.close()
  }
})

test('remote blueprint sync preserves non-index script entries for redeploy', async () => {
  const rootDir = await createTempDir('hyperfy-sync-entry-')
  const assets = {
    'entry.js': 'export default () => {\n  return "ok"\n}\n',
    'helper.js': 'export const value = 9\n',
  }
  const assetServer = await startAssetServer(assets)
  const server = new DirectAppServer({ worldUrl: 'http://example.com', rootDir })
  server.assetsUrl = assetServer.url
  server._initSnapshot({
    worldId: 'test',
    assetsUrl: assetServer.url,
    settings: {},
    spawn: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
    entities: [],
    blueprints: [
      {
        id: 'EntryApp',
        name: 'EntryApp',
        script: 'asset://entry.js',
        scriptFormat: 'module',
        scriptEntry: 'scripts/generated.js',
        scriptFiles: {
          'scripts/generated.js': 'asset://entry.js',
          'scripts/helper.js': 'asset://helper.js',
        },
        props: {},
      },
    ],
  })

  try {
    await server._onRemoteBlueprint({
      id: 'EntryApp',
      name: 'EntryApp',
      script: 'asset://entry.js',
      scriptFormat: 'module',
      scriptEntry: 'scripts/generated.js',
      scriptFiles: {
        'scripts/generated.js': 'asset://entry.js',
        'scripts/helper.js': 'asset://helper.js',
      },
      props: {},
    })

    const appDir = path.join(rootDir, 'apps', 'EntryApp')
    const entryPath = path.join(appDir, 'scripts', 'generated.js')
    assert.equal(await fileExists(entryPath), true)

    const configPath = path.join(appDir, 'EntryApp.json')
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'))
    assert.equal(config.scriptEntry, 'scripts/generated.js')

    const uploadInfo = await server._uploadScriptForApp('EntryApp', null, { upload: false })
    assert.equal(uploadInfo.scriptEntry, 'scripts/generated.js')
    assert.equal(uploadInfo.scriptFiles[uploadInfo.scriptEntry], uploadInfo.scriptUrl)
  } finally {
    await stopAppServer(server)
    await assetServer.close()
  }
})
