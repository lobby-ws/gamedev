import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveRelativeModuleSpecifier } from '../../src/core/moduleSpecifiers.js'

test('resolveRelativeModuleSpecifier normalizes relative paths', () => {
  const referrer = 'app://demo@3/src/index.js'
  const resolved = resolveRelativeModuleSpecifier('./utils/math.js', referrer)
  assert.equal(resolved, 'app://demo@3/src/utils/math.js')
})

test('resolveRelativeModuleSpecifier rejects traversal', () => {
  const referrer = 'app://demo@3/src/index.js'
  const resolved = resolveRelativeModuleSpecifier('../../escape.js', referrer)
  assert.equal(resolved, null)
})
