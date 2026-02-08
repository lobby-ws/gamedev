import fs from 'fs'
import path from 'path'
import { streamText } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { System } from './System'
import { isValidScriptPath } from '../blueprintValidation'

function hasScriptFiles(blueprint) {
  return blueprint?.scriptFiles && typeof blueprint.scriptFiles === 'object' && !Array.isArray(blueprint.scriptFiles)
}

function getBlueprintAppName(id) {
  if (typeof id !== 'string' || !id) return ''
  if (id === '$scene') return '$scene'
  const idx = id.indexOf('__')
  return idx === -1 ? id : id.slice(0, idx)
}

function resolveScriptRootBlueprint(blueprint, world) {
  if (!blueprint) return null
  const scriptRef = typeof blueprint.scriptRef === 'string' ? blueprint.scriptRef.trim() : ''
  if (scriptRef) {
    const scriptRoot = world.blueprints.get(scriptRef)
    if (!scriptRoot) return null
    return scriptRoot
  }
  if (hasScriptFiles(blueprint)) return blueprint
  const appName = getBlueprintAppName(blueprint.id)
  if (appName && appName !== blueprint.id) {
    const baseBlueprint = world.blueprints.get(appName)
    if (hasScriptFiles(baseBlueprint)) return baseBlueprint
  }
  return null
}

const aiDocs = loadAiDocs()
const docsRoot = resolveDocsRoot()

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
    } catch (err) {
      // continue searching other paths
    }
  }
  return ''
}

function resolveDocsRoot() {
  const candidates = [
    path.join(process.cwd(), 'docs'),
    path.join(process.cwd(), 'build', 'docs'),
    path.join(process.cwd(), 'public', 'docs'),
  ]
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue
      const stats = fs.statSync(candidate)
      if (stats.isDirectory()) return candidate
    } catch (err) {
      // continue searching other paths
    }
  }
  return null
}

const fencePattern = /^```(?:\w+)?\s*([\s\S]*?)\s*```$/

function stripCodeFences(text) {
  if (!text) return ''
  const cleaned = text.trim()
  const match = cleaned.match(fencePattern)
  if (match) return match[1]
  return cleaned
}

function extractJson(text) {
  const cleaned = stripCodeFences(text).trim()
  if (!cleaned) return null
  try {
    return JSON.parse(cleaned)
  } catch (err) {
    const first = cleaned.indexOf('{')
    const last = cleaned.lastIndexOf('}')
    if (first === -1 || last === -1 || last <= first) return null
    const slice = cleaned.slice(first, last + 1)
    try {
      return JSON.parse(slice)
    } catch (err2) {
      return null
    }
  }
}

function normalizeAiPatchSet(output) {
  if (!output) return null
  const files = Array.isArray(output)
    ? output
    : output.files || output.changes || output.patches
  if (!Array.isArray(files)) return null
  const normalized = []
  for (const entry of files) {
    if (!entry) continue
    const path = entry.path || entry.relPath || entry.file
    const content = entry.content ?? entry.text ?? entry.code ?? entry.nextText
    if (!path || typeof content !== 'string') continue
    normalized.push({ path, content })
  }
  if (!normalized.length) return null
  return {
    summary: typeof output.summary === 'string' ? output.summary : '',
    files: normalized,
  }
}

function normalizeAiAttachments(input) {
  if (!Array.isArray(input)) return []
  const output = []
  const seen = new Set()
  for (const item of input) {
    if (!item) continue
    const type = item.type === 'doc' || item.type === 'script' ? item.type : null
    const filePath = typeof item.path === 'string' ? item.path.trim() : ''
    if (!type || !filePath) continue
    const key = `${type}:${filePath}`
    if (seen.has(key)) continue
    seen.add(key)
    output.push({ type, path: filePath })
    if (output.length >= 12) break
  }
  return output
}

function resolveDocPath(docPath) {
  if (!docsRoot || !docPath) return null
  if (docPath.includes('..')) return null
  const normalized = docPath.replace(/\\/g, '/')
  if (!normalized.startsWith('docs/')) return null
  const rel = normalized.slice('docs/'.length)
  if (!rel) return null
  const ext = path.extname(rel).toLowerCase()
  if (ext !== '.md' && ext !== '.mdx') return null
  const fullPath = path.resolve(docsRoot, rel)
  const rootWithSep = docsRoot.endsWith(path.sep) ? docsRoot : docsRoot + path.sep
  if (!fullPath.startsWith(rootWithSep)) return null
  return fullPath
}

