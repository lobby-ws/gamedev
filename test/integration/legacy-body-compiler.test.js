import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compileLegacyBodyModuleSource } from '../../src/core/systems/Scripts.js'

test('legacy-body compilation preserves imports and wraps body', () => {
  const code = ["import { add } from './math.js'", 'const total = add(1, 2)', 'world.total = total'].join('\n')
  const moduleSource = compileLegacyBodyModuleSource(code, 'app://demo@1/index.js')
  assert.ok(moduleSource.imports.includes('./math.js'))
  assert.ok(moduleSource.exports.includes('default'))
})

test('legacy-body compilation rejects exports in entry body', () => {
  assert.throws(
    () => compileLegacyBodyModuleSource('export default () => {}', 'app://demo@1/index.js'),
    /legacy_body_exports_not_allowed/
  )
})
