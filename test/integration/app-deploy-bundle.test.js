import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { test } from 'node:test'
import { DirectAppServer } from '../../app-server/direct.js'
import { createTempDir } from './helpers.js'

async function writeFile(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, contents)
}

test('deploy pipeline uses built app bundle output', async () => {
  const rootDir = await createTempDir('hyperfy-bundle-deploy-')

  await writeFile(
    path.join(rootDir, 'apps', 'BundleApp', 'index.js'),
    "import value from './value.js';\nconsole.log(value);\n"
  )
  await writeFile(
    path.join(rootDir, 'apps', 'BundleApp', 'value.js'),
    "export default 'bundle-value';\n"
  )

  const server = new DirectAppServer({ worldUrl: 'http://example.com', rootDir })
  const info = await server._uploadScriptForApp('BundleApp', null, { upload: false })

  assert.ok(info.scriptPath.endsWith(path.join('dist', 'apps', 'BundleApp.js')))
  assert.match(info.scriptText, /bundle-value/)
})

test('deploy pipeline uploads module scripts when scriptFormat is set', async () => {
  const rootDir = await createTempDir('hyperfy-module-deploy-')
  const appDir = path.join(rootDir, 'apps', 'ModuleApp')

  await writeFile(
    path.join(appDir, 'index.js'),
    "import value from './lib/value.js';\nconsole.log(value);\n"
  )
  await writeFile(path.join(appDir, 'lib', 'value.js'), "export default 'module-value';\n")
  await writeFile(
    path.join(appDir, 'ModuleApp.json'),
    JSON.stringify({ scriptFormat: 'legacy-body' }, null, 2)
  )

  const server = new DirectAppServer({ worldUrl: 'http://example.com', rootDir })
  const info = await server._uploadScriptForApp('ModuleApp', null, { upload: false })

  assert.equal(info.mode, 'module')
  assert.equal(info.scriptEntry, 'index.js')
  assert.equal(info.scriptFiles[info.scriptEntry], info.scriptUrl)
  assert.ok(info.scriptFiles['lib/value.js'])
})
