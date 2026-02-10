import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeModManifest, validateModManifest } from '../../src/core/mods/manifest.js'
import { resolveModOrder } from '../../src/core/mods/order.js'

function createBaseManifest() {
  return {
    version: 1,
    modules: [
      {
        id: 'core.server.echo',
        kind: 'system',
        scope: 'server',
        serverUrl: 'asset://server.js',
      },
      {
        id: 'core.client.echo',
        kind: 'system',
        scope: 'client',
        clientUrl: 'asset://client.js',
      },
      {
        id: 'client.components.panel',
        kind: 'component',
        clientUrl: 'asset://panel.js',
      },
    ],
    loadOrder: ['core.server.echo', 'core.client.echo'],
  }
}

test('mods manifest normalizes and validates', () => {
  const normalized = normalizeModManifest(createBaseManifest())
  assert.equal(normalized.version, 1)
  assert.equal(normalized.modules.length, 3)
  assert.equal(normalized.loadOrder.order.length, 2)
  assert.deepEqual(
    normalized.modules.map(module => module.id),
    ['client.components.panel', 'core.client.echo', 'core.server.echo']
  )
})

test('mods manifest rejects duplicate module ids', () => {
  const manifest = createBaseManifest()
  manifest.modules.push({
    id: 'core.server.echo',
    kind: 'system',
    scope: 'server',
    serverUrl: 'asset://dupe.js',
  })
  const result = validateModManifest(manifest)
  assert.equal(result.ok, false)
  assert.match(result.error, /duplicate_mod_id/)
})

test('mods manifest rejects unknown load-order ids', () => {
  const manifest = createBaseManifest()
  manifest.loadOrder = ['core.server.echo', 'missing.mod']
  const result = validateModManifest(manifest)
  assert.equal(result.ok, false)
  assert.match(result.error, /unknown_order_id/)
})

test('resolveModOrder rejects cyclic relations', () => {
  assert.throws(
    () =>
      resolveModOrder(['a', 'b', 'c'], {
        after: {
          a: ['b'],
          b: ['a'],
        },
      }),
    /cyclic_order/
  )
})

test('resolveModOrder can enforce complete order entries', () => {
  assert.throws(() => resolveModOrder(['a', 'b'], ['a'], { requireComplete: true }), /missing_order_entries:b/)
})
