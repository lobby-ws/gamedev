import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildUnifiedAiRequestPayload, normalizeAiRequest } from '../../src/core/ai/AIRequestContract.js'
import { parseAiScriptResponse } from '../../src/core/ai/AIScriptResponse.js'

test('buildUnifiedAiRequestPayload builds unified shape and compatibility fields', () => {
  const logs = Array.from({ length: 24 }, (_, idx) => ({
    timestamp: new Date(1700000000000 + idx * 1000).toISOString(),
    level: idx % 2 ? 'warn' : 'error',
    args: ['line', idx],
    message: `line ${idx}`,
  }))
  const payload = buildUnifiedAiRequestPayload({
    requestId: 'req-1',
    mode: 'fix',
    error: { message: 'boom' },
    target: {
      scriptRootId: 'root-1',
      blueprintId: 'bp-1',
      appId: 'app-1',
    },
    attachments: [
      { type: 'doc', path: 'docs/scripting/README.md' },
      { type: 'doc', path: 'docs/scripting/README.md' },
      { type: 'script', path: 'index.js' },
      { type: 'invalid', path: 'skip.js' },
    ],
    clientLogs: logs,
    includeLegacyFields: true,
  })

  assert.equal(payload.mode, 'fix')
  assert.equal(payload.requestId, 'req-1')
  assert.deepEqual(payload.target, {
    scriptRootId: 'root-1',
    blueprintId: 'bp-1',
    appId: 'app-1',
  })
  assert.equal(payload.context.clientLogs.length, 20)
  assert.equal(payload.clientLogs.length, 20)
  assert.deepEqual(payload.attachments, [
    { type: 'doc', path: 'docs/scripting/README.md' },
    { type: 'script', path: 'index.js' },
  ])
  assert.equal(payload.scriptRootId, 'root-1')
  assert.equal(payload.blueprintId, 'bp-1')
  assert.equal(payload.appId, 'app-1')
})

test('normalizeAiRequest supports legacy and target-based fields', () => {
  const request = normalizeAiRequest({
    mode: 'fix',
    scriptRootId: 'legacy-root',
    appId: 'legacy-app',
    target: {
      scriptRootId: 'target-root',
      blueprintId: 'target-blueprint',
    },
    attachments: [{ type: 'script', path: 'index.js' }],
    clientLogs: [{ level: 'error', args: ['boom'], message: 'boom' }],
  })

  assert.equal(request.mode, 'fix')
  assert.equal(request.target.scriptRootId, 'target-root')
  assert.equal(request.target.blueprintId, 'target-blueprint')
  assert.equal(request.target.appId, 'legacy-app')
  assert.deepEqual(request.attachments, [{ type: 'script', path: 'index.js' }])
  assert.equal(request.context.clientLogs.length, 1)
})

test('parseAiScriptResponse is deterministic and validates paths', () => {
  const raw = [
    '```json',
    '{',
    '  "summary": "updated files",',
    '  "files": [',
    '    { "path": "index.js", "content": "export default () => {}" },',
    '    { "path": "index.js", "content": "duplicate" },',
    '    { "path": "../outside.js", "content": "bad" }',
    '  ]',
    '}',
    '```',
  ].join('\n')

  const parsed = parseAiScriptResponse(raw, {
    validatePath: relPath => !relPath.includes('..'),
  })

  assert.deepEqual(parsed, {
    summary: 'updated files',
    files: [{ path: 'index.js', content: 'export default () => {}' }],
  })
})
