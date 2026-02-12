import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MAX_CONTEXT_LOG_ENTRIES } from '../../src/core/ai/AIRequestContract.js'
import { buildUnifiedScriptPrompts } from '../../src/core/ai/AIScriptPrompt.js'

function createLogs(prefix, count) {
  return Array.from({ length: count }, (_, idx) => ({
    timestamp: new Date(1700000000000 + idx * 1000).toISOString(),
    level: idx % 2 ? 'warn' : 'error',
    args: [prefix, idx],
    message: `${prefix}-${idx}`,
  }))
}

test('fix prompt includes formatted client/server runtime logs with bounded entries', () => {
  const clientLogs = createLogs('client', MAX_CONTEXT_LOG_ENTRIES + 2)
  const serverLogs = createLogs('server', MAX_CONTEXT_LOG_ENTRIES + 2)

  const { userPrompt } = buildUnifiedScriptPrompts({
    mode: 'fix',
    error: { message: 'boom' },
    context: {
      clientLogs,
      serverLogs,
      actor: 'test-user',
    },
  })

  assert.ok(userPrompt.includes('Runtime logs (last 20 entries each):'))
  assert.ok(userPrompt.includes('Client logs'))
  assert.ok(userPrompt.includes('Server logs'))
  assert.ok(userPrompt.includes('client-2'))
  assert.ok(userPrompt.includes('server-2'))
  assert.equal(userPrompt.includes('client-0'), false)
  assert.equal(userPrompt.includes('server-0'), false)
  assert.ok(userPrompt.includes('"actor": "test-user"'))
})

test('non-fix prompt omits runtime log sections', () => {
  const { userPrompt } = buildUnifiedScriptPrompts({
    mode: 'edit',
    prompt: 'rename helper',
    context: {
      clientLogs: createLogs('client', 1),
      serverLogs: createLogs('server', 1),
      actor: 'test-user',
    },
  })

  assert.equal(userPrompt.includes('Runtime logs'), false)
  assert.equal(userPrompt.includes('Client logs'), false)
  assert.equal(userPrompt.includes('Server logs'), false)
  assert.ok(userPrompt.includes('"actor": "test-user"'))
})
