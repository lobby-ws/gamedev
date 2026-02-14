import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ServerAIScripts } from '../../src/core/systems/ServerAIScripts.js'

function createBlueprintStore(blueprints) {
  const items = Array.isArray(blueprints) ? blueprints.map(bp => ({ ...bp })) : []
  const byId = new Map(items.map(bp => [bp.id, bp]))
  return {
    items,
    get(id) {
      return byId.get(id) || null
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

function createWorld(blueprints, onModify) {
  const store = createBlueprintStore(blueprints)
  const world = {
    blueprints: store,
    network: {
      applyBlueprintModified(change) {
        const current = store.get(change.id)
        if (!current) return { ok: false }
        const next = { ...current, ...change }
        store.set(change.id, next)
        if (typeof onModify === 'function') onModify(change)
        return { ok: true, current: next }
      },
    },
  }
  return { world, store }
}

test('ServerAIScripts resolveForkPlan detaches scriptRef targets in place', () => {
  const root = {
    id: 'skyscraper',
    name: 'skyscraper',
    script: 'asset://root.js',
    scriptEntry: 'index.js',
    scriptFiles: { 'index.js': 'asset://root.js' },
    scriptFormat: 'module',
  }
  const variant = {
    id: 'skyscraper_2',
    name: 'skyscraper_2',
    script: 'asset://root.js',
    scriptRef: 'skyscraper',
  }
  const { world } = createWorld([root, variant])
  const system = new ServerAIScripts(world)
  const app = { isApp: true, data: { id: 'app-1', blueprint: variant.id } }

  const plan = system.resolveForkPlan({
    scriptRoot: root,
    targetBlueprint: variant,
    app,
  })

  assert.equal(plan.mode, 'detach')
})

test('ServerAIScripts applyScriptUpdateToTargetBlueprint keeps target blueprint id/name', async () => {
  const root = {
    id: 'skyscraper',
    name: 'skyscraper',
    version: 3,
    scope: 'global',
    script: 'asset://root.js',
    scriptEntry: 'index.js',
    scriptFiles: { 'index.js': 'asset://root.js' },
    scriptFormat: 'module',
  }
  const variant = {
    id: 'skyscraper_2',
    name: 'skyscraper_2',
    version: 4,
    scope: 'global',
    script: 'asset://root.js',
    scriptEntry: null,
    scriptFiles: null,
    scriptFormat: null,
    scriptRef: 'skyscraper',
  }
  const modifyCalls = []
  const { world, store } = createWorld([root, variant], change => modifyCalls.push(change))
  const system = new ServerAIScripts(world)
  const scriptUpdate = {
    script: 'asset://variant.js',
    scriptEntry: 'index.js',
    scriptFiles: { 'index.js': 'asset://variant.js' },
    scriptFormat: 'module',
  }

  const appliedId = await system.applyScriptUpdateToTargetBlueprint(variant, root, scriptUpdate, {
    actor: 'ai',
    source: 'test',
  })

  assert.equal(appliedId, 'skyscraper_2')
  assert.equal(modifyCalls.length, 1)
  assert.equal(modifyCalls[0].id, 'skyscraper_2')
  assert.equal(modifyCalls[0].version, 5)
  assert.equal(modifyCalls[0].scriptRef, null)
  assert.equal(store.size(), 2)

  const updatedVariant = store.get('skyscraper_2')
  assert.equal(updatedVariant.id, 'skyscraper_2')
  assert.equal(updatedVariant.name, 'skyscraper_2')
  assert.equal(updatedVariant.scriptRef, null)
  assert.equal(updatedVariant.script, 'asset://variant.js')
  assert.equal(updatedVariant.scriptEntry, 'index.js')
  assert.deepEqual(updatedVariant.scriptFiles, { 'index.js': 'asset://variant.js' })
  assert.equal(updatedVariant.scriptFormat, 'module')
})
