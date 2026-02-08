import 'ses'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { World } from '../../src/core/World.js'
import { ServerAppLogs } from '../../src/core/systems/ServerAppLogs.js'

test('server app log buffer captures script console output per app', () => {
  const world = new World()
  world.register('serverAppLogs', ServerAppLogs)

  world.scripts.withAppContext('app-alpha', () => {
    const scriptConsole = world.scripts.endowments.console
    scriptConsole.log('alpha', 1)
    scriptConsole.warn('beta')
    scriptConsole.error('gamma')
    scriptConsole.time('load')
    scriptConsole.timeEnd('load')
  })

  const logs = world.serverAppLogs.getRecent('app-alpha')
  assert.equal(logs.length, 5)
  assert.deepEqual(
    logs.map(entry => entry.level),
    ['log', 'warn', 'error', 'time', 'timeEnd']
  )
  assert.equal(logs[0].args[0], 'alpha')
  assert.equal(logs[0].args[1], '1')
  assert.equal(typeof logs[0].message, 'string')
  assert.ok(logs[0].timestamp.includes('T'))
  assert.equal(logs[3].label, 'load')
  assert.equal(logs[4].label, 'load')
  assert.ok(Number.isFinite(logs[4].durationMs))
})

test('server app log buffer keeps only the latest 20 entries per app', () => {
  const world = new World()
  world.register('serverAppLogs', ServerAppLogs)

  for (let i = 0; i < 25; i++) {
    world.scripts.withAppContext('app-trim', () => {
      world.scripts.endowments.console.log('line', i)
    })
  }
  world.scripts.withAppContext('app-other', () => {
    world.scripts.endowments.console.log('other')
  })

  const logs = world.serverAppLogs.getRecent('app-trim')
  assert.equal(logs.length, 20)
  assert.equal(logs[0].args[0], 'line')
  assert.equal(logs[0].args[1], '5')
  assert.equal(logs[19].args[1], '24')

  const limited = world.serverAppLogs.getRecent('app-trim', 3)
  assert.equal(limited.length, 3)
  assert.equal(limited[0].args[1], '22')

  const otherLogs = world.serverAppLogs.getRecent('app-other')
  assert.equal(otherLogs.length, 1)
  assert.equal(otherLogs[0].args[0], 'other')
})
