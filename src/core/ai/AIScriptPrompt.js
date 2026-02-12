import fs from 'fs'
import path from 'path'
import { MAX_CONTEXT_LOG_ENTRIES, normalizeAiContextLogs } from './AIRequestContract.js'

const MAX_PROMPT_LOG_ARGS = 4
const MAX_PROMPT_LOG_ARG_LENGTH = 160
const MAX_PROMPT_LOG_MESSAGE_LENGTH = 240

const aiDocs = loadAiDocs()

function loadAiDocs() {
  const candidates = [
    path.join(process.cwd(), 'src/client/public/ai-docs.md'),
    path.join(process.cwd(), 'build/public/ai-docs.md'),
    path.join(process.cwd(), 'public/ai-docs.md'),
  ]
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue
      return fs.readFileSync(candidate, 'utf8')
    } catch {
      // continue searching other paths
    }
  }
  return ''
}

function normalizeMode(mode) {
  if (mode === 'create' || mode === 'fix') return mode
  return 'edit'
}

function buildFormatNote({ entryPath, scriptFormat }) {
  if (scriptFormat === 'legacy-body') {
    return `The entry file "${entryPath}" uses legacy-body format. Keep top-level imports, do not add export statements, and keep the entry file as a script body.`
  }
  return `The entry file "${entryPath}" is a standard ES module that must export a default function (world, app, fetch, props, setTimeout) => void.`
}

function buildModeInstruction(mode, entryPath) {
  if (mode === 'create') {
    return [
      'Task: generate new script files for a newly created app from the request.',
      `You must include "${entryPath}" in the files output.`,
      'You may create additional files when useful.',
    ]
  }
  if (mode === 'fix') {
    return [
      'Task: fix the script/runtime issue while preserving intended behavior.',
      'Only include files that changed or were created.',
    ]
  }
  return [
    'Task: apply the requested script edit.',
    'Only include files that changed or were created.',
  ]
}

function truncateString(value, maxLength) {
  if (typeof value !== 'string') return ''
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}...`
}

function normalizePromptLogEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  const timestamp =
    typeof entry.timestamp === 'string' && entry.timestamp ? entry.timestamp : new Date().toISOString()
  const level = typeof entry.level === 'string' && entry.level ? entry.level : 'log'
  const args = Array.isArray(entry.args)
    ? entry.args.slice(0, MAX_PROMPT_LOG_ARGS).map(arg => truncateString(String(arg), MAX_PROMPT_LOG_ARG_LENGTH))
    : []
  const messageSource = typeof entry.message === 'string' && entry.message ? entry.message : args.join(' ')
  const message = truncateString(messageSource, MAX_PROMPT_LOG_MESSAGE_LENGTH)
  return {
    timestamp,
    level,
    args,
    message,
  }
}

function normalizePromptLogs(entries) {
  const normalized = normalizeAiContextLogs(entries)
  return normalized.map(normalizePromptLogEntry).filter(Boolean)
}

function formatPromptLogGroup(title, entries) {
  if (!entries.length) return `${title}: none`
  const lines = [`${title} (oldest to newest):`]
  for (const entry of entries) {
    const prefix = `[${entry.timestamp}] ${entry.level}`
    const argsSuffix = entry.args.length ? ` | args=${JSON.stringify(entry.args)}` : ''
    lines.push(`- ${prefix}: ${entry.message}${argsSuffix}`)
  }
  return lines.join('\n')
}

function buildRuntimeLogsContext(clientLogs, serverLogs) {
  return [
    `Runtime logs (last ${MAX_CONTEXT_LOG_ENTRIES} entries each):`,
    formatPromptLogGroup('Client logs', clientLogs),
    formatPromptLogGroup('Server logs', serverLogs),
  ].join('\n')
}

function splitPromptContext(mode, context) {
  if (!context || typeof context !== 'object') {
    return {
      additionalContext: null,
      clientLogs: [],
      serverLogs: [],
    }
  }
  const additionalContext = { ...context }
  const rawClientLogs = additionalContext.clientLogs
  const rawServerLogs = additionalContext.serverLogs
  delete additionalContext.clientLogs
  delete additionalContext.serverLogs
  const trimmedContext = Object.keys(additionalContext).length ? additionalContext : null
  if (mode !== 'fix') {
    return {
      additionalContext: trimmedContext,
      clientLogs: [],
      serverLogs: [],
    }
  }
  return {
    additionalContext: trimmedContext,
    clientLogs: normalizePromptLogs(rawClientLogs),
    serverLogs: normalizePromptLogs(rawServerLogs),
  }
}

export function buildUnifiedScriptPrompts({
  mode = 'edit',
  prompt = '',
  error = null,
  entryPath = 'index.js',
  scriptFormat = 'module',
  fileMap = null,
  attachmentMap = null,
  context = null,
} = {}) {
  const resolvedMode = normalizeMode(mode)
  const modeInstructions = buildModeInstruction(resolvedMode, entryPath)
  const promptContext = splitPromptContext(resolvedMode, context)
  const runtimeLogsContext =
    resolvedMode === 'fix' ? buildRuntimeLogsContext(promptContext.clientLogs, promptContext.serverLogs) : null
  const systemPrompt = [
    aiDocs ? `${aiDocs}\n\n==============` : null,
    'You are generating script files for a 3D app runtime.',
    'Return JSON only. Do not use markdown or code fences.',
    'Output schema (strict):',
    '{ "summary": "short description", "files": [{ "path": "path", "content": "full file text" }] }',
    'Rules:',
    '- summary must be a short plain-text sentence.',
    '- files must be an array of objects with string path and string content.',
    '- Each listed file must include the full file text.',
    '- Do not delete files by omission.',
    '- Do not include binary data.',
    ...modeInstructions,
    buildFormatNote({ entryPath, scriptFormat }),
  ]
    .filter(Boolean)
    .join('\n')

  const userPrompt = [
    `Mode: ${resolvedMode}`,
    `Entry path: ${entryPath}`,
    `Script format: ${scriptFormat}`,
    resolvedMode === 'fix' ? `Error:\n${JSON.stringify(error, null, 2)}` : `Request: ${prompt}`,
    runtimeLogsContext ? runtimeLogsContext : null,
    attachmentMap && Object.keys(attachmentMap).length
      ? `Attached files (JSON map path->full text):\n${JSON.stringify(attachmentMap, null, 2)}`
      : null,
    promptContext.additionalContext
      ? `Additional context (JSON):\n${JSON.stringify(promptContext.additionalContext, null, 2)}`
      : null,
    fileMap ? `Current files (JSON map path->content):\n${JSON.stringify(fileMap, null, 2)}` : null,
  ]
    .filter(Boolean)
    .join('\n\n')

  return { systemPrompt, userPrompt }
}
