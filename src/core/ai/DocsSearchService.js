import fs from 'fs'
import path from 'path'

const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx'])
const TOKEN_PATTERN = /[a-z0-9]+/g

const DEFAULT_OPTIONS = Object.freeze({
  maxFiles: 512,
  maxFileChars: 120_000,
  chunkChars: 1_200,
  chunkOverlapChars: 220,
  minChunkChars: 320,
  maxQueryChars: 240,
  maxResults: 6,
  maxExcerptChars: 420,
  maxResponseChars: 9_000,
  maxMatchesPerPath: 2,
})

function clampInt(value, min, max, fallback) {
  const parsed = Number(value)
  const base = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
  if (base < min) return min
  if (base > max) return max
  return base
}

function normalizeWhitespace(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim()
}

function tokenize(value) {
  if (typeof value !== 'string' || !value) return []
  const tokens = value.toLowerCase().match(TOKEN_PATTERN)
  return tokens || []
}

function uniqueTokens(tokens) {
  const seen = new Set()
  const output = []
  for (const token of tokens) {
    if (seen.has(token)) continue
    seen.add(token)
    output.push(token)
  }
  return output
}

function buildTokenFrequency(tokens) {
  const freq = new Map()
  for (const token of tokens) {
    freq.set(token, (freq.get(token) || 0) + 1)
  }
  return freq
}

function normalizeQuery(query, maxChars) {
  if (typeof query !== 'string') return ''
  return normalizeWhitespace(query).slice(0, maxChars)
}

function isWhitespaceCode(code) {
  return code === 9 || code === 10 || code === 13 || code === 32
}

function clampSearchOptions(options = {}) {
  return {
    maxQueryChars: clampInt(options.maxQueryChars, 16, 2000, DEFAULT_OPTIONS.maxQueryChars),
    maxResults: clampInt(options.maxResults, 1, 64, DEFAULT_OPTIONS.maxResults),
    maxExcerptChars: clampInt(options.maxExcerptChars, 64, 4000, DEFAULT_OPTIONS.maxExcerptChars),
    maxResponseChars: clampInt(options.maxResponseChars, 256, 200_000, DEFAULT_OPTIONS.maxResponseChars),
    maxMatchesPerPath: clampInt(options.maxMatchesPerPath, 1, 8, DEFAULT_OPTIONS.maxMatchesPerPath),
  }
}

export function resolveDocsRoot({ cwd = process.cwd(), additionalCandidates = [] } = {}) {
  const candidates = [
    path.join(cwd, 'docs'),
    path.join(cwd, 'build', 'docs'),
    path.join(cwd, 'public', 'docs'),
    ...additionalCandidates,
  ]
  const seen = new Set()
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate) continue
    const fullPath = path.resolve(candidate)
    if (seen.has(fullPath)) continue
    seen.add(fullPath)
    try {
      if (!fs.existsSync(fullPath)) continue
      if (fs.statSync(fullPath).isDirectory()) return fullPath
    } catch {
      // keep scanning candidates
    }
  }
  return null
}

export function normalizeDocsPath(docPath) {
  if (typeof docPath !== 'string') return null
  const normalized = docPath.trim().replace(/\\/g, '/')
  if (!normalized.startsWith('docs/')) return null
  const relPath = normalized.slice('docs/'.length)
  if (!relPath) return null
  const segments = relPath.split('/')
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return null
  }
  const ext = path.extname(relPath).toLowerCase()
  if (!MARKDOWN_EXTENSIONS.has(ext)) return null
  return `docs/${segments.join('/')}`
}

export function resolveDocsPath(docPath, docsRoot) {
  if (!docsRoot) return null
  const normalized = normalizeDocsPath(docPath)
  if (!normalized) return null
  const relPath = normalized.slice('docs/'.length)
  const fullPath = path.resolve(docsRoot, relPath)
  const relative = path.relative(docsRoot, fullPath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return fullPath
}

export function listDocsMarkdownFiles(docsRoot) {
  if (!docsRoot) return []
  const root = path.resolve(docsRoot)
  const output = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isSymbolicLink()) continue
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!MARKDOWN_EXTENSIONS.has(ext)) continue
      const relPath = path.relative(root, fullPath)
      if (!relPath || relPath.startsWith('..') || path.isAbsolute(relPath)) continue
      output.push(`docs/${relPath.split(path.sep).join('/')}`)
    }
  }
  output.sort((a, b) => a.localeCompare(b))
  return output
}

function findChunkEnd(text, start, targetEnd, minChunkChars) {
  if (targetEnd >= text.length) return text.length
  const minEnd = Math.min(text.length, start + minChunkChars)
  const candidates = [
    text.lastIndexOf('\n## ', targetEnd),
    text.lastIndexOf('\n### ', targetEnd),
    text.lastIndexOf('\n\n', targetEnd),
    text.lastIndexOf('\n', targetEnd),
    text.lastIndexOf(' ', targetEnd),
  ]
  let best = -1
  for (const idx of candidates) {
    if (idx > minEnd && idx > best) best = idx
  }
  if (best !== -1) return best
  return targetEnd
}

