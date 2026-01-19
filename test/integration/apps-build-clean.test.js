import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { test } from 'node:test'
import { HyperfyCLI } from '../../app-server/commands.js'
import { createTempDir } from './helpers.js'

async function writeFile(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, contents)
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

test('apps build --all builds bundles and clean removes dist', async () => {
  const rootDir = await createTempDir('hyperfy-apps-build-')
  await writeFile(path.join(rootDir, 'apps', 'AppA', 'index.js'), "console.log('a');\n")
  await writeFile(path.join(rootDir, 'apps', 'AppB', 'index.js'), "console.log('b');\n")

  const cli = new HyperfyCLI({ rootDir })
  const ok = await cli.build(null, { all: true })
  assert.equal(ok, true)

  assert.equal(await fileExists(path.join(rootDir, 'dist', 'apps', 'AppA.js')), true)
  assert.equal(await fileExists(path.join(rootDir, 'dist', 'apps', 'AppB.js')), true)

  const cleaned = await cli.clean()
  assert.equal(cleaned, true)
  assert.equal(await fileExists(path.join(rootDir, 'dist', 'apps', 'AppA.js')), false)
})
