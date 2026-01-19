import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { test } from 'node:test'
import { buildApp } from '../../app-server/appBundler.js'
import { createTempDir } from './helpers.js'

async function writeFile(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, contents)
}

test('app bundler allows json/text and node_modules imports', async () => {
  const rootDir = await createTempDir('hyperfy-bundler-')

  await writeFile(
    path.join(rootDir, 'apps', 'Alpha', 'index.js'),
    "import data from './data.json';\nimport note from './note.txt';\nimport dep from 'test-dep';\nconsole.log(data, note, dep);\n"
  )
  await writeFile(path.join(rootDir, 'apps', 'Alpha', 'data.json'), '{"ok":true}')
  await writeFile(path.join(rootDir, 'apps', 'Alpha', 'note.txt'), 'hello')
  await writeFile(
    path.join(rootDir, 'node_modules', 'test-dep', 'package.json'),
    '{"name":"test-dep","version":"1.0.0","main":"index.js"}'
  )
  await writeFile(
    path.join(rootDir, 'node_modules', 'test-dep', 'index.js'),
    "export default 'ok';"
  )

  const result = await buildApp({ rootDir, appName: 'Alpha' })
  assert.equal(result.errors?.length ?? 0, 0)

  const outfile = path.join(rootDir, 'dist', 'apps', 'Alpha.js')
  const output = await fs.readFile(outfile, 'utf8')
  assert.ok(output.length > 0)
})

test('app bundler blocks node builtin imports', async () => {
  const rootDir = await createTempDir('hyperfy-bundler-')
  await writeFile(
    path.join(rootDir, 'apps', 'BuiltinFail', 'index.js'),
    "import fs from 'fs';\nconsole.log(fs);\n"
  )

  const result = await buildApp({ rootDir, appName: 'BuiltinFail' })
  assert.ok(result.errors?.length)
  assert.match(result.errors[0].text, /Disallowed node builtin import "fs"/)
})

test('app bundler blocks cross-app imports', async () => {
  const rootDir = await createTempDir('hyperfy-bundler-')
  await writeFile(
    path.join(rootDir, 'apps', 'AppA', 'index.js'),
    "import value from '../AppB/util.js';\nconsole.log(value);\n"
  )
  await writeFile(path.join(rootDir, 'apps', 'AppB', 'util.js'), 'export default 1;')

  const result = await buildApp({ rootDir, appName: 'AppA' })
  assert.ok(result.errors?.length)
  assert.match(result.errors[0].text, /cross-app import/)
})
