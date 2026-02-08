import fs from 'fs'
import path from 'path'
import { streamText } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { System } from './System'
import { hashFile } from '../utils-server'
import { isValidScriptPath } from '../blueprintValidation'
import { resolveDocsPath, resolveDocsRoot } from '../ai/DocsSearchService'

const aiDocs = loadAiDocs()
const docsRoot = resolveDocsRoot()
const fencePattern = /^```(?:\w+)?\s*([\s\S]*?)\s*```$/
const DEFAULT_ENTRY = 'index.js'
const BLUEPRINT_NAME_MAX_LENGTH = 80

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

function stripControlChars(value) {
  let output = ''
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code >= 32) output += value[i]
  }
  return output
}

function sanitizeBlueprintIdFromName(name) {
  if (typeof name !== 'string') return ''
  let safe = name.trim()
  if (!safe) return ''
  safe = stripControlChars(safe)
  safe = safe.replace(/[<>:"/\\|?*]/g, '')
  safe = safe.replace(/[^a-zA-Z0-9._ -]+/g, '-')
  safe = safe.replace(/\s+/g, ' ').trim()
  safe = safe.replace(/[. ]+$/g, '').replace(/^[. ]+/g, '')
  safe = safe.replace(/__+/g, '_')
  if (safe.length > BLUEPRINT_NAME_MAX_LENGTH) {
    safe = safe.slice(0, BLUEPRINT_NAME_MAX_LENGTH).trim()
  }
  return safe || ''
}

function resolveUniqueBlueprintId(world, preferredId, currentId = null) {
  const base = sanitizeBlueprintIdFromName(preferredId)
  if (!base) return null
  if (base !== '$scene') {
    const existing = world?.blueprints?.get(base)
    if (!existing || base === currentId) {
      return base
    }
  }
  for (let i = 2; i < 10000; i += 1) {
    const candidate = `${base}_${i}`
    if (candidate === '$scene') continue
    const existing = world?.blueprints?.get(candidate)
    if (!existing || candidate === currentId) {
      return candidate
    }
  }
  return null
}

function getRenamedCreatedAt(currentValue) {
  const ts = Date.parse(currentValue || '')
  if (Number.isFinite(ts)) {
    return new Date(Math.max(0, ts - 1)).toISOString()
  }
  return new Date(Date.now() - 1).toISOString()
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
        const fullPath = resolveDocsPath(attachment.path, docsRoot)
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

  async renameBlueprintFromClassifiedName(currentId, nextName) {
    const current = this.world.blueprints.get(currentId)
    if (!current) return false

    const nextId = resolveUniqueBlueprintId(this.world, nextName, currentId)
    if (!nextId || nextId === currentId) {
      await this.applyBlueprintChange(currentId, { name: nextName })
      return true
    }

    const renamedBlueprint = {
      ...current,
      id: nextId,
      name: nextName,
      createdAt: getRenamedCreatedAt(current.createdAt),
    }
    const addResult = this.world.network.applyBlueprintAdded(renamedBlueprint)
    if (!addResult?.ok) {
      return false
    }

    const entityIds = []
    for (const entity of this.world.entities.items.values()) {
      if (!entity?.isApp) continue
      if (entity.data.blueprint !== currentId) continue
      entityIds.push(entity.data.id)
    }
    for (const entityId of entityIds) {
      const result = await this.world.network.applyEntityModified({ id: entityId, blueprint: nextId })
      if (!result?.ok) {
        console.warn('[ai-create] failed to repoint entity', entityId, result?.error || 'unknown_error')
      }
    }

    const scriptRefIds = []
    for (const blueprint of this.world.blueprints.items.values()) {
      if (!blueprint?.id || blueprint.id === currentId || blueprint.id === nextId) continue
      const ref = typeof blueprint.scriptRef === 'string' ? blueprint.scriptRef.trim() : ''
      if (ref !== currentId) continue
      scriptRefIds.push(blueprint.id)
    }
    for (const blueprintId of scriptRefIds) {
      await this.applyBlueprintChange(blueprintId, { scriptRef: nextId })
    }

    const removeResult = await this.world.network.applyBlueprintRemoved({ id: currentId })
    if (!removeResult?.ok) {
      console.warn(
        '[ai-create] failed to remove previous blueprint id',
        currentId,
        removeResult?.error || 'unknown_error'
      )
    }
    return true
  }

  async classifyName(blueprintId, prompt) {
    if (!this.client) return
    const systemPrompt = buildClassifySystemPrompt()
    const userPrompt = buildClassifyUserPrompt(prompt)
    const raw = await this.client.generate(systemPrompt, userPrompt)
    let name = stripCodeFences(raw).trim()
    name = name.replace(/^["']|["']$/g, '')
    if (!name) return
    const renamed = await this.renameBlueprintFromClassifiedName(blueprintId, name)
    if (!renamed) {
      await this.applyBlueprintChange(blueprintId, { name })
    }
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
