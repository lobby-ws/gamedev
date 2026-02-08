import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ClientAIScripts } from '../../src/core/systems/ClientAIScripts.js'
import { ClientAppLogs, MAX_APP_LOG_ENTRIES } from '../../src/core/systems/ClientAppLogs.js'
import { Scripts } from '../../src/core/systems/Scripts.js'

test('client app logs capture script console output and trim to last 20 entries', async () => {
  const appLogs = new ClientAppLogs({})
  const world = { appLogs }
  const originalCompartment = globalThis.Compartment
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    time: console.time,
    timeEnd: console.timeEnd,
  }

  globalThis.Compartment = class MockCompartment {
    evaluate() {
      throw new Error('not_implemented_for_test')
    }
  }
  console.log = () => {}
  console.warn = () => {}
  console.error = () => {}
  console.time = () => {}
  console.timeEnd = () => {}

  const appId = 'entity-client-logs-1'
  try {
    const scripts = new Scripts(world)
    scripts.withAppContext(appId, () => {
      for (let i = 0; i < 18; i++) scripts.endowments.console.log('line', i)
      scripts.endowments.console.warn('warn-marker')
      scripts.endowments.console.error('error-marker')
      scripts.endowments.console.time('clock-marker')
      scripts.endowments.console.timeEnd('clock-marker')
      for (let i = 18; i < 23; i++) scripts.endowments.console.log('line', i)
    })
  } finally {
    globalThis.Compartment = originalCompartment
    console.log = originalConsole.log
    console.warn = originalConsole.warn
    console.error = originalConsole.error
    console.time = originalConsole.time
    console.timeEnd = originalConsole.timeEnd
  }

  const entries = appLogs.getEntries(appId)

  assert.equal(entries.length, MAX_APP_LOG_ENTRIES)
  assert.equal(entries[0].message, 'line 7')
  assert.equal(entries.at(-1)?.message, 'line 22')
  assert.equal(appLogs.getEntries('missing-app').length, 0)
  assert.equal(appLogs.getEntries(appId, 3).length, 3)

  const lineValues = entries
    .filter(entry => entry.args[0] === 'line')
    .map(entry => Number(entry.args[1]))
  assert.deepEqual(
    lineValues,
    [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]
  )

  assert.ok(entries.some(entry => entry.level === 'warn' && entry.message.includes('warn-marker')))
  assert.ok(entries.some(entry => entry.level === 'error' && entry.message.includes('error-marker')))
  assert.ok(entries.some(entry => entry.level === 'time' && entry.message.includes('clock-marker')))
  assert.ok(entries.some(entry => entry.level === 'timeEnd' && entry.message.includes('clock-marker')))

  for (const entry of entries) {
    assert.equal(typeof entry.timestamp, 'string')
    assert.ok(Number.isFinite(Date.parse(entry.timestamp)))
    assert.ok(Array.isArray(entry.args))
    assert.equal(typeof entry.level, 'string')
    assert.equal(typeof entry.message, 'string')
  }
})

test('client AI fix request includes client app log snapshot', () => {
  const sentPackets = []
  const emittedEvents = []
  const logsSnapshot = [
    {
      timestamp: new Date().toISOString(),
      level: 'error',
      args: ['boom'],
      message: 'boom',
    },
  ]

  const scriptRoot = {
    id: 'ai-root',
    scriptEntry: 'index.js',
    scriptFiles: {
      'index.js': 'asset://index.js',
    },
  }

  const app = {
    data: {
      id: 'app-ai-1',
      blueprint: 'ai-root',
    },
    blueprint: scriptRoot,
    scriptError: { message: 'runtime boom' },
  }

  const world = {
    isAdminClient: false,
    network: {
      send: (name, payload) => {
        sentPackets.push({ name, payload })
      },
    },
    builder: {
      canBuild: () => true,
      getEntityAtReticle: () => null,
    },
    ui: {
      state: {
        app,
      },
    },
    blueprints: {
      get: () => null,
    },
    appLogs: {
      getEntries: appId => {
        if (appId !== app.data.id) return []
        return logsSnapshot
      },
    },
    emit: (name, payload) => {
      emittedEvents.push({ name, payload })
    },
  }

  const aiScripts = new ClientAIScripts(world)
  const fixRequestId = aiScripts.requestFix({ app })

  assert.equal(typeof fixRequestId, 'string')
  assert.equal(sentPackets.length, 1)
  assert.equal(sentPackets[0].name, 'scriptAiRequest')
  assert.equal(sentPackets[0].payload.mode, 'fix')
  assert.equal(sentPackets[0].payload.appId, app.data.id)
  assert.deepEqual(sentPackets[0].payload.clientLogs, logsSnapshot)

  aiScripts.requestEdit({ app, prompt: 'rename variable' })
  assert.equal(sentPackets.length, 2)
  assert.equal(sentPackets[1].payload.mode, 'edit')
  assert.equal(Object.prototype.hasOwnProperty.call(sentPackets[1].payload, 'clientLogs'), false)

  assert.ok(emittedEvents.some(event => event.name === 'script-ai-request'))
})
