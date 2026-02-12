const DEFAULT_INPUT_LIMITS = Object.freeze({
  maxQueryChars: 240,
  maxResults: 6,
  maxExcerptChars: 420,
  maxResponseChars: 9_000,
})

export const DEFAULT_SEARCH_DOCS_TOOL_OUTPUT = Object.freeze({
  query: '',
  matches: [],
  truncated: false,
  responseChars: 2,
  indexedFiles: 0,
  indexedChunks: 0,
})

function clampInt(value, min, max, fallback) {
  const parsed = Number(value)
  const base = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
  if (base < min) return min
  if (base > max) return max
  return base
}

export function normalizeSearchDocsQuery(value, maxQueryChars) {
  if (typeof value !== 'string') return ''
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.slice(0, maxQueryChars)
}

function normalizeDocsMatch(match, maxExcerptChars) {
  if (!match || typeof match !== 'object') return null
  if (typeof match.path !== 'string' || !match.path.startsWith('docs/')) return null
  if (typeof match.excerpt !== 'string') return null
  const excerpt = match.excerpt.slice(0, maxExcerptChars)
  const score = Number(match.score)
  const output = {
    path: match.path,
    excerpt,
    score: Number.isFinite(score) ? Number(score.toFixed(4)) : 0,
  }
  if (match.metadata && typeof match.metadata === 'object') {
    output.metadata = {
      chunkIndex: Number.isFinite(Number(match.metadata.chunkIndex)) ? Number(match.metadata.chunkIndex) : 0,
      start: Number.isFinite(Number(match.metadata.start)) ? Number(match.metadata.start) : 0,
      end: Number.isFinite(Number(match.metadata.end)) ? Number(match.metadata.end) : 0,
      tokenHits: Number.isFinite(Number(match.metadata.tokenHits)) ? Number(match.metadata.tokenHits) : 0,
      queryTokenCount: Number.isFinite(Number(match.metadata.queryTokenCount))
        ? Number(match.metadata.queryTokenCount)
        : 0,
    }
  }
  return output
}

export function normalizeSearchDocsLimits(limits = {}) {
  return {
    maxQueryChars: clampInt(limits.maxQueryChars, 16, 2000, DEFAULT_INPUT_LIMITS.maxQueryChars),
    maxResults: clampInt(limits.maxResults, 1, 64, DEFAULT_INPUT_LIMITS.maxResults),
    maxExcerptChars: clampInt(limits.maxExcerptChars, 64, 4000, DEFAULT_INPUT_LIMITS.maxExcerptChars),
    maxResponseChars: clampInt(limits.maxResponseChars, 256, 200_000, DEFAULT_INPUT_LIMITS.maxResponseChars),
  }
}

export function normalizeSearchDocsToolOutput(rawResult, limits = {}) {
  if (!rawResult || typeof rawResult !== 'object') {
    return { ...DEFAULT_SEARCH_DOCS_TOOL_OUTPUT }
  }
  const safeLimits = normalizeSearchDocsLimits(limits)
  const query = normalizeSearchDocsQuery(rawResult.query, safeLimits.maxQueryChars)
  const matches = []
  if (Array.isArray(rawResult.matches)) {
    for (const item of rawResult.matches) {
      if (matches.length >= safeLimits.maxResults) break
      const normalized = normalizeDocsMatch(item, safeLimits.maxExcerptChars)
      if (!normalized) continue
      matches.push(normalized)
    }
  }
  const indexedFiles = Number(rawResult.indexedFiles)
  const indexedChunks = Number(rawResult.indexedChunks)
  const responseChars = Number(rawResult.responseChars)
  return {
    query,
    matches,
    truncated: !!rawResult.truncated,
    responseChars: Number.isFinite(responseChars)
      ? clampInt(responseChars, 2, safeLimits.maxResponseChars, JSON.stringify(matches).length)
      : JSON.stringify(matches).length,
    indexedFiles: Number.isFinite(indexedFiles) ? Math.max(0, Math.trunc(indexedFiles)) : 0,
    indexedChunks: Number.isFinite(indexedChunks) ? Math.max(0, Math.trunc(indexedChunks)) : 0,
  }
}