function buildSystemPrompt({ entryPath, scriptFormat }) {
  const formatNote =
    scriptFormat === 'legacy-body'
      ? `The entry file "${entryPath}" uses legacy-body format. It is not a standard module. Keep top-level imports, do not add export statements, and keep the file as a script body.`
      : `The entry file "${entryPath}" is a standard ES module that must export a default function (world, app, fetch, props, setTimeout) => void.`
  return [
    aiDocs ? `${aiDocs}\n\n==============` : null,
    'You are editing a multi-file module script for a 3D app runtime.',
    'Return JSON only. Do not use markdown or code fences.',
    'Output format:',
    '{ "summary": "short description", "files": [{ "path": "path", "content": "full file text" }] }',
    'Rules:',
    '- You may update existing files or create new files.',
    '- Provide full file contents for each changed or new file.',
    '- Do not include unchanged files.',
    '- Do not delete files.',
    formatNote,
  ]
    .filter(Boolean)
    .join('\n')
}

function buildUserPrompt({ mode, prompt, error, entryPath, scriptFormat, fileMap, attachmentMap }) {
  const header = [
    `Entry path: ${entryPath}`,
    `Script format: ${scriptFormat}`,
    `Mode: ${mode}`,
  ]
  if (mode === 'fix') {
    header.push(`Error:\n${JSON.stringify(error, null, 2)}`)
  } else {
    header.push(`Request: ${prompt}`)
  }
  if (attachmentMap && Object.keys(attachmentMap).length) {
    header.push('Attached files (full text):')
    header.push(JSON.stringify(attachmentMap, null, 2))
  }
  header.push('Files (JSON map of path to content):')
  header.push(JSON.stringify(fileMap, null, 2))
  return header.join('\n\n')
}

export class ServerAIScripts extends System {
  constructor(world) {
    super(world)
    this.provider = process.env.AI_PROVIDER || null
    this.model = process.env.AI_MODEL || null
    this.effort = process.env.AI_EFFORT || 'low'
    this.apiKey = process.env.AI_API_KEY || null
    this.client = null
    if (this.provider && this.model && this.apiKey) {
      if (this.provider === 'openai') {
        this.client = new OpenAIClient(this.apiKey, this.model, this.effort)
      } else if (this.provider === 'anthropic') {
        this.client = new AnthropicClient(this.apiKey, this.model)
      } else if (this.provider === 'xai') {
        this.client = new XAIClient(this.apiKey, this.model)
      } else if (this.provider === 'google') {
        this.client = new GoogleClient(this.apiKey, this.model)
      }
    }
    this.enabled = !!this.client
  }

  handleRequest = async (socket, data = {}) => {
    const requestId = data?.requestId || null
    let scriptRootId = typeof data?.scriptRootId === 'string' ? data.scriptRootId : null
    if (!this.enabled) {
      this.sendError(socket, {
        requestId,
        scriptRootId,
        error: 'ai_disabled',
        message: 'AI is not configured on the server.',
      })
      return
    }
    if (!socket?.player?.isBuilder?.()) {
      this.sendError(socket, {
        requestId,
        scriptRootId,
        error: 'builder_required',
        message: 'Builder access required.',
      })
      return
    }
    let blueprint = null
    if (scriptRootId) {
      blueprint = this.world.blueprints.get(scriptRootId)
    }
    if (!blueprint && typeof data?.blueprintId === 'string') {
      blueprint = this.world.blueprints.get(data.blueprintId)
    }
    if (!blueprint && typeof data?.appId === 'string') {
      const app = this.world.entities.get(data.appId)
      blueprint = app?.blueprint || this.world.blueprints.get(app?.data?.blueprint)
    }
    const scriptRoot = resolveScriptRootBlueprint(blueprint, this.world)
    if (!scriptRoot || !hasScriptFiles(scriptRoot)) {
      this.sendError(socket, {
        requestId,
        scriptRootId,
        error: 'script_root_missing',
        message: 'No module script root found.',
      })
      return
    }
    scriptRootId = scriptRoot.id
    const entryPath = scriptRoot.scriptEntry
    if (!entryPath || !isValidScriptPath(entryPath)) {
      this.sendError(socket, {
        requestId,
        scriptRootId,
        error: 'invalid_entry',
        message: 'Invalid script entry.',
      })
      return
    }
    if (!Object.prototype.hasOwnProperty.call(scriptRoot.scriptFiles, entryPath)) {
      this.sendError(socket, {
        requestId,
        scriptRootId,
        error: 'missing_entry',
        message: 'Script entry is missing from script files.',
      })
      return
    }
    const mode = data?.mode === 'fix' ? 'fix' : 'edit'
    const prompt = typeof data?.prompt === 'string' ? data.prompt.trim() : ''
    const error = data?.error || null
    if (mode === 'edit' && !prompt) {
      this.sendError(socket, {
        requestId,
        scriptRootId,
        error: 'missing_prompt',
        message: 'AI edit prompt required.',
      })
      return
    }
    if (mode === 'fix' && !error) {
      this.sendError(socket, {
        requestId,
        scriptRootId,
        error: 'missing_error',
        message: 'AI fix requires an error payload.',
      })
      return
    }
    try {
      const fileMap = await this.loadFileMap(scriptRoot.scriptFiles)
      const scriptFormat = scriptRoot.scriptFormat === 'legacy-body' ? 'legacy-body' : 'module'
      const attachments = normalizeAiAttachments(data?.attachments)
      const attachmentMap = await this.loadAttachmentMap(attachments, fileMap)
      const systemPrompt = buildSystemPrompt({ entryPath, scriptFormat })
      const userPrompt = buildUserPrompt({
        mode,
        prompt,
        error,
        entryPath,
        scriptFormat,
        fileMap,
        attachmentMap,
      })
      const raw = await this.client.generate(systemPrompt, userPrompt)
      const parsed = extractJson(raw)
      const normalized = normalizeAiPatchSet(parsed)
      if (!normalized) {
        throw new Error('invalid_ai_response')
      }
      const files = new Map()
      for (const file of normalized.files) {
        if (!isValidScriptPath(file.path)) continue
        if (!files.has(file.path)) {
          files.set(file.path, file.content)
        }
      }
      const outputFiles = Array.from(files, ([path, content]) => ({ path, content }))
      if (!outputFiles.length) {
        throw new Error('empty_ai_patch')
      }
      const source = this.model ? `${this.provider}:${this.model}` : this.provider || ''
      socket.send('scriptAiProposal', {
        requestId,
        scriptRootId,
        summary: normalized.summary,
        source,
        autoPreview: false,
        autoApply: true,
        files: outputFiles,
      })
    } catch (err) {
      console.log(err)
      console.error('[ai-scripts] request failed', err)
      this.sendError(socket, {
        requestId,
        scriptRootId,
        error: 'ai_request_failed',
        message: 'AI request failed.',
      })
    }
  }

