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
