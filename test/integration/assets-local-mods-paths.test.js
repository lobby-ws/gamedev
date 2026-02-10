import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { test } from 'node:test'

import { AssetsLocal } from '../../src/server/AssetsLocal.js'
import { createTempDir } from './helpers.js'

test('AssetsLocal preserves hashed nested filenames for mods assets', async () => {
  const rootDir = await createTempDir('hyperfy-assets-local-root-')
  const worldDir = await createTempDir('hyperfy-assets-local-world-')
  const previousAssetsBaseUrl = process.env.ASSETS_BASE_URL
  process.env.ASSETS_BASE_URL = 'http://localhost:3000/assets'

  try {
    const assets = new AssetsLocal()
    await assets.init({ rootDir, worldDir })

    const source = Buffer.from('export default 1;\n', 'utf8')
    const hash = crypto.createHash('sha256').update(source).digest('hex')
    const filename = `mods/${hash}.js`
    const file = new File([source], filename, { type: 'text/javascript' })

    await assets.upload(file)
    assert.equal(await assets.exists(filename), true)

    const listed = await assets.list()
    assert.equal(listed.has(filename), true)

    await assets.delete(new Set([filename]))
    assert.equal(await assets.exists(filename), false)
  } finally {
    if (previousAssetsBaseUrl === undefined) {
      delete process.env.ASSETS_BASE_URL
    } else {
      process.env.ASSETS_BASE_URL = previousAssetsBaseUrl
    }
  }
})