export function chunkMarkdown(
  text,
  {
    chunkChars = DEFAULT_OPTIONS.chunkChars,
    chunkOverlapChars = DEFAULT_OPTIONS.chunkOverlapChars,
    minChunkChars = DEFAULT_OPTIONS.minChunkChars,
  } = {}
) {
  const safeChunkChars = clampInt(chunkChars, 128, 20_000, DEFAULT_OPTIONS.chunkChars)
  const safeMinChunkChars = clampInt(minChunkChars, 64, safeChunkChars, DEFAULT_OPTIONS.minChunkChars)
  const safeOverlap = clampInt(
    chunkOverlapChars,
    0,
    Math.max(0, safeChunkChars - 16),
    DEFAULT_OPTIONS.chunkOverlapChars
  )
  const normalized = typeof text === 'string' ? text.replace(/\r\n?/g, '\n').trim() : ''
  if (!normalized) return []
  const output = []
  let start = 0
  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + safeChunkChars)
    end = findChunkEnd(normalized, start, end, safeMinChunkChars)
    if (end <= start) {
      end = Math.min(normalized.length, start + safeChunkChars)
    }
    const chunkText = normalized.slice(start, end).trim()
    if (chunkText) {
      output.push({
        start,
        end,
        text: chunkText,
      })
    }
    if (end >= normalized.length) break
    let nextStart = Math.max(0, end - safeOverlap)
    if (nextStart <= start) nextStart = end
    while (nextStart < normalized.length && isWhitespaceCode(normalized.charCodeAt(nextStart))) {
      nextStart += 1
    }
    start = nextStart
  }
  return output
}

function buildExcerpt(text, queryTokens, maxExcerptChars) {
  const normalized = normalizeWhitespace(text)
  if (normalized.length <= maxExcerptChars) return normalized
  const lower = normalized.toLowerCase()
  let focusIdx = -1
  for (const token of queryTokens) {
    if (token.length < 3) continue
    const idx = lower.indexOf(token)
    if (idx !== -1) {
      focusIdx = idx
      break
    }
  }
  if (focusIdx === -1) focusIdx = 0
  let start = Math.max(0, focusIdx - Math.floor(maxExcerptChars * 0.3))
  let end = Math.min(normalized.length, start + maxExcerptChars)
  if (end - start < maxExcerptChars && start > 0) {
    start = Math.max(0, end - maxExcerptChars)
  }
  let excerpt = normalized.slice(start, end).trim()
  if (start > 0) excerpt = `...${excerpt}`
  if (end < normalized.length) excerpt = `${excerpt}...`
  return excerpt
}

function scoreChunk(chunk, queryTokens, queryLower) {
  let score = 0
  let tokenHits = 0
  for (const token of queryTokens) {
    const contentHits = chunk.tokenFrequency.get(token) || 0
    if (contentHits > 0) {
      tokenHits += 1
      score += 1 + Math.min(1, (contentHits - 1) * 0.25)
    }
    const pathHits = chunk.pathTokenFrequency.get(token) || 0
    if (pathHits > 0) {
      score += 0.35 + Math.min(0.25, (pathHits - 1) * 0.1)
    }
  }
  if (tokenHits > 0) {
    score += tokenHits / queryTokens.length
  }
  if (queryLower.length >= 4 && chunk.lower.includes(queryLower)) {
    score += 2
  }
  return { score, tokenHits }
}

export async function buildDocsSearchIndex({
  docsRoot = resolveDocsRoot(),
  maxFiles = DEFAULT_OPTIONS.maxFiles,
  maxFileChars = DEFAULT_OPTIONS.maxFileChars,
  chunkChars = DEFAULT_OPTIONS.chunkChars,
  chunkOverlapChars = DEFAULT_OPTIONS.chunkOverlapChars,
  minChunkChars = DEFAULT_OPTIONS.minChunkChars,
} = {}) {
  if (!docsRoot) {
    return {
      docsRoot: null,
      files: [],
      chunks: [],
    }
  }
  const safeMaxFiles = clampInt(maxFiles, 1, 4000, DEFAULT_OPTIONS.maxFiles)
  const safeMaxFileChars = clampInt(maxFileChars, 256, 800_000, DEFAULT_OPTIONS.maxFileChars)
  const files = listDocsMarkdownFiles(docsRoot).slice(0, safeMaxFiles)
  const chunks = []
  for (const docPath of files) {
    const fullPath = resolveDocsPath(docPath, docsRoot)
    if (!fullPath) continue
    let content = ''
    try {
      content = await fs.promises.readFile(fullPath, 'utf8')
    } catch {
      continue
    }
    if (!content) continue
    if (content.length > safeMaxFileChars) {
      content = content.slice(0, safeMaxFileChars)
    }
    const pathTokenFrequency = buildTokenFrequency(tokenize(docPath))
    const fileChunks = chunkMarkdown(content, { chunkChars, chunkOverlapChars, minChunkChars })
    for (let chunkIndex = 0; chunkIndex < fileChunks.length; chunkIndex += 1) {
      const chunk = fileChunks[chunkIndex]
      const text = normalizeWhitespace(chunk.text)
      if (!text) continue
      const lower = text.toLowerCase()
      chunks.push({
        path: docPath,
        chunkIndex,
        start: chunk.start,
        end: chunk.end,
        text,
        lower,
        tokenFrequency: buildTokenFrequency(tokenize(lower)),
        pathTokenFrequency,
      })
    }
  }
  return {
    docsRoot,
    files,
    chunks,
  }
}

