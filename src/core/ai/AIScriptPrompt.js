import fs from 'fs'
import path from 'path'

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
    attachmentMap && Object.keys(attachmentMap).length
      ? `Attached files (JSON map path->full text):\n${JSON.stringify(attachmentMap, null, 2)}`
      : null,
    context && Object.keys(context).length ? `Additional context (JSON):\n${JSON.stringify(context, null, 2)}` : null,
    fileMap ? `Current files (JSON map path->content):\n${JSON.stringify(fileMap, null, 2)}` : null,
  ]
    .filter(Boolean)
    .join('\n\n')

  return { systemPrompt, userPrompt }
}