  async loadFileMap(scriptFiles) {
    const paths = Object.keys(scriptFiles).filter(isValidScriptPath).sort()
    const entries = await Promise.all(
      paths.map(async path => {
        const assetUrl = scriptFiles[path]
        const resolved = this.world.resolveURL ? this.world.resolveURL(assetUrl, true) : assetUrl
        if (!this.world.loader?.fetchText) {
          throw new Error('loader_missing')
        }
        const content = await this.world.loader.fetchText(resolved)
        return [path, content]
      })
    )
    const fileMap = {}
    for (const [path, content] of entries) {
      fileMap[path] = content
    }
    return fileMap
  }

  async loadAttachmentMap(attachments, fileMap) {
    const map = {}
    if (!attachments.length) return map
    for (const attachment of attachments) {
      if (!attachment?.path || !attachment?.type) continue
      if (attachment.type === 'script') {
        if (Object.prototype.hasOwnProperty.call(fileMap, attachment.path)) {
          map[attachment.path] = fileMap[attachment.path]
        }
        continue
      }
      if (attachment.type === 'doc') {
        const fullPath = resolveDocPath(attachment.path)
        if (!fullPath) continue
        try {
          const content = await fs.promises.readFile(fullPath, 'utf8')
          map[attachment.path] = content
        } catch (err) {
          // ignore unreadable doc
        }
      }
    }
    return map
  }

  sendError(socket, { requestId, scriptRootId, error, message }) {
    socket?.send?.('scriptAiProposal', {
      requestId,
      scriptRootId,
      error,
      message,
    })
  }
}

class OpenAIClient {
  constructor(apiKey, model, effort) {
    this.model = model
    this.effort = effort
    this.provider = createOpenAI({ apiKey })
  }

  async generate(systemPrompt, userPrompt) {
    const result = streamText({
      model: this.provider(this.model),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      providerOptions: {
        openai: {
          reasoningEffort: this.effort || undefined,
        },
      },
    })
    let output = ''
    for await (const delta of result.textStream) {
      output += delta
    }
    return output
  }
}

class AnthropicClient {
  constructor(apiKey, model) {
    this.model = model
    this.maxOutputTokens = 8192
    this.provider = createAnthropic({ apiKey })
  }

  async generate(systemPrompt, userPrompt) {
    const result = streamText({
      model: this.provider(this.model),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      maxOutputTokens: this.maxOutputTokens,
    })
    let output = ''
    for await (const delta of result.textStream) {
      output += delta
    }
    return output
  }
}
