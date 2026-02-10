import assert from 'node:assert/strict'
import { test } from 'node:test'

import { AssetsS3 } from '../../src/server/AssetsS3.js'

test('AssetsS3 maps JS module extensions to text/javascript', () => {
  const getContentType = AssetsS3.prototype.getContentType
  assert.equal(getContentType.call({}, 'bundle.js'), 'text/javascript')
  assert.equal(getContentType.call({}, 'bundle.mjs'), 'text/javascript')
  assert.equal(getContentType.call({}, 'bundle.cjs'), 'text/javascript')
})
