import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ClientBuilder } from '../../src/core/systems/ClientBuilder.js'
import { ServerAIScripts } from '../../src/core/systems/ServerAIScripts.js'

function createBlueprintStore(blueprints) {
  const items = Array.isArray(blueprints) ? blueprints.map(bp => ({ ...bp })) : []
  const byId = new Map(items.map(bp => [bp.id, bp]))
  return {
    items,
    get(id) {
      return byId.get(id) || null
    },
    add(blueprint) {
      byId.set(blueprint.id, blueprint)
      items.push(blueprint)
    },
    remove(id) {
      byId.delete(id)
      const idx = items.findIndex(item => item.id === id)
      if (idx !== -1) items.splice(idx, 1)
    },
    set(id, value) {
      byId.set(id, value)
      const idx = items.findIndex(item => item.id === id)
      if (idx === -1) {
        items.push(value)
      } else {
        items[idx] = value
      }
    },
    size() {
      return byId.size
    },
  }
}

test('ClientBuilder fork increments numeric suffix without nesting', async () => {
  const store = createBlueprintStore([
    {
      id: 'skyscraper',
      name: 'skyscraper',
      version: 0,
      scope: 'global',
      script: 'asset://root.js',
      scriptEntry: 'index.js',
      scriptFiles: { 'index.js': 'asset://root.js' },
      scriptFormat: 'module',
      props: {},
    },
    {
      id: 'skyscraper_2',
      name: 'skyscraper_2',
      version: 0,
      scope: 'global',
      script: 'asset://root.js',
      scriptEntry: 'index.js',
      scriptFiles: { 'index.js': 'asset://root.js' },
      scriptFormat: 'module',
      props: {},
    },
  ])
  const world = {
    blueprints: store,
    network: { id: 'client-test' },
    admin: {
      deployLockToken: 'lock-token',
      deployLockScope: 'global',
      blueprintAdd: async () => {},
      acquireDeployLock: async () => ({ token: 'lock-token' }),
      releaseDeployLock: async () => {},
    },
  }
  const builder = {
    world,
    ensureAdminReady: () => true,
    handleAdminError: err => {
      throw err
    },
  }

  const source = store.get('skyscraper_2')
  const forked = await ClientBuilder.prototype.forkTemplateFromBlueprint.call(builder, source, 'Template fork')

  assert.ok(forked)
  assert.equal(forked.id, 'skyscraper_3')
  assert.equal(forked.name, 'skyscraper_3')
})

test('ServerAIScripts fork increments numeric suffix without nesting', async () => {
  const store = createBlueprintStore([
    {
      id: 'skyscraper',
      name: 'skyscraper',
      version: 0,
      scope: 'global',
      script: 'asset://root.js',
      scriptEntry: 'index.js',
      scriptFiles: { 'index.js': 'asset://root.js' },
      scriptFormat: 'module',
      props: {},
    },
    {
      id: 'skyscraper_2',
      name: 'skyscraper_2',
      version: 0,
      scope: 'global',
      script: 'asset://root.js',
      scriptEntry: 'index.js',
      scriptFiles: { 'index.js': 'asset://root.js' },
      scriptFormat: 'module',
      props: {},
    },
  ])
  const world = {
    blueprints: store,
    network: {
      applyBlueprintAdded(blueprint) {
        store.add(blueprint)
        return { ok: true }
      },
      applyBlueprintRemoved(change) {
        store.remove(change.id)
        return { ok: true }
      },
      applyEntityModified() {
        return { ok: true }
      },
    },
  }
  const system = new ServerAIScripts(world)
  const source = store.get('skyscraper_2')
  const result = await system.applyForkedScriptUpdate({
    sourceBlueprint: source,
    scriptRoot: source,
    scriptUpdate: {
      script: 'asset://forked.js',
      scriptEntry: 'index.js',
      scriptFiles: { 'index.js': 'asset://forked.js' },
      scriptFormat: 'module',
    },
    appEntity: { data: { id: 'app-1' } },
    actor: 'test',
    source: 'test',
  })

  assert.equal(result.scriptRootId, 'skyscraper_3')
  const forked = store.get('skyscraper_3')
  assert.ok(forked)
  assert.equal(forked.name, 'skyscraper_3')
  assert.equal(store.size(), 3)
})
