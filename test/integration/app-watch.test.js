import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { test } from 'node:test'
import { DirectAppServer } from '../../app-server/direct.js'
import { createTempDir, stopAppServer, waitFor } from './helpers.js'

async function writeFile(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, contents)
}

test('app watch schedules deploy on script changes', async () => {
  const rootDir = await createTempDir('hyperfy-app-watch-')
  const appDir = path.join(rootDir, 'apps', 'WatchApp')

  await writeFile(path.join(appDir, 'index.js'), "app.on('update', () => {});\n")
  await writeFile(path.join(appDir, 'lib', 'value.js'), "export default 'one';\n")

  const server = new DirectAppServer({ worldUrl: 'http://example.com', rootDir })
  const scheduled = []
  server._scheduleDeployApp = appName => {
    scheduled.push(appName)
  }

  try {
    server._watchAppDir('WatchApp')

    await writeFile(path.join(appDir, 'lib', 'value.js'), "export default 'two';\n")
    await waitFor(() => scheduled.length > 0, { timeoutMs: 10000 })
    assert.equal(scheduled[0], 'WatchApp')
  } finally {
    await stopAppServer(server)
  }
})

test('app watch schedules deploy when entry file extension changes', async () => {
  const rootDir = await createTempDir('hyperfy-app-watch-rename-')
  const appDir = path.join(rootDir, 'apps', 'RenameApp')

  await writeFile(path.join(appDir, 'index.js'), "export default () => {};\n")

  const server = new DirectAppServer({ worldUrl: 'http://example.com', rootDir })
  const scheduled = []
  server._scheduleDeployApp = appName => {
    scheduled.push(appName)
  }

  try {
    server._watchAppDir('RenameApp')

    await fs.rename(path.join(appDir, 'index.js'), path.join(appDir, 'index.ts'))
    await waitFor(() => scheduled.length > 0, { timeoutMs: 10000 })
    assert.equal(scheduled[0], 'RenameApp')
  } finally {
    await stopAppServer(server)
  }
})
