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

async function withEnv(name, value, fn) {
  const previous = process.env[name]
  if (value == null) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
  const restore = () => {
    if (typeof previous === 'undefined') {
      delete process.env[name]
      return
    }
    process.env[name] = previous
  }
  try {
    return await fn()
  } finally {
    restore()
  }
}

function createServerAIScriptsHarness({ serverLogs = [], generation = undefined } = {}) {
  const generateCalls = []
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
  const defaultGeneration = {
    text: JSON.stringify({
      summary: 'patched index script',
      files: [{ path: 'index.js', content: 'export default function () {}' }],
    }),
    finishReason: 'stop',
    stepCount: 1,
    toolCallCount: 0,
  }
  aiScripts.client = {
    generate: async (systemPrompt, userPrompt, options) => {
      generateCalls.push({ systemPrompt, userPrompt, options })
      if (typeof generation === 'function') {
        return generation(systemPrompt, userPrompt, options)
      }
      if (generation instanceof Error) {
        throw generation
      }
      if (typeof generation === 'string') {
        return {
          ...defaultGeneration,
          text: generation,
        }
      }
      if (generation && typeof generation === 'object') {
        return {
          ...defaultGeneration,
          ...generation,
        }
      }
      return defaultGeneration
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
    generateCalls,
    sentPackets,
    serverLogCalls,
    scriptRoot,
    socket,
  }
}

test('server AI fix requests include bounded client and server logs in prompt context', async () => {
  const clientLogs = createLogEntries('client', MAX_CONTEXT_LOG_ENTRIES + 4)
  const serverLogs = createLogEntries('server', MAX_CONTEXT_LOG_ENTRIES + 4)
  const { aiScripts, generateCalls, sentPackets, serverLogCalls, scriptRoot, socket } = createServerAIScriptsHarness({
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
  assert.equal(generateCalls.length, 1)
  assert.ok(generateCalls[0].userPrompt.includes('Runtime logs'))
  assert.ok(generateCalls[0].userPrompt.includes('Client logs'))
  assert.ok(generateCalls[0].userPrompt.includes('Server logs'))
  assert.ok(generateCalls[0].userPrompt.includes('client-4'))
  assert.ok(generateCalls[0].userPrompt.includes('server-4'))
  assert.equal(generateCalls[0].userPrompt.includes('client-3'), false)
  assert.equal(generateCalls[0].userPrompt.includes('server-3'), false)

  assert.equal(sentPackets.length, 1)
  assert.equal(sentPackets[0].name, 'scriptAiProposal')
  assert.equal(sentPackets[0].payload.requestId, 'fix-request-1')
  assert.equal(sentPackets[0].payload.scriptRootId, scriptRoot.id)
  assert.equal(sentPackets[0].payload.error, undefined)
})

test('server AI edit requests do not include runtime logs', async () => {
  const { aiScripts, generateCalls, sentPackets, serverLogCalls, scriptRoot, socket } = createServerAIScriptsHarness({
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
  assert.equal(generateCalls.length, 1)
  assert.equal(generateCalls[0].userPrompt.includes('Runtime logs'), false)
  assert.equal(generateCalls[0].userPrompt.includes('Client logs'), false)
  assert.equal(generateCalls[0].userPrompt.includes('Server logs'), false)

  assert.equal(sentPackets.length, 1)
  assert.equal(sentPackets[0].name, 'scriptAiProposal')
  assert.equal(sentPackets[0].payload.requestId, 'edit-request-1')
  assert.equal(sentPackets[0].payload.scriptRootId, scriptRoot.id)
  assert.equal(sentPackets[0].payload.error, undefined)
})

test('server AI requests include searchDocs tool loop options when rollout is enabled', async () => {
  await withEnv('AI_TOOL_LOOP_ENABLED', 'true', async () => {
    const { aiScripts, generateCalls, sentPackets, scriptRoot, socket } = createServerAIScriptsHarness()

    await aiScripts.handleRequest(socket, {
      mode: 'edit',
      requestId: 'edit-tools-on',
      prompt: 'check docs for node api',
      target: {
        scriptRootId: scriptRoot.id,
      },
    })

    assert.equal(generateCalls.length, 1)
    const options = generateCalls[0].options
    assert.equal(options.maxSteps, 10)
    assert.equal(options.maxToolCalls, 4)
    assert.equal(options.timeoutMs, 45_000)
    assert.ok(options.tools)
    assert.equal(typeof options.tools.searchDocs.execute, 'function')
    assert.equal(sentPackets.length, 1)
    assert.equal(sentPackets[0].payload.error, undefined)
  })
})

test('server AI requests disable searchDocs tool loop when rollout is off', async () => {
  await withEnv('AI_TOOL_LOOP_ENABLED', 'false', async () => {
    const { aiScripts, generateCalls, sentPackets, scriptRoot, socket } = createServerAIScriptsHarness()

    await aiScripts.handleRequest(socket, {
      mode: 'edit',
      requestId: 'edit-tools-off',
      prompt: 'check docs for node api',
      target: {
        scriptRootId: scriptRoot.id,
      },
    })

    assert.equal(generateCalls.length, 1)
    assert.equal(generateCalls[0].options.tools, null)
    assert.equal(sentPackets.length, 1)
    assert.equal(sentPackets[0].payload.error, undefined)
  })
})

test('server AI returns ai_request_failed when generation output is invalid', async () => {
  const { aiScripts, sentPackets, scriptRoot, socket } = createServerAIScriptsHarness({
    generation: '{not-valid-json',
  })

  await aiScripts.handleRequest(socket, {
    mode: 'edit',
    requestId: 'invalid-generation',
    prompt: 'rename helper',
    target: {
      scriptRootId: scriptRoot.id,
    },
  })

  assert.equal(sentPackets.length, 1)
  assert.equal(sentPackets[0].name, 'scriptAiProposal')
  assert.equal(sentPackets[0].payload.requestId, 'invalid-generation')
  assert.equal(sentPackets[0].payload.error, 'ai_request_failed')
  assert.equal(sentPackets[0].payload.message, 'AI request failed.')
})
