import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import { test } from 'node:test'
import { exportApp, importApp } from '../../src/core/extras/appTools.js'
import { hashFile } from '../../src/core/utils-client.js'

if (!globalThis.File) {
  globalThis.File = File
}

async function readHypHeader(file) {
  const buffer = await file.arrayBuffer()
  const view = new DataView(buffer)
  const headerSize = view.getUint32(0, true)
  const bytes = new Uint8Array(buffer.slice(4, 4 + headerSize))
  return JSON.parse(new TextDecoder().decode(bytes))
}

test('exportApp/importApp round-trips .hyp bundles', async () => {
  const files = new Map()
  const addFile = (url, contents, name, type) => {
    const file = new File([contents], name, { type })
    files.set(url, file)
    return file
  }

  const modelUrl = 'asset://model.glb'
  const scriptUrl = 'asset://script.js'
  const helperUrl = 'asset://helpers.js'
  const iconUrl = 'asset://icon.png'
  const skyUrl = 'asset://sky.hdr'
  const previewUrl = 'asset://preview.webp'
  const soundUrl = 'asset://sound.mp3'

  addFile(modelUrl, new Uint8Array([1, 2, 3, 4]), 'model.glb', 'model/gltf-binary')
  addFile(scriptUrl, 'console.log("ok")', 'script.js', 'application/javascript')
  addFile(helperUrl, 'export const add = (a, b) => a + b', 'helpers.js', 'application/javascript')
  addFile(iconUrl, new Uint8Array([5, 6, 7]), 'icon.png', 'image/png')
  addFile(skyUrl, new Uint8Array([8, 9]), 'sky.hdr', 'application/octet-stream')
  addFile(previewUrl, new Uint8Array([10, 11, 12]), 'preview.webp', 'image/webp')
  addFile(soundUrl, new Uint8Array([13, 14, 15, 16]), 'sound.mp3', 'audio/mpeg')

  const scriptRoot = {
    id: 'bp1__script',
    scriptEntry: 'index.js',
    scriptFormat: 'module',
    scriptFiles: {
      'index.js': scriptUrl,
      'helpers/math.js': helperUrl,
    },
  }

  const blueprint = {
    id: 'bp1',
    version: 2,
    name: 'Hyp Test',
    image: { url: iconUrl },
    author: 'Tester',
    url: 'https://example.com',
    desc: 'Round-trip test',
    model: modelUrl,
    script: scriptUrl,
    scriptRef: scriptRoot.id,
    props: {
      sky: { url: skyUrl, intensity: 1 },
      preview: { url: previewUrl },
      sound: { type: 'audio', url: soundUrl },
      count: 3,
    },
    preload: true,
    public: false,
    locked: false,
    frozen: false,
    unique: false,
    scene: false,
    disabled: false,
  }

  const resolveFile = url => {
    const file = files.get(url)
    if (!file) throw new Error(`missing file: ${url}`)
    return file
  }

  const hypFile = await exportApp(blueprint, resolveFile, id => (id === scriptRoot.id ? scriptRoot : null))
  const header = await readHypHeader(hypFile)

  assert.equal(header.blueprint.name, blueprint.name)
  assert.equal(header.blueprint.author, blueprint.author)
  assert.equal(header.blueprint.model, blueprint.model)
  assert.equal(header.blueprint.script, blueprint.script)
  assert.equal(header.blueprint.scriptRef, undefined)
  assert.equal(header.blueprint.scriptEntry, scriptRoot.scriptEntry)
  assert.equal(header.blueprint.scriptFormat, scriptRoot.scriptFormat)
  assert.deepEqual(
    Object.keys(header.blueprint.scriptFiles).sort(),
    Object.keys(scriptRoot.scriptFiles).sort()
  )
  assert.equal(header.blueprint.scriptFiles['index.js'], scriptUrl)
  assert.equal(header.blueprint.scriptFiles['helpers/math.js'], helperUrl)

  const hdrAsset = header.assets.find(asset => asset.url === skyUrl)
  assert.equal(hdrAsset.type, 'hdr')
  const previewAsset = header.assets.find(asset => asset.url === previewUrl)
  assert.equal(previewAsset.type, 'texture')

  const imported = await importApp(hypFile)

  const expectedUrls = new Map()
  for (const [url, file] of files) {
    const hash = await hashFile(file)
    const ext = url.split('.').pop()
    expectedUrls.set(url, `asset://${hash}.${ext}`)
  }

  assert.equal(imported.blueprint.name, blueprint.name)
  assert.equal(imported.blueprint.model, expectedUrls.get(modelUrl))
  assert.equal(imported.blueprint.script, expectedUrls.get(scriptUrl))
  assert.equal(imported.blueprint.image.url, expectedUrls.get(iconUrl))
  assert.equal(imported.blueprint.scriptRef, undefined)
  assert.equal(imported.blueprint.scriptEntry, scriptRoot.scriptEntry)
  assert.equal(imported.blueprint.scriptFormat, scriptRoot.scriptFormat)
  assert.deepEqual(Object.keys(imported.blueprint.scriptFiles).sort(), Object.keys(scriptRoot.scriptFiles).sort())
  assert.equal(imported.blueprint.scriptFiles['index.js'], expectedUrls.get(scriptUrl))
  assert.equal(imported.blueprint.scriptFiles['helpers/math.js'], expectedUrls.get(helperUrl))
  assert.equal(imported.blueprint.props.sky.url, expectedUrls.get(skyUrl))
  assert.equal(imported.blueprint.props.sky.intensity, 1)
  assert.equal(imported.blueprint.props.preview.url, expectedUrls.get(previewUrl))
  assert.equal(imported.blueprint.props.sound.url, expectedUrls.get(soundUrl))
  assert.equal(imported.blueprint.props.count, 3)

  const expectedSizes = new Map()
  for (const [url, file] of files) {
    expectedSizes.set(expectedUrls.get(url), file.size)
  }

  for (const asset of imported.assets) {
    assert.equal(asset.file.size, expectedSizes.get(asset.url))
  }

  const importedHdr = imported.assets.find(asset => asset.url === expectedUrls.get(skyUrl))
  assert.equal(importedHdr.type, 'hdr')
  const importedPreview = imported.assets.find(asset => asset.url === expectedUrls.get(previewUrl))
  assert.equal(importedPreview.type, 'texture')
})
