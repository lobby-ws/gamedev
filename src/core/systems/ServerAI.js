import fs from 'fs'
import { System } from './System'
import { createServerAIRunner, readServerAIConfig } from './ServerAIRunner'
import { hashFile } from '../utils-server'
import { isValidScriptPath } from '../blueprintValidation'
import { DocsSearchService, resolveDocsPath, resolveDocsRoot } from '../ai/DocsSearchService'
import { normalizeAiRequest } from '../ai/AIRequestContract'
import { buildUnifiedScriptPrompts } from '../ai/AIScriptPrompt'
import { parseAiScriptResponse } from '../ai/AIScriptResponse'
import { createSearchDocsTool } from '../ai/SearchDocsTool'

const docsRoot = resolveDocsRoot()
const DEFAULT_ENTRY = 'index.js'
const BLUEPRINT_NAME_MAX_LENGTH = 80
const ANTHROPIC_MAX_OUTPUT_TOKENS = 4096
const AI_TOOL_LOOP_BUDGETS = Object.freeze({
  maxSteps: 10,
  maxToolCalls: 4,
  timeoutMs: 45_000,
})
const DOCS_TOOL_LIMITS = Object.freeze({
  maxQueryChars: 240,
  maxResults: 6,
  maxExcerptChars: 420,
  maxResponseChars: 9_000,
})
const codeFencePattern = /^```(?:\w+)?\s*([\s\S]*?)\s*```$/

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

