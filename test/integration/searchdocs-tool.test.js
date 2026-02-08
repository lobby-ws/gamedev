import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  normalizeSearchDocsLimits,
  normalizeSearchDocsQuery,
  normalizeSearchDocsToolOutput,
} from '../../src/core/ai/SearchDocsToolCore.js'

test('normalizeSearchDocsLimits clamps configurable bounds', () => {
  const limits = normalizeSearchDocsLimits({
    maxQueryChars: 4,
    maxResults: 200,
    maxExcerptChars: 10,
    maxResponseChars: 900_000,
  })

  assert.equal(limits.maxQueryChars, 16)
  assert.equal(limits.maxResults, 64)
  assert.equal(limits.maxExcerptChars, 64)
  assert.equal(limits.maxResponseChars, 200_000)
})

test('normalizeSearchDocsToolOutput trims invalid matches and enforces limits', () => {
  const output = normalizeSearchDocsToolOutput(
    {
      query: '   runtime api details with extra spacing   ',
      matches: [
        {
          path: 'docs/scripting/README.md',
          excerpt: 'A'.repeat(300),
          score: 0.44444,
          metadata: { chunkIndex: 1, start: 10, end: 120, tokenHits: 3, queryTokenCount: 4 },
        },
        {
          path: '../outside.md',
          excerpt: 'invalid path',
          score: 1,
        },
        {
          path: 'docs/commands.md',
          excerpt: 'second',
          score: 'not-a-number',
        },
      ],
      truncated: true,
      responseChars: '50',
      indexedFiles: '7',
      indexedChunks: '14',
    },
    {
      maxQueryChars: 24,
      maxResults: 2,
      maxExcerptChars: 12,
      maxResponseChars: 100,
    }
  )

  assert.equal(output.query, 'runtime api details with')
  assert.equal(output.matches.length, 2)
  assert.equal(output.matches[0].path, 'docs/scripting/README.md')
  assert.equal(output.matches[0].excerpt.length, 64)
  assert.equal(output.matches[0].score, 0.4444)
  assert.equal(output.matches[1].path, 'docs/commands.md')
  assert.equal(output.matches[1].score, 0)
  assert.equal(output.truncated, true)
  assert.equal(output.responseChars, 50)
  assert.equal(output.indexedFiles, 7)
  assert.equal(output.indexedChunks, 14)
})

test('normalizeSearchDocsQuery trims whitespace and bounds size', () => {
  const query = normalizeSearchDocsQuery('   world movement helpers and interpolation extras   ', 30)
  assert.equal(query, 'world movement helpers and int')
  assert.equal(normalizeSearchDocsQuery('   ', 30), '')
})