export class DocsSearchService {
  constructor(options = {}) {
    const chunkChars = clampInt(options.chunkChars, 128, 20_000, DEFAULT_OPTIONS.chunkChars)
    const maxOverlap = Math.max(0, chunkChars - 16)
    this.options = {
      maxFiles: clampInt(options.maxFiles, 1, 4000, DEFAULT_OPTIONS.maxFiles),
      maxFileChars: clampInt(options.maxFileChars, 256, 800_000, DEFAULT_OPTIONS.maxFileChars),
      chunkChars,
      chunkOverlapChars: clampInt(
        options.chunkOverlapChars,
        0,
        maxOverlap,
        Math.min(DEFAULT_OPTIONS.chunkOverlapChars, maxOverlap)
      ),
      minChunkChars: clampInt(options.minChunkChars, 64, chunkChars, Math.min(DEFAULT_OPTIONS.minChunkChars, chunkChars)),
      ...clampSearchOptions(options),
    }
    this.docsRoot =
      options.docsRoot || resolveDocsRoot({ cwd: options.cwd, additionalCandidates: options.additionalCandidates })
    this.index = null
  }

  async refreshIndex() {
    this.index = await buildDocsSearchIndex({
      docsRoot: this.docsRoot,
      maxFiles: this.options.maxFiles,
      maxFileChars: this.options.maxFileChars,
      chunkChars: this.options.chunkChars,
      chunkOverlapChars: this.options.chunkOverlapChars,
      minChunkChars: this.options.minChunkChars,
    })
    return this.index
  }

  async getIndex() {
    if (this.index) return this.index
    return this.refreshIndex()
  }

  async search(query, options = {}) {
    const limits = clampSearchOptions({ ...this.options, ...options })
    const normalizedQuery = normalizeQuery(query, limits.maxQueryChars)
    if (!normalizedQuery) {
      return {
        query: '',
        matches: [],
        truncated: false,
        responseChars: 2,
        indexedFiles: 0,
        indexedChunks: 0,
      }
    }
    const index = options.refresh ? await this.refreshIndex() : await this.getIndex()
    if (!index.docsRoot || !index.chunks.length) {
      return {
        query: normalizedQuery,
        matches: [],
        truncated: false,
        responseChars: 2,
        indexedFiles: index.files.length,
        indexedChunks: 0,
      }
    }
    const queryLower = normalizedQuery.toLowerCase()
    const queryTokens = uniqueTokens(tokenize(queryLower))
    if (!queryTokens.length) {
      return {
        query: normalizedQuery,
        matches: [],
        truncated: false,
        responseChars: 2,
        indexedFiles: index.files.length,
        indexedChunks: index.chunks.length,
      }
    }

    const scored = []
    for (const chunk of index.chunks) {
      const { score, tokenHits } = scoreChunk(chunk, queryTokens, queryLower)
      if (score <= 0) continue
      scored.push({
        chunk,
        score,
        tokenHits,
      })
    }
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const pathCmp = a.chunk.path.localeCompare(b.chunk.path)
      if (pathCmp !== 0) return pathCmp
      return a.chunk.chunkIndex - b.chunk.chunkIndex
    })

    const perPathCount = new Map()
    const matches = []
    let responseChars = JSON.stringify(matches).length
    let truncated = false
    for (const item of scored) {
      if (matches.length >= limits.maxResults) {
        truncated = true
        break
      }
      const currentPerPath = perPathCount.get(item.chunk.path) || 0
      if (currentPerPath >= limits.maxMatchesPerPath) continue
      const entry = {
        path: item.chunk.path,
        excerpt: buildExcerpt(item.chunk.text, queryTokens, limits.maxExcerptChars),
        score: Number(item.score.toFixed(4)),
        metadata: {
          chunkIndex: item.chunk.chunkIndex,
          start: item.chunk.start,
          end: item.chunk.end,
          tokenHits: item.tokenHits,
          queryTokenCount: queryTokens.length,
        },
      }
      const nextMatches = [...matches, entry]
      const nextChars = JSON.stringify(nextMatches).length
      if (nextChars > limits.maxResponseChars) {
        truncated = true
        break
      }
      matches.push(entry)
      responseChars = nextChars
      perPathCount.set(item.chunk.path, currentPerPath + 1)
    }

    return {
      query: normalizedQuery,
      matches,
      truncated,
      responseChars,
      indexedFiles: index.files.length,
      indexedChunks: index.chunks.length,
    }
  }
}
