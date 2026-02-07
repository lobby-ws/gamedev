import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import { test } from 'node:test'
import { exportApp, importApp } from '../../src/core/extras/appTools.js'
import { ClientBuilder } from '../../src/core/systems/ClientBuilder.js'

if (!globalThis.File) {
  globalThis.File = File
}

test('drag-drop .hyp import preserves scriptFiles on blueprint', async () => {
  const files = new Map()
  const addFile = (url, contents, name, type) => {
    const file = new File([contents], name, { type })
    files.set(url, file)
    return file
  }

  const modelUrl = 'asset://model.glb'
  const scriptUrl = 'asset://index.js'
  const helperUrl = 'asset://lib/helper.js'

  addFile(modelUrl, new Uint8Array([1, 2, 3, 4]), 'model.glb', 'model/gltf-binary')
  addFile(scriptUrl, 'import { helper } from "./lib/helper.js"\nexport default () => helper()', 'index.js', 'text/javascript')
  addFile(helperUrl, 'export const helper = () => "ok"', 'helper.js', 'text/javascript')

  const blueprint = {
    id: 'bp1',
    name: 'ModuleApp',
    model: modelUrl,
    script: scriptUrl,
    scriptEntry: 'index.js',
    scriptFormat: 'module',
    scriptFiles: {
      'index.js': scriptUrl,
      'lib/helper.js': helperUrl,
    },
    props: {},
    preload: false,
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

  const hypFile = await exportApp(blueprint, resolveFile)

  const addedBlueprints = []
  const stubWorld = {
    network: { id: 'test', maxUploadSize: null },
    loader: {
      insert: () => {},
      setFile: () => {},
    },
    blueprints: {
      add: bp => addedBlueprints.push(bp),
      remove: () => {},
    },
    entities: {
      add: data => ({
        data,
        onUploaded: () => {},
        destroy: () => {},
      }),
    },
    admin: {
      acquireDeployLock: async () => ({ token: 'lock' }),
      deployLockToken: 'lock',
      upload: async () => {},
      blueprintAdd: () => {},
      entityAdd: () => {},
      releaseDeployLock: async () => {},
      blueprintRemove: async () => {},
    },
    ui: { confirm: async () => true },
    chat: { add: () => {} },
    emit: () => {},
  }

  await ClientBuilder.prototype.addApp.call({ world: stubWorld }, hypFile, {
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
  })

  assert.equal(addedBlueprints.length, 1)
  const imported = addedBlueprints[0]
  assert.equal(imported.scriptEntry, 'index.js')
  assert.equal(imported.scriptFormat, 'module')
  assert.ok(imported.scriptFiles)
  assert.equal(imported.scriptFiles[imported.scriptEntry], imported.script)
  assert.ok(imported.scriptFiles['lib/helper.js'])
})

test('drag-drop .hyp import converts legacy script into module files', async () => {
  const files = new Map()
  const addFile = (url, contents, name, type) => {
    const file = new File([contents], name, { type })
    files.set(url, file)
    return file
  }

  const modelUrl = 'asset://model.glb'
  const scriptUrl = 'asset://legacy.js'
  addFile(modelUrl, new Uint8Array([1, 2, 3, 4]), 'model.glb', 'model/gltf-binary')
  addFile(scriptUrl, 'app.on("update", () => {})', 'legacy.js', 'text/javascript')

  const blueprint = {
    id: 'bp-legacy',
    name: 'LegacyApp',
    model: modelUrl,
    script: scriptUrl,
    props: {},
    preload: false,
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

  const hypFile = await exportApp(blueprint, resolveFile)
  const imported = await importApp(hypFile)

  assert.equal(imported.blueprint.scriptFormat, 'module')
  assert.ok(imported.blueprint.scriptEntry)
  assert.ok(imported.blueprint.scriptFiles)
  assert.equal(imported.blueprint.scriptFiles[imported.blueprint.scriptEntry], imported.blueprint.script)

  const scriptAsset = imported.assets.find(asset => asset.url === imported.blueprint.script)
  assert.ok(scriptAsset?.file)
  const scriptText = await scriptAsset.file.text()
  assert.match(scriptText, /export default/)
})

test('drag-drop .glb creates app with blank module script files', async () => {
  const addedBlueprints = []
  const insertedAssets = []
  const uploadedFiles = []

  const stubWorld = {
    network: { id: 'test', maxUploadSize: null },
    loader: {
      insert: (type, url, file) => insertedAssets.push({ type, url, file }),
    },
    blueprints: {
      add: blueprint => addedBlueprints.push(blueprint),
      remove: () => {},
    },
    entities: {
      add: data => ({
        data,
        onUploaded: () => {},
        destroy: () => {},
      }),
    },
    admin: {
      acquireDeployLock: async () => ({ token: 'lock' }),
      deployLockToken: 'lock',
      upload: async file => uploadedFiles.push(file),
      blueprintAdd: async () => {},
      entityAdd: async () => {},
      releaseDeployLock: async () => {},
      blueprintRemove: async () => {},
    },
    emit: () => {},
  }

  const builder = {
    world: stubWorld,
    ensureAdminReady: () => true,
    handleAdminError: err => {
      throw err
    },
  }

  const modelFile = new File([new Uint8Array([1, 2, 3, 4])], 'MyModel.glb', { type: 'model/gltf-binary' })

  await ClientBuilder.prototype.addModel.call(builder, modelFile, {
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
  })

  assert.equal(addedBlueprints.length, 1)
  const blueprint = addedBlueprints[0]
  assert.equal(blueprint.name, 'MyModel')
  assert.equal(blueprint.scope, blueprint.id)
  assert.equal(blueprint.scriptEntry, 'index.js')
  assert.equal(blueprint.scriptFormat, 'module')
  assert.equal(typeof blueprint.script, 'string')
  assert.deepEqual(Object.keys(blueprint.scriptFiles), ['index.js'])
  assert.equal(blueprint.scriptFiles['index.js'], blueprint.script)

  const insertedScript = insertedAssets.find(asset => asset.type === 'script' && asset.url === blueprint.script)
  assert.ok(insertedScript?.file)
  const insertedScriptText = await insertedScript.file.text()
  assert.match(insertedScriptText, /export default/)

  assert.equal(uploadedFiles.length, 2)
})

test('drag-drop .hyp import rewrites single hashed entry path to index.js', async () => {
  const files = new Map()
  const addFile = (url, contents, name, type) => {
    const file = new File([contents], name, { type })
    files.set(url, file)
    return file
  }

  const hashedEntry = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.js'
  const modelUrl = 'asset://model.glb'
  const scriptUrl = 'asset://entry.js'
  addFile(modelUrl, new Uint8Array([1, 2, 3, 4]), 'model.glb', 'model/gltf-binary')
  addFile(scriptUrl, 'export default () => "ok"', 'entry.js', 'text/javascript')

  const blueprint = {
    id: 'bp-hashed',
    name: 'HashedEntryApp',
    model: modelUrl,
    script: scriptUrl,
    scriptEntry: hashedEntry,
    scriptFormat: 'module',
    scriptFiles: {
      [hashedEntry]: scriptUrl,
    },
    props: {},
    preload: false,
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

  const hypFile = await exportApp(blueprint, resolveFile)
  const imported = await importApp(hypFile)

  assert.equal(imported.blueprint.scriptEntry, 'index.js')
  assert.deepEqual(Object.keys(imported.blueprint.scriptFiles), ['index.js'])
  assert.equal(imported.blueprint.scriptFiles['index.js'], imported.blueprint.script)
})
