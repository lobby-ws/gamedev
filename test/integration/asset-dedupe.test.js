import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'fs/promises'
import http from 'node:http'
import path from 'path'
import { test } from 'node:test'
import { DirectAppServer } from '../../app-server/direct.js'
import { createTempDir, stopAppServer } from './helpers.js'

async function readJson(filePath) {
  const content = await fs.readFile(filePath, 'utf8')
  return JSON.parse(content)
}

async function listAssetFiles(rootDir) {
  const assetsDir = path.join(rootDir, 'assets')
  try {
    const files = await fs.readdir(assetsDir)
    return files.sort()
  } catch {
    return []
  }
}

async function startAssetServer(assets) {
  let requestCount = 0
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
      requestCount += 1
      const body = assets[filename]
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/octet-stream')
      res.end(body)
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        url: `http://127.0.0.1:${address.port}/assets`,
        getRequestCount: () => requestCount,
        close: () => new Promise(closeResolve => server.close(closeResolve)),
      })
    })
  })
}

function hashFilename(buffer, ext) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex')
  return `${hash}.${ext}`
}

test('remote blueprint sync reuses one local readable file for duplicate hashed assets', async () => {
  const rootDir = await createTempDir('hyperfy-asset-dedupe-blueprint-')
  const modelBytes = Buffer.from('shared-model-bytes')
  const filename = hashFilename(modelBytes, 'glb')
  const assetServer = await startAssetServer({
    [filename]: modelBytes,
  })
  const server = new DirectAppServer({ worldUrl: 'http://example.com', rootDir })
  server.assetsUrl = assetServer.url
  server._initSnapshot({
    worldId: 'test',
    assetsUrl: assetServer.url,
    settings: {},
    spawn: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
    entities: [],
    blueprints: [],
  })

  try {
    await server._onRemoteBlueprint({
      id: 'AppA',
      name: 'AppA',
      model: `asset://${filename}`,
      props: {},
    })
    await server._onRemoteBlueprint({
      id: 'AppB',
      name: 'AppB',
      model: `asset://${filename}`,
      props: {},
    })

    const appA = await readJson(path.join(rootDir, 'apps', 'AppA', 'AppA.json'))
    const appB = await readJson(path.join(rootDir, 'apps', 'AppB', 'AppB.json'))
    const files = await listAssetFiles(rootDir)

    assert.deepEqual(files, ['AppA.glb'])
    assert.equal(appA.model, 'assets/AppA.glb')
    assert.equal(appB.model, 'assets/AppA.glb')
    assert.equal(assetServer.getRequestCount(), 1)
  } finally {
    await stopAppServer(server)
    await assetServer.close()
  }
})

test('entity prop localization dedupes by hash and reuses first readable filename', async () => {
  const rootDir = await createTempDir('hyperfy-asset-dedupe-entities-')
  const imageBytes = Buffer.from('shared-image-bytes')
  const filename = hashFilename(imageBytes, 'png')
  const assetServer = await startAssetServer({
    [filename]: imageBytes,
  })
  const server = new DirectAppServer({ worldUrl: 'http://example.com', rootDir })
  server.assetsUrl = assetServer.url

  try {
    const localized = await server._localizeEntityProps([
      {
        id: 'entity-a',
        blueprint: 'BlueprintA',
        props: {
          icon: {
            name: 'Readable Icon',
            url: `asset://${filename}`,
          },
        },
      },
      {
        id: 'entity-b',
        blueprint: 'BlueprintB',
        props: {
          icon: {
            name: 'Another Name',
            url: `asset://${filename}`,
          },
        },
      },
    ])

    const files = await listAssetFiles(rootDir)
    const firstUrl = localized[0]?.props?.icon?.url
    const secondUrl = localized[1]?.props?.icon?.url

    assert.deepEqual(files, ['Readable Icon.png'])
    assert.equal(firstUrl, 'assets/Readable Icon.png')
    assert.equal(secondUrl, 'assets/Readable Icon.png')
    assert.equal(assetServer.getRequestCount(), 1)
  } finally {
    await stopAppServer(server)
    await assetServer.close()
  }
})

