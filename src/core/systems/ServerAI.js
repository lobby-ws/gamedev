import fs from 'fs'
import path from 'path'
import { streamText } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { System } from './System'
import { hashFile } from '../utils-server'
import { isValidScriptPath } from '../blueprintValidation'

const aiDocs = loadAiDocs()
const docsRoot = resolveDocsRoot()
const fencePattern = /^```(?:\w+)?\s*([\s\S]*?)\s*```$/
const DEFAULT_ENTRY = 'index.js'

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
    } catch {
      // continue searching other paths
    }
  }
  return null
}

function stripCodeFences(text) {
  if (!text) return ''
  const cleaned = text.trim()
  const match = cleaned.match(fencePattern)
  if (match) return match[1]
  return cleaned
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

function buildCreateSystemPrompt({ entryPath, scriptFormat }) {
  const formatNote =
    scriptFormat === 'module'
      ? `The entry file "${entryPath}" is a standard ES module that must export a default function (world, app, fetch, props, setTimeout) => void.`
      : `The entry file "${entryPath}" uses legacy-body format. Keep top-level imports, do not add export statements, and output a script body.`
  return [
    aiDocs ? `${aiDocs}\n\n==============` : null,
    'You are an artist and code generator for Hyperfy app scripts.',
    'Return raw JavaScript only. Do not use markdown or code fences.',
    formatNote,
  ]
    .filter(Boolean)
    .join('\n')
}

function buildCreateUserPrompt({ prompt, attachmentMap, entryPath, scriptFormat }) {
  const parts = [
    `Entry path: ${entryPath}`,
    `Script format: ${scriptFormat}`,
    `Request: ${prompt}`,
  ]
  if (attachmentMap && Object.keys(attachmentMap).length) {
    parts.push('Attached files (full text):')
    parts.push(JSON.stringify(attachmentMap, null, 2))
  }
  return parts.join('\n\n')
}

function buildClassifySystemPrompt() {
  return [
    'You are a classifier.',
    'Return a short, descriptive name for the object.',
    'Examples: "Gamer Desk", "Oak Table", "Neon Sign".',
  ].join('\n')
}

function buildClassifyUserPrompt(prompt) {
  return `Please classify the following prompt:\n\n"${prompt}"`
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class ServerAI extends System {
  constructor(world) {
    super(world)
    this.assets = null
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

  serialize() {
    return {
      enabled: this.enabled,
      provider: this.provider,
      model: this.model,
      effort: this.effort,
    }
  }

  async init({ assets }) {
    this.assets = assets
  }

  async loadAttachmentMap(attachments, scriptFiles) {
    const map = {}
    if (!attachments.length) return map
    for (const attachment of attachments) {
      if (!attachment?.path || !attachment?.type) continue
      if (attachment.type === 'script') {
        if (!scriptFiles || !this.world.loader?.fetchText) continue
        const assetUrl = scriptFiles[attachment.path]
        if (!assetUrl) continue
        try {
          const resolved = this.world.resolveURL ? this.world.resolveURL(assetUrl, true) : assetUrl
          const content = await this.world.loader.fetchText(resolved)
          map[attachment.path] = content
        } catch {
          // ignore unreadable script
        }
        continue
      }
      if (attachment.type === 'doc') {
        const fullPath = resolveDocPath(attachment.path)
        if (!fullPath) continue
        try {
          const content = await fs.promises.readFile(fullPath, 'utf8')
          map[attachment.path] = content
        } catch {
          // ignore unreadable doc
        }
      }
    }
    return map
  }

  handleCreate = async (socket, data = {}) => {
    if (!this.enabled || !this.client) return
    if (!socket?.player?.isBuilder?.()) return
    const prompt = typeof data?.prompt === 'string' ? data.prompt.trim() : ''
    if (!prompt) return
    const blueprintId = typeof data?.blueprintId === 'string' ? data.blueprintId : ''
    if (!blueprintId) return

    const blueprint = await this.waitForBlueprint(blueprintId)
    if (!blueprint) {
      console.warn('[ai-create] blueprint not found', blueprintId)
      return
    }
    if (!this.assets?.upload) {
      console.warn('[ai-create] assets unavailable')
      return
    }

    const entryPath = isValidScriptPath(blueprint?.scriptEntry) ? blueprint.scriptEntry : DEFAULT_ENTRY
    const scriptFormat = blueprint?.scriptFormat === 'legacy-body' ? 'legacy-body' : 'module'
    const attachments = normalizeAiAttachments(data?.attachments)
    let contextFiles = null
    const scriptRootId = typeof data?.scriptRootId === 'string' ? data.scriptRootId.trim() : ''
    if (scriptRootId) {
      const contextRoot = resolveScriptRootBlueprint(this.world.blueprints.get(scriptRootId), this.world)
      if (contextRoot && hasScriptFiles(contextRoot)) {
        contextFiles = contextRoot.scriptFiles
      }
    }
    const attachmentMap = await this.loadAttachmentMap(attachments, contextFiles)
    const systemPrompt = buildCreateSystemPrompt({ entryPath, scriptFormat })
    const userPrompt = buildCreateUserPrompt({
      prompt,
      attachmentMap,
      entryPath,
      scriptFormat,
    })
    const raw = await this.client.generate(systemPrompt, userPrompt)
    const output = stripCodeFences(raw)
    if (!output.trim()) {
      console.warn('[ai-create] empty response')
      return
    }

    const hash = await hashFile(Buffer.from(output, 'utf8'))
    const filename = `${hash}.js`
    const scriptUrl = `asset://${filename}`
    const file = new File([output], 'script.js', { type: 'text/javascript' })
    await this.assets.upload(file)
    const nextScriptFiles = hasScriptFiles(blueprint) ? { ...blueprint.scriptFiles } : {}
    nextScriptFiles[entryPath] = scriptUrl
    await this.applyBlueprintChange(blueprintId, {
      script: scriptUrl,
      scriptEntry: entryPath,
      scriptFiles: nextScriptFiles,
      scriptFormat,
    })

    this.classifyName(blueprintId, prompt).catch(err => {
      console.warn('[ai-create] classify failed', err?.message || err)
    })
  }

  async waitForBlueprint(id, attempts = 5) {
    for (let i = 0; i < attempts; i += 1) {
      const blueprint = this.world.blueprints.get(id)
      if (blueprint) return blueprint
      await sleep(200)
    }
    return null
  }

  async applyBlueprintChange(id, updates) {
    const blueprint = this.world.blueprints.get(id)
    if (!blueprint) return null
    const change = { id, version: blueprint.version + 1, ...updates }
    const result = this.world.network.applyBlueprintModified(change)
    if (!result.ok && result.current) {
      const retry = { id, version: result.current.version + 1, ...updates }
      this.world.network.applyBlueprintModified(retry)
    }
    return change
  }

  async classifyName(blueprintId, prompt) {
    if (!this.client) return
    const systemPrompt = buildClassifySystemPrompt()
    const userPrompt = buildClassifyUserPrompt(prompt)
    const raw = await this.client.generate(systemPrompt, userPrompt)
    let name = stripCodeFences(raw).trim()
    name = name.replace(/^["']|["']$/g, '')
    if (!name) return
    await this.applyBlueprintChange(blueprintId, { name })
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
    this.maxOutputTokens = 4096
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

class XAIClient {
  constructor(apiKey, model) {
    this.apiKey = apiKey
    this.model = model
    this.url = 'https://api.x.ai/v1/chat/completions'
  }

  async generate(systemPrompt, userPrompt) {
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    })
    if (!resp.ok) {
      throw new Error(`xai_request_failed:${resp.status}`)
    }
    const data = await resp.json()
    return data.choices?.[0]?.message?.content || ''
  }
}

class GoogleClient {
  constructor(apiKey, model) {
    this.apiKey = apiKey
    this.url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
  }

  async generate(systemPrompt, userPrompt) {
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        system_instruction: { parts: { text: systemPrompt } },
        contents: [
          {
            role: 'user',
            parts: [{ text: userPrompt }],
          },
        ],
      }),
    })
    if (!resp.ok) {
      throw new Error(`google_request_failed:${resp.status}`)
    }
    const data = await resp.json()
    return data.candidates?.[0]?.content?.parts?.[0]?.text || ''
  }
}
