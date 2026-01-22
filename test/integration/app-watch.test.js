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

test('app watch rebuild schedules deploy and suppresses on errors', async () => {
  const rootDir = await createTempDir('hyperfy-app-watch-')
  const appDir = path.join(rootDir, 'apps', 'WatchApp')

  await writeFile(
    path.join(appDir, 'index.js'),
    "import value from './lib/value.js';\nconsole.log(value);\n"
  )
  await writeFile(path.join(appDir, 'lib', 'value.js'), "export default 'one';\n")

  const server = new DirectAppServer({ worldUrl: 'http://example.com', rootDir })
  const scheduled = []
  server._scheduleDeployApp = appName => {
    scheduled.push(appName)
  }

  try {
    server._watchAppDir('WatchApp', { skipInitialBuild: true })

    await waitFor(async () => {
      try {
        await fs.access(path.join(rootDir, 'dist', 'apps', 'WatchApp.js'))
        return true
      } catch {
        return false
      }
    }, { timeoutMs: 10000 })

    const afterWarmup = scheduled.length

    await writeFile(path.join(appDir, 'lib', 'value.js'), "export default 'two';\n")
    await waitFor(() => scheduled.length > afterWarmup, { timeoutMs: 10000 })

    const afterUpdate = scheduled.length

    await writeFile(
      path.join(appDir, 'index.js'),
      "import missing from './missing.js';\nconsole.log(missing);\n"
    )
    await waitFor(() => server.appWatchers.get('WatchApp')?.hasError === true, { timeoutMs: 10000 })

    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(scheduled.length, afterUpdate)

    await writeFile(
      path.join(appDir, 'index.js'),
      "import value from './lib/value.js';\nconsole.log(value);\n"
    )
    await waitFor(
      () => server.appWatchers.get('WatchApp')?.hasError === false && scheduled.length > afterUpdate,
      { timeoutMs: 10000 }
    )
  } finally {
    await stopAppServer(server)
  }
})

test('app watch restarts when entry file extension changes', async () => {
  const rootDir = await createTempDir('hyperfy-app-watch-rename-')
  const appDir = path.join(rootDir, 'apps', 'RenameApp')

  await writeFile(path.join(appDir, 'index.ts'), "console.log('ts');\n")

  const server = new DirectAppServer({ worldUrl: 'http://example.com', rootDir })
  const scheduled = []
  server._scheduleDeployApp = appName => {
    scheduled.push(appName)
  }

  try {
    server._watchAppDir('RenameApp', { skipInitialBuild: true })

    await waitFor(async () => {
      try {
        await fs.access(path.join(rootDir, 'dist', 'apps', 'RenameApp.js'))
        return true
      } catch {
        return false
      }
    }, { timeoutMs: 10000 })

    const initialCount = scheduled.length

    await fs.rename(path.join(appDir, 'index.ts'), path.join(appDir, 'index.js'))

    await waitFor(() => {
      const entryPath = server.appWatchers.get('RenameApp')?.entryPath
      return entryPath?.endsWith('index.js')
    }, { timeoutMs: 10000 })

    await waitFor(() => scheduled.length > initialCount, { timeoutMs: 10000 })
    assert.equal(scheduled[scheduled.length - 1], 'RenameApp')
  } finally {
    await stopAppServer(server)
  }
})
