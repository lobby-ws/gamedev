const MAX_ATTACHMENTS = 12
export const MAX_CONTEXT_LOG_ENTRIES = 20
const MAX_LOG_ARGS = 8
const MAX_LOG_ARG_LENGTH = 400
const MAX_LOG_MESSAGE_LENGTH = 1200

function nonEmptyString(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function normalizeMode(value, fallback = 'edit') {
  if (value === 'create' || value === 'edit' || value === 'fix') {
    return value
  }
  return fallback
}

function truncateString(value, maxLength) {
  if (typeof value !== 'string') return ''
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}...`
}

function serializeContextArg(value) {
  if (typeof value === 'string') return truncateString(value, MAX_LOG_ARG_LENGTH)
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'symbol') return truncateString(value.toString(), MAX_LOG_ARG_LENGTH)
  if (typeof value === 'function') {
    const name = value.name || 'anonymous'
    return `[Function ${name}]`
  }
  if (value instanceof Error) {
    const detail = value.stack || `${value.name || 'Error'}: ${value.message || ''}`
    return truncateString(detail, MAX_LOG_ARG_LENGTH)
  }
  try {
    return truncateString(JSON.stringify(value), MAX_LOG_ARG_LENGTH)
  } catch {
    return truncateString(String(value), MAX_LOG_ARG_LENGTH)
  }
}

function normalizeContextLogEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  const timestamp = nonEmptyString(entry.timestamp)
  const level = nonEmptyString(entry.level) || 'log'
  const args = Array.isArray(entry.args) ? entry.args.slice(0, MAX_LOG_ARGS).map(serializeContextArg) : []
  const messageSource = nonEmptyString(entry.message)
  return {
    timestamp: timestamp || new Date().toISOString(),
    level,
    args,
    message: truncateString(messageSource || args.join(' '), MAX_LOG_MESSAGE_LENGTH),
  }
}

export function normalizeAiContextLogs(entries) {
  if (!Array.isArray(entries) || !entries.length) return []
  const start = Math.max(0, entries.length - MAX_CONTEXT_LOG_ENTRIES)
  const normalized = []
  for (let i = start; i < entries.length; i += 1) {
    const entry = normalizeContextLogEntry(entries[i])
    if (!entry) continue
    normalized.push(entry)
  }
  return normalized
}

function readTarget(input = {}, key) {
  const fromTarget = nonEmptyString(input?.target?.[key])
  if (fromTarget) return fromTarget
  return nonEmptyString(input?.[key])
}

export function normalizeAiAttachments(input) {
  if (!Array.isArray(input)) return []
  const output = []
  const seen = new Set()
  for (const item of input) {
    if (!item) continue
    const type = item.type === 'doc' || item.type === 'script' ? item.type : null
    const path = nonEmptyString(item.path)
    if (!type || !path) continue
    const key = `${type}:${path}`
    if (seen.has(key)) continue
    seen.add(key)
    output.push({ type, path })
    if (output.length >= MAX_ATTACHMENTS) break
  }
  return output
}

export function normalizeAiRequest(input = {}, { fallbackMode = 'edit' } = {}) {
  const mode = normalizeMode(input?.mode, fallbackMode)
  const requestId = nonEmptyString(input?.requestId)
  const target = {}
  const blueprintId = readTarget(input, 'blueprintId')
  const scriptRootId = readTarget(input, 'scriptRootId')
  const appId = readTarget(input, 'appId')
  if (blueprintId) target.blueprintId = blueprintId
  if (scriptRootId) target.scriptRootId = scriptRootId
  if (appId) target.appId = appId

  const prompt = nonEmptyString(input?.prompt) || ''
  const error = input?.error ?? null
  const attachments = normalizeAiAttachments(input?.attachments)
  const legacyLogs = Array.isArray(input?.clientLogs) ? input.clientLogs : null
  const contextLogs =
    Array.isArray(input?.context?.clientLogs) || legacyLogs ? input?.context?.clientLogs || legacyLogs : null
  const clientLogs = normalizeAiContextLogs(contextLogs)
  const context = {}
  if (clientLogs.length) {
    context.clientLogs = clientLogs
  }
  const output = {
    requestId,
    mode,
    prompt,
    error,
    target,
    attachments,
    context,
  }
  return output
}

export function buildUnifiedAiRequestPayload({
  requestId = null,
  mode = 'edit',
  prompt = '',
  error = null,
  target = null,
  attachments = null,
  context = null,
  clientLogs = null,
  includeLegacyFields = false,
} = {}) {
  const normalized = normalizeAiRequest(
    {
      requestId,
      mode,
      prompt,
      error,
      target: target || undefined,
      attachments: attachments || undefined,
      context: context || undefined,
      clientLogs: clientLogs || undefined,
    },
    { fallbackMode: mode || 'edit' }
  )
  const payload = {
    mode: normalized.mode,
    target: normalized.target,
  }
  if (normalized.requestId) payload.requestId = normalized.requestId
  if (normalized.prompt) payload.prompt = normalized.prompt
  if (normalized.error) payload.error = normalized.error
  if (normalized.attachments.length) payload.attachments = normalized.attachments
  if (normalized.context.clientLogs?.length) {
    payload.context = {
      clientLogs: normalized.context.clientLogs,
    }
  }
  if (includeLegacyFields) {
    if (normalized.target.blueprintId) payload.blueprintId = normalized.target.blueprintId
    if (normalized.target.scriptRootId) payload.scriptRootId = normalized.target.scriptRootId
    if (normalized.target.appId) payload.appId = normalized.target.appId
    if (normalized.context.clientLogs?.length) payload.clientLogs = normalized.context.clientLogs
  }
  return payload
}
