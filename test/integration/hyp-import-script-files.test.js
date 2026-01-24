import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import { test } from 'node:test'
import { exportApp } from '../../src/core/extras/appTools.js'
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