function stripCodeFences(text) {
  if (!text) return ''
  const cleaned = String(text).trim()
  const match = cleaned.match(codeFencePattern)
  if (match) return match[1]
  return cleaned
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

function getUploadFilename(relPath, hash) {
  const value = typeof relPath === 'string' ? relPath : ''
  const slash = value.lastIndexOf('/')
  const base = slash === -1 ? value : value.slice(slash + 1)
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 && dot < base.length - 1 ? base.slice(dot) : '.js'
  return `${hash}${ext}`
}

export class ServerAI extends System {
  constructor(world) {
    super(world)
    this.assets = null
    const aiConfig = readServerAIConfig()
    this.provider = aiConfig.provider
    this.model = aiConfig.model
    this.effort = aiConfig.effort
    this.apiKey = aiConfig.apiKey
    this.toolLoopEnabled = !!aiConfig.toolLoopEnabled
    this.client = createServerAIRunner(aiConfig, {
      anthropicMaxOutputTokens: ANTHROPIC_MAX_OUTPUT_TOKENS,
    })
    this.docsSearch = new DocsSearchService({
      docsRoot,
      ...DOCS_TOOL_LIMITS,
    })
    const searchDocsTool = createSearchDocsTool({
      docsSearch: this.docsSearch,
      limits: DOCS_TOOL_LIMITS,
    })
    this.tools = this.toolLoopEnabled && searchDocsTool
      ? {
          searchDocs: searchDocsTool,
        }
      : null
    this.enabled = !!this.client
  }

  serialize() {
    return {
      enabled: this.enabled,
      provider: this.provider,
      model: this.model,
      effort: this.effort,
      toolLoopEnabled: this.toolLoopEnabled,
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

  async uploadGeneratedFiles(files) {
    const uploaded = {}
    for (const file of files) {
      if (!file?.path || typeof file.content !== 'string') continue
      const hash = await hashFile(Buffer.from(file.content, 'utf8'))
      const filename = getUploadFilename(file.path, hash)
      const scriptUrl = `asset://${filename}`
      const upload = new File([file.content], filename, { type: 'text/javascript' })
      await this.assets.upload(upload)
      uploaded[file.path] = scriptUrl
    }
    return uploaded
  }

  handleCreate = async (socket, data = {}) => {
    if (!this.enabled || !this.client) return
    if (!socket?.player?.isBuilder?.()) return
    const request = normalizeAiRequest(data, { fallbackMode: 'create' })
    const prompt = request.prompt
    if (!prompt) return
    const blueprintId = request.target.blueprintId || ''
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

    try {
      const entryPath = isValidScriptPath(blueprint?.scriptEntry) ? blueprint.scriptEntry : DEFAULT_ENTRY
      const scriptFormat = blueprint?.scriptFormat === 'legacy-body' ? 'legacy-body' : 'module'
      const attachments = request.attachments
      let contextFiles = null
      const scriptRootId = request.target.scriptRootId || ''
      if (scriptRootId) {
        const contextRoot = resolveScriptRootBlueprint(this.world.blueprints.get(scriptRootId), this.world)
        if (contextRoot && hasScriptFiles(contextRoot)) {
          contextFiles = contextRoot.scriptFiles
        }
      }
      const attachmentMap = await this.loadAttachmentMap(attachments, contextFiles)
      const { systemPrompt, userPrompt } = buildUnifiedScriptPrompts({
        mode: 'create',
        prompt,
        entryPath,
        scriptFormat,
        attachmentMap,
      })
      const generation = await this.client.generate(systemPrompt, userPrompt, {
        ...AI_TOOL_LOOP_BUDGETS,
        tools: this.tools,
      })
      this.logGenerationTelemetry('ai-create', generation, { mode: 'create', blueprintId })
      const raw = generation.text
      let parsed = parseAiScriptResponse(raw, { validatePath: isValidScriptPath })
      if (!parsed?.files?.length) {
        const fallback = stripCodeFences(raw).trim()
        if (fallback) {
          parsed = {
            summary: '',
            files: [{ path: entryPath, content: fallback }],
          }
        }
      }
      if (!parsed?.files?.length) {
        console.warn('[ai-create] invalid ai response')
        return
      }
      const generatedScriptFiles = await this.uploadGeneratedFiles(parsed.files)
      const generatedPaths = Object.keys(generatedScriptFiles)
      if (!generatedPaths.length) {
        console.warn('[ai-create] no generated files')
        return
      }
      const entryScriptUrl =
        generatedScriptFiles[entryPath] || generatedScriptFiles[generatedPaths[0]]
      const nextScriptFiles = hasScriptFiles(blueprint) ? { ...blueprint.scriptFiles } : {}
      for (const [relPath, url] of Object.entries(generatedScriptFiles)) {
        nextScriptFiles[relPath] = url
      }
      if (!nextScriptFiles[entryPath] && entryScriptUrl) {
        nextScriptFiles[entryPath] = entryScriptUrl
      }
      await this.applyBlueprintChange(blueprintId, {
        script: nextScriptFiles[entryPath] || entryScriptUrl || blueprint.script,
        scriptEntry: entryPath,
        scriptFiles: nextScriptFiles,
        scriptFormat,
      })

      this.classifyName(blueprintId, prompt).catch(err => {
        console.warn('[ai-create] classify failed', err?.message || err)
      })
    } catch (err) {
      console.error('[ai-create] request failed', err)
    }
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
    const generation = await this.client.generate(systemPrompt, userPrompt, {
      timeoutMs: 10_000,
      maxSteps: 1,
      maxToolCalls: 1,
    })
    const raw = generation.text
    let name = stripCodeFences(raw).trim()
    name = name.replace(/^["']|["']$/g, '')
    if (!name) return
    const renamed = await this.renameBlueprintFromClassifiedName(blueprintId, name)
    if (!renamed) {
      await this.applyBlueprintChange(blueprintId, { name })
    }
  }

  logGenerationTelemetry(prefix, generation, extra = {}) {
    if (!generation || typeof generation !== 'object') return
    const telemetry = {
      finishReason: generation.finishReason || 'unknown',
      steps: Number.isFinite(generation.stepCount) ? generation.stepCount : 1,
      toolCalls: Number.isFinite(generation.toolCallCount) ? generation.toolCallCount : 0,
    }
    for (const [key, value] of Object.entries(extra)) {
      if (value == null || value === '') continue
      telemetry[key] = value
    }
    console.info(`[${prefix}] generation`, telemetry)
  }
}
