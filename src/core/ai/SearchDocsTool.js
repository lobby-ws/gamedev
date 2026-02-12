import { tool } from 'ai'
import { z } from 'zod'
import {
  DEFAULT_SEARCH_DOCS_TOOL_OUTPUT,
  normalizeSearchDocsLimits,
  normalizeSearchDocsQuery,
  normalizeSearchDocsToolOutput,
} from './SearchDocsToolCore'

const searchDocsOutputSchema = z.object({
  query: z.string(),
  matches: z.array(
    z.object({
      path: z.string(),
      excerpt: z.string(),
      score: z.number(),
      metadata: z
        .object({
          chunkIndex: z.number(),
          start: z.number(),
          end: z.number(),
          tokenHits: z.number(),
          queryTokenCount: z.number(),
        })
        .optional(),
    })
  ),
  truncated: z.boolean(),
  responseChars: z.number(),
  indexedFiles: z.number(),
  indexedChunks: z.number(),
})

export { normalizeSearchDocsLimits, normalizeSearchDocsToolOutput } from './SearchDocsToolCore'

export function createSearchDocsTool({ docsSearch, limits = {} } = {}) {
  if (!docsSearch || typeof docsSearch.search !== 'function') return null
  const safeLimits = normalizeSearchDocsLimits(limits)
  return tool({
    description:
      'Search markdown docs under docs/ and return relevant excerpts. Use this when runtime APIs or behavior are unclear.',
    inputSchema: z
      .object({
        query: z
          .string()
          .min(1)
          .max(safeLimits.maxQueryChars)
          .describe('What to look up in docs/ markdown files'),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(safeLimits.maxResults)
          .optional()
          .describe('Optional cap for returned matches'),
      })
      .strict(),
    outputSchema: searchDocsOutputSchema,
    execute: async input => {
      const query = normalizeSearchDocsQuery(input?.query, safeLimits.maxQueryChars)
      if (!query) return { ...DEFAULT_SEARCH_DOCS_TOOL_OUTPUT }
      const maxResults = Number.isFinite(Number(input?.maxResults))
        ? Math.min(Math.max(1, Math.trunc(Number(input.maxResults))), safeLimits.maxResults)
        : safeLimits.maxResults
      const result = await docsSearch.search(query, {
        maxResults,
        maxExcerptChars: safeLimits.maxExcerptChars,
        maxResponseChars: safeLimits.maxResponseChars,
      })
      return normalizeSearchDocsToolOutput(result, safeLimits)
    },
  })
}
