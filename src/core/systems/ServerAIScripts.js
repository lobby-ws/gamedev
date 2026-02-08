import fs from 'fs'
import { System } from './System'
import { createServerAIRunner, readServerAIConfig } from './ServerAIRunner'
import { isValidScriptPath } from '../blueprintValidation'
import { MAX_CONTEXT_LOG_ENTRIES, normalizeAiContextLogs, normalizeAiRequest } from '../ai/AIRequestContract'
import { DocsSearchService, resolveDocsPath, resolveDocsRoot } from '../ai/DocsSearchService'
import { buildUnifiedScriptPrompts } from '../ai/AIScriptPrompt'
import { parseAiScriptResponse } from '../ai/AIScriptResponse'
import { createSearchDocsTool } from '../ai/SearchDocsTool'

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

const docsRoot = resolveDocsRoot()
const ANTHROPIC_MAX_OUTPUT_TOKENS = 8192
const AI_TOOL_LOOP_BUDGETS = Object.freeze({
  maxSteps: 4,
  maxToolCalls: 4,
  timeoutMs: 20_000,
})
const DOCS_TOOL_LIMITS = Object.freeze({
  maxQueryChars: 240,
  maxResults: 6,
  maxExcerptChars: 420,
  maxResponseChars: 9_000,
})

function buildFixPromptContext(context, serverLogs) {
  const baseContext = context && typeof context === 'object' ? { ...context } : {}
  delete baseContext.clientLogs
  delete baseContext.serverLogs

  const clientLogs = normalizeAiContextLogs(context?.clientLogs)
  const normalizedServerLogs = normalizeAiContextLogs(serverLogs)
  if (clientLogs.length) {
    baseContext.clientLogs = clientLogs
  }
  if (normalizedServerLogs.length) {
    baseContext.serverLogs = normalizedServerLogs
  }
  return baseContext
}

export class ServerAIScripts extends System {
  constructor(world) {
    super(world)
    const aiConfig = readServerAIConfig()
    this.provider = aiConfig.provider
    this.model = aiConfig.model
    this.effort = aiConfig.effort
    this.apiKey = aiConfig.apiKey
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
    this.tools = searchDocsTool
      ? {
          searchDocs: searchDocsTool,
        }
      : null
    this.enabled = !!this.client
  }

  getRecentServerLogs(appId, limit = 20) {
    if (typeof this.world.scripts?.getRecentServerLogs !== 'function') return []
    return this.world.scripts.getRecentServerLogs(appId, limit)
  }

  handleRequest = async (socket, data = {}) => {
    const request = normalizeAiRequest(data, { fallbackMode: 'edit' })
    const requestId = request.requestId
    let scriptRootId = request.target.scriptRootId || null
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
    if (!blueprint && request.target.blueprintId) {
      blueprint = this.world.blueprints.get(request.target.blueprintId)
    }
    if (!blueprint && request.target.appId) {
      const app = this.world.entities.get(request.target.appId)
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
    const mode = request.mode === 'fix' ? 'fix' : 'edit'
    const prompt = request.prompt
    const error = request.error || null
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
    const appId = request.target.appId || null
    const serverLogs =
      mode === 'fix' && appId ? this.getRecentServerLogs(appId, MAX_CONTEXT_LOG_ENTRIES) : []
    const promptContext = mode === 'fix' ? buildFixPromptContext(request.context, serverLogs) : null
    try {
      const fileMap = await this.loadFileMap(scriptRoot.scriptFiles)
      const scriptFormat = scriptRoot.scriptFormat === 'legacy-body' ? 'legacy-body' : 'module'
      const attachments = request.attachments
      const attachmentMap = await this.loadAttachmentMap(attachments, fileMap)
      const { systemPrompt, userPrompt } = buildUnifiedScriptPrompts({
        mode,
        prompt,
        error,
        entryPath,
        scriptFormat,
        fileMap,
        attachmentMap,
        context: promptContext,
      })
      const generation = await this.client.generate(systemPrompt, userPrompt, {
        ...AI_TOOL_LOOP_BUDGETS,
        tools: this.tools,
      })
      this.logGenerationTelemetry(generation, { requestId, mode, scriptRootId })
      const raw = generation.text
      const normalized = parseAiScriptResponse(raw, { validatePath: isValidScriptPath })
      if (!normalized) {
        throw new Error('invalid_ai_response')
      }
      const outputFiles = normalized.files
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
        const fullPath = resolveDocsPath(attachment.path, docsRoot)
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

  logGenerationTelemetry(generation, extra = {}) {
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
    console.info('[ai-scripts] generation', telemetry)
  }
}
