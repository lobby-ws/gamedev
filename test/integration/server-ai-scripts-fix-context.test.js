import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MAX_CONTEXT_LOG_ENTRIES } from '../../src/core/ai/AIRequestContract.js'
import { ServerAIScripts } from '../../src/core/systems/ServerAIScripts.js'

function createLogEntries(prefix, count) {
  return Array.from({ length: count }, (_, idx) => ({
    timestamp: new Date(1700000000000 + idx * 1000).toISOString(),
    level: idx % 2 ? 'warn' : 'error',
    args: [prefix, idx],
    message: `${prefix}-${idx}`,
  }))
}

function createServerAIScriptsHarness({ serverLogs = [] } = {}) {
  const prompts = []
  const sentPackets = []
  const serverLogCalls = []
  const scriptRoot = {
    id: 'script-root-1',
    scriptEntry: 'index.js',
    scriptFormat: 'module',
    scriptFiles: {
      'index.js': 'asset://index.js',
    },
  }

  const world = {
    blueprints: {
      get: id => {
        if (id === scriptRoot.id) return scriptRoot
        return null
      },
    },
    entities: {
      get: () => null,
    },
    resolveURL: url => url,
    loader: {
      fetchText: async () => 'export default function () {}',
    },
    scripts: {
      getRecentServerLogs: (appId, limit) => {
        serverLogCalls.push({ appId, limit })
        return serverLogs
      },
    },
  }

  const aiScripts = new ServerAIScripts(world)
  aiScripts.enabled = true
  aiScripts.provider = 'openai'
  aiScripts.model = 'test-model'
  aiScripts.client = {
    generate: async (systemPrompt, userPrompt) => {
      prompts.push({ systemPrompt, userPrompt })
      return JSON.stringify({
        summary: 'patched index script',
        files: [{ path: 'index.js', content: 'export default function () {}' }],
      })
    },
  }

  const socket = {
    player: {
      isBuilder: () => true,
    },
    send: (name, payload) => {
      sentPackets.push({ name, payload })
    },
  }

  return {
    aiScripts,
    prompts,
    sentPackets,
    serverLogCalls,
    scriptRoot,
    socket,
  }
}

test('server AI fix requests include bounded client and server logs in prompt context', async () => {
  const clientLogs = createLogEntries('client', MAX_CONTEXT_LOG_ENTRIES + 4)
  const serverLogs = createLogEntries('server', MAX_CONTEXT_LOG_ENTRIES + 4)
  const { aiScripts, prompts, sentPackets, serverLogCalls, scriptRoot, socket } = createServerAIScriptsHarness({
    serverLogs,
  })

  await aiScripts.handleRequest(socket, {
    mode: 'fix',
    requestId: 'fix-request-1',
    target: {
      scriptRootId: scriptRoot.id,
      appId: 'app-fix-1',
    },
    error: {
      message: 'script exploded',
    },
    context: {
      clientLogs,
    },
  })

  assert.equal(serverLogCalls.length, 1)
  assert.deepEqual(serverLogCalls[0], {
    appId: 'app-fix-1',
    limit: MAX_CONTEXT_LOG_ENTRIES,
  })
  assert.equal(prompts.length, 1)
  assert.ok(prompts[0].userPrompt.includes('Runtime logs'))
  assert.ok(prompts[0].userPrompt.includes('Client logs'))
  assert.ok(prompts[0].userPrompt.includes('Server logs'))
  assert.ok(prompts[0].userPrompt.includes('client-4'))
  assert.ok(prompts[0].userPrompt.includes('server-4'))
  assert.equal(prompts[0].userPrompt.includes('client-3'), false)
  assert.equal(prompts[0].userPrompt.includes('server-3'), false)

  assert.equal(sentPackets.length, 1)
  assert.equal(sentPackets[0].name, 'scriptAiProposal')
  assert.equal(sentPackets[0].payload.requestId, 'fix-request-1')
  assert.equal(sentPackets[0].payload.scriptRootId, scriptRoot.id)
  assert.equal(sentPackets[0].payload.error, undefined)
})

test('server AI edit requests do not include runtime logs', async () => {
  const { aiScripts, prompts, sentPackets, serverLogCalls, scriptRoot, socket } = createServerAIScriptsHarness({
    serverLogs: createLogEntries('server', 3),
  })

  await aiScripts.handleRequest(socket, {
    mode: 'edit',
    requestId: 'edit-request-1',
    prompt: 'rename helper function',
    target: {
      scriptRootId: scriptRoot.id,
      appId: 'app-edit-1',
    },
    context: {
      clientLogs: createLogEntries('client', 3),
    },
  })

  assert.equal(serverLogCalls.length, 0)
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].userPrompt.includes('Runtime logs'), false)
  assert.equal(prompts[0].userPrompt.includes('Client logs'), false)
  assert.equal(prompts[0].userPrompt.includes('Server logs'), false)

  assert.equal(sentPackets.length, 1)
  assert.equal(sentPackets[0].name, 'scriptAiProposal')
  assert.equal(sentPackets[0].payload.requestId, 'edit-request-1')
  assert.equal(sentPackets[0].payload.scriptRootId, scriptRoot.id)
  assert.equal(sentPackets[0].payload.error, undefined)
})
