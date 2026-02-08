const fencePattern = /^```(?:\w+)?\s*([\s\S]*?)\s*```$/
const DEFAULT_MAX_FILES = 40

function stripCodeFences(text) {
  if (!text) return ''
  const cleaned = String(text).trim()
  const match = cleaned.match(fencePattern)
  if (match) return match[1]
  return cleaned
}

function extractJson(text) {
  const cleaned = stripCodeFences(text).trim()
  if (!cleaned) return null
  try {
    return JSON.parse(cleaned)
  } catch {
    const first = cleaned.indexOf('{')
    const last = cleaned.lastIndexOf('}')
    if (first === -1 || last === -1 || last <= first) return null
    const slice = cleaned.slice(first, last + 1)
    try {
      return JSON.parse(slice)
    } catch {
      return null
    }
  }
}

function readFilesPayload(value) {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return null
  if (Array.isArray(value.files)) return value.files
  if (Array.isArray(value.changes)) return value.changes
  if (Array.isArray(value.patches)) return value.patches
  return null
}

function readFilePath(entry) {
  if (!entry || typeof entry !== 'object') return null
  const path = entry.path || entry.relPath || entry.file
  if (typeof path !== 'string') return null
  const trimmed = path.trim()
  return trimmed || null
}

function readFileContent(entry) {
  if (!entry || typeof entry !== 'object') return null
  const content = entry.content ?? entry.text ?? entry.code ?? entry.nextText
  if (typeof content !== 'string') return null
  return content
}

export function normalizeAiScriptResponse(value, { validatePath = null, maxFiles = DEFAULT_MAX_FILES } = {}) {
  const filesPayload = readFilesPayload(value)
  if (!filesPayload?.length) return null
  const limit = Number.isFinite(maxFiles) && maxFiles > 0 ? Math.floor(maxFiles) : DEFAULT_MAX_FILES
  const files = []
  const seen = new Set()
  for (const entry of filesPayload) {
    const path = readFilePath(entry)
    const content = readFileContent(entry)
    if (!path || content == null) continue
    if (validatePath && !validatePath(path)) continue
    if (seen.has(path)) continue
    seen.add(path)
    files.push({ path, content })
    if (files.length >= limit) break
  }
  if (!files.length) return null
  const summary = value && typeof value === 'object' && typeof value.summary === 'string' ? value.summary : ''
  return { summary, files }
}

export function parseAiScriptResponse(raw, options = {}) {
  const value = extractJson(raw)
  if (!value) return null
  return normalizeAiScriptResponse(value, options)
}
