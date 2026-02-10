import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { pathToFileURL } from 'url'
import { test } from 'node:test'

import { loadClientUIMods } from '../../src/core/mods/loadClientUIMods.js'
import { createTempDir } from './helpers.js'

async function writeFile(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, contents, 'utf8')
}

function createWorldRecorder() {
  const events = []
  return {
    events,
    modUI: null,
    emit(name, payload) {
      events.push({ name, payload })
    },
  }
}

test('loadClientUIMods loads component and sidebar mods in effective order', async () => {
  const rootDir = await createTempDir('hyperfy-ui-mod-loader-')
  const assetsDir = path.join(rootDir, 'assets')
  await writeFile(path.join(assetsDir, 'panel.js'), 'export default function Panel() { return null }\n')
  await writeFile(
    path.join(assetsDir, 'sidebar.js'),
    'export function ToolsButton() { return null }\nexport function ToolsPane() { return null }\n'
  )
  const assetsUrl = pathToFileURL(assetsDir).href.replace(/\/+$/, '')

  const manifest = {
    version: 1,
    modules: [
      {
        id: 'client.components.panel',
        kind: 'component',
        clientUrl: 'asset://panel.js',
      },
      {
        id: 'client.sidebar.tools',
        kind: 'sidebar',
        clientUrl: 'asset://sidebar.js',
        buttonExport: 'ToolsButton',
        paneExport: 'ToolsPane',
      },
    ],
    loadOrder: ['client.sidebar.tools', 'client.components.panel'],
  }

  const world = createWorldRecorder()
  const loaded = await loadClientUIMods(world, {
    manifest,
    loadOrderOverride: ['client.components.panel', 'client.sidebar.tools'],
    assetsUrl,
  })

  assert.equal(loaded.source, 'override')
  assert.deepEqual(loaded.order, ['client.components.panel', 'client.sidebar.tools'])
  assert.equal(loaded.components.length, 1)
  assert.equal(loaded.sidebar.length, 1)
  assert.equal(typeof loaded.components[0].Component, 'function')
  assert.equal(typeof loaded.sidebar[0].Button, 'function')
  assert.equal(typeof loaded.sidebar[0].Pane, 'function')
  assert.equal(world.modUI.components.length, 1)
  assert.ok(world.events.some(event => event.name === 'mods-ui'))
})