test('remote blueprint sync names hashed model assets from blueprint name', async () => {
  const rootDir = await createTempDir('hyperfy-asset-model-name-')
  const modelBytes = Buffer.from('avatar-bytes')
  const filename = hashFilename(modelBytes, 'vrm')
  const assetServer = await startAssetServer({
    [filename]: modelBytes,
  })
  const server = new DirectAppServer({ worldUrl: 'http://example.com', rootDir })
  server.assetsUrl = assetServer.url
  server._initSnapshot({
    worldId: 'test',
    assetsUrl: assetServer.url,
    settings: {},
    spawn: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
    entities: [],
    blueprints: [],
  })

  try {
    await server._onRemoteBlueprint({
      id: '2a7fcc4b-b90e-4bd6-a1a8-7b72f1388ded',
      name: 'Dropped Hyp',
      model: `asset://${filename}`,
      props: {},
    })

    const appConfig = await readJson(
      path.join(rootDir, 'apps', '2a7fcc4b-b90e-4bd6-a1a8-7b72f1388ded', '2a7fcc4b-b90e-4bd6-a1a8-7b72f1388ded.json')
    )
    const files = await listAssetFiles(rootDir)

    assert.deepEqual(files, ['Dropped Hyp.vrm'])
    assert.equal(appConfig.model, 'assets/Dropped Hyp.vrm')
    assert.equal(assetServer.getRequestCount(), 1)
  } finally {
    await stopAppServer(server)
    await assetServer.close()
  }
})

test('remote blueprint sync does not duplicate extension for model names', async () => {
  const rootDir = await createTempDir('hyperfy-asset-model-ext-')
  const modelBytes = Buffer.from('avatar-bytes-ext')
  const filename = hashFilename(modelBytes, 'vrm')
  const assetServer = await startAssetServer({
    [filename]: modelBytes,
  })
  const server = new DirectAppServer({ worldUrl: 'http://example.com', rootDir })
  server.assetsUrl = assetServer.url
  server._initSnapshot({
    worldId: 'test',
    assetsUrl: assetServer.url,
    settings: {},
    spawn: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
    entities: [],
    blueprints: [],
  })

  try {
    await server._onRemoteBlueprint({
      id: 'ModelExtApp',
      name: 'model.vrm',
      model: `asset://${filename}`,
      props: {},
    })

    const appConfig = await readJson(path.join(rootDir, 'apps', 'ModelExtApp', 'ModelExtApp.json'))
    const files = await listAssetFiles(rootDir)

    assert.deepEqual(files, ['model.vrm'])
    assert.equal(appConfig.model, 'assets/model.vrm')
    assert.equal(assetServer.getRequestCount(), 1)
  } finally {
    await stopAppServer(server)
    await assetServer.close()
  }
})

test('remote blueprint sync does not duplicate extension for file prop names', async () => {
  const rootDir = await createTempDir('hyperfy-asset-prop-ext-')
  const vrmBytes = Buffer.from('vrm-prop-bytes')
  const filename = hashFilename(vrmBytes, 'vrm')
  const assetServer = await startAssetServer({
    [filename]: vrmBytes,
  })
  const server = new DirectAppServer({ worldUrl: 'http://example.com', rootDir })
  server.assetsUrl = assetServer.url
  server._initSnapshot({
    worldId: 'test',
    assetsUrl: assetServer.url,
    settings: {},
    spawn: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
    entities: [],
    blueprints: [],
  })

  try {
    await server._onRemoteBlueprint({
      id: 'FilePropApp',
      name: 'FilePropApp',
      props: {
        avatar: {
          type: 'avatar',
          name: 'file.vrm',
          url: `asset://${filename}`,
        },
      },
    })

    const appConfig = await readJson(path.join(rootDir, 'apps', 'FilePropApp', 'FilePropApp.json'))
    const files = await listAssetFiles(rootDir)

    assert.deepEqual(files, ['file.vrm'])
    assert.equal(appConfig.props.avatar.url, 'assets/file.vrm')
    assert.equal(assetServer.getRequestCount(), 1)
  } finally {
    await stopAppServer(server)
    await assetServer.close()
  }
})
