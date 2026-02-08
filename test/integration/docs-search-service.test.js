import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  DocsSearchService,
  buildDocsSearchIndex,
  normalizeDocsPath,
  resolveDocsPath,
} from '../../src/core/ai/DocsSearchService.js'

async function withTempDocs(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docs-search-test-'))
  const docsRoot = path.join(root, 'docs')
  await fs.mkdir(docsRoot, { recursive: true })
  try {
    await run({ root, docsRoot })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

test('resolveDocsPath validates docs-relative markdown paths', async () => {
  await withTempDocs(async ({ docsRoot }) => {
    await fs.mkdir(path.join(docsRoot, 'guides'), { recursive: true })
    await fs.writeFile(path.join(docsRoot, 'guides', 'intro.md'), '# Intro\n', 'utf8')

    const validPath = resolveDocsPath('docs/guides/intro.md', docsRoot)
    assert.equal(validPath, path.join(docsRoot, 'guides', 'intro.md'))
    assert.equal(resolveDocsPath('docs\\guides\\intro.md', docsRoot), path.join(docsRoot, 'guides', 'intro.md'))

    assert.equal(resolveDocsPath('docs/../secret.md', docsRoot), null)
    assert.equal(resolveDocsPath('docs/guides/intro.txt', docsRoot), null)
    assert.equal(resolveDocsPath('guides/intro.md', docsRoot), null)
    assert.equal(normalizeDocsPath('docs/./guides/intro.md'), null)
  })
})

test('buildDocsSearchIndex and ranking are deterministic', async () => {
  await withTempDocs(async ({ docsRoot }) => {
    await fs.mkdir(path.join(docsRoot, 'scripting'), { recursive: true })
    await fs.mkdir(path.join(docsRoot, 'world'), { recursive: true })
    await fs.writeFile(
      path.join(docsRoot, 'scripting', 'Networking.md'),
      [
        '# Networking',
        '',
        'Use network events to replicate entity state changes across clients.',
        'Network events should be idempotent and only include serializable payloads.',
      ].join('\n'),
      'utf8'
    )
    await fs.writeFile(
      path.join(docsRoot, 'world', 'Player.md'),
      [
        '# Player',
        '',
        'Player APIs expose movement, avatar controls, and local interaction helpers.',
      ].join('\n'),
      'utf8'
    )

    const indexA = await buildDocsSearchIndex({
      docsRoot,
      chunkChars: 120,
      chunkOverlapChars: 24,
      minChunkChars: 64,
    })
    const indexB = await buildDocsSearchIndex({
      docsRoot,
      chunkChars: 120,
      chunkOverlapChars: 24,
      minChunkChars: 64,
    })
    assert.deepEqual(
      indexA.chunks.map(chunk => ({
        path: chunk.path,
        chunkIndex: chunk.chunkIndex,
        start: chunk.start,
        end: chunk.end,
        text: chunk.text,
      })),
      indexB.chunks.map(chunk => ({
        path: chunk.path,
        chunkIndex: chunk.chunkIndex,
        start: chunk.start,
        end: chunk.end,
        text: chunk.text,
      }))
    )

    const service = new DocsSearchService({
      docsRoot,
      chunkChars: 120,
      chunkOverlapChars: 24,
      minChunkChars: 64,
      maxResults: 4,
    })
    const first = await service.search('network events entity state')
    const second = await service.search('network events entity state')

    assert.deepEqual(first, second)
    assert.ok(first.matches.length > 0)
    assert.equal(first.matches[0].path, 'docs/scripting/Networking.md')
    assert.ok(first.matches[0].score >= first.matches[first.matches.length - 1].score)
  })
})

test('DocsSearchService bounds result payload size', async () => {
  await withTempDocs(async ({ docsRoot }) => {
    await fs.mkdir(path.join(docsRoot, 'ai'), { recursive: true })
    await fs.writeFile(
      path.join(docsRoot, 'ai', 'tool-call.md'),
      Array.from({ length: 120 }, (_, idx) => `searchdocs tool call payload bound entry ${idx}`).join('\n'),
      'utf8'
    )

    const service = new DocsSearchService({
      docsRoot,
      chunkChars: 100,
      chunkOverlapChars: 16,
      minChunkChars: 64,
    })
    const result = await service.search('searchdocs tool call payload', {
      maxResults: 10,
      maxExcerptChars: 240,
      maxResponseChars: 420,
    })

    assert.ok(result.matches.length > 0)
    assert.ok(result.responseChars <= 420)
    assert.equal(result.responseChars, JSON.stringify(result.matches).length)
  })
})

