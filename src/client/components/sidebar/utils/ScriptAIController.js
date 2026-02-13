import { uuid } from '../../../../core/utils'
import { isValidScriptPath } from '../../../../core/blueprintValidation'
import { buildScriptGroups, getScriptGroupMain } from '../../../../core/extras/blueprintGroups'
import { getBlueprintAppName } from '../../../../core/blueprintUtils'

export function hasScriptFiles(blueprint) {
  return blueprint?.scriptFiles && typeof blueprint.scriptFiles === 'object' && !Array.isArray(blueprint.scriptFiles)
}

export function resolveScriptRootBlueprint(blueprint, world) {
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
  const groupMain = getScriptGroupMain(buildScriptGroups(world.blueprints.items), blueprint)
  if (groupMain && hasScriptFiles(groupMain)) return groupMain
  return null
}

function resolveScriptRootForApp(app, world) {
  if (!app) return null
  const blueprint = app.blueprint || world.blueprints.get(app.data?.blueprint)
  return resolveScriptRootBlueprint(blueprint, world)
}

function normalizeAttachments(input) {
  if (!Array.isArray(input)) return null
  const output = []
  const seen = new Set()
  for (const item of input) {
    if (!item) continue
    const type = item.type === 'doc' || item.type === 'script' ? item.type : null
    const path = typeof item.path === 'string' ? item.path.trim() : ''
    if (!type || !path) continue
    const key = `${type}:${path}`
    if (seen.has(key)) continue
    seen.add(key)
    output.push({ type, path })
    if (output.length >= 12) break
  }
  return output.length ? output : null
}

export class ScriptAIController {
  constructor(world) {
    this.world = world
    this.inFlightByBlueprint = new Map()
    this.docsIndex = []
    this.docsApiUrl = null
    this.docsLoaded = false
    this.docsLoadingPromise = null
    this.docsSubscribers = new Set()
  }

  destroy() {
    this.inFlightByBlueprint.clear()
    this.docsSubscribers.clear()
    this.docsLoadingPromise = null
  }

  requestEdit = ({ prompt, app, attachments } = {}) => {
    return this.request({ mode: 'edit', prompt, app, attachments })
  }

  requestFix = ({ error, app, attachments } = {}) => {
    return this.request({ mode: 'fix', error, app, attachments })
  }

  request = ({ mode = 'edit', prompt, error, app, scriptRootId, attachments } = {}) => {
    if (this.world.isAdminClient) {
      this.world.emit('toast', 'AI script requests are not available on admin connections.')
      return null
    }
    if (!this.world.network?.send) return null
    if (!this.world.builder?.canBuild?.()) {
      this.world.emit('toast', 'Builder access required.')
      return null
    }
    let targetApp = app || this.world.ui?.state?.app
    if (!targetApp) {
      targetApp = this.world.builder?.getEntityAtReticle?.() || null
    }
    const targetBlueprint =
      targetApp?.blueprint ||
      this.world.blueprints.get(targetApp?.data?.blueprint) ||
      (scriptRootId ? this.world.blueprints.get(scriptRootId) : null)
    let scriptRoot = null
    if (scriptRootId) {
      const blueprint = this.world.blueprints.get(scriptRootId)
      scriptRoot = resolveScriptRootBlueprint(blueprint, this.world)
    } else if (targetApp) {
      scriptRoot = resolveScriptRootForApp(targetApp, this.world)
    }
    if (!scriptRoot || !hasScriptFiles(scriptRoot)) {
      this.world.emit('toast', 'No module script root found for this app.')
      return null
    }
    const targetBlueprintId = targetBlueprint?.id || scriptRoot.id
    if (!targetBlueprintId) {
      this.world.emit('toast', 'No script target found for this app.')
      return null
    }
    if (this.inFlightByBlueprint.has(targetBlueprintId)) {
      this.world.emit('toast', 'AI request already in progress for this app.')
      return null
    }
    const entryPath = scriptRoot.scriptEntry
    if (!entryPath || !isValidScriptPath(entryPath)) {
      this.world.emit('toast', 'Invalid script entry for AI request.')
      return null
    }
    if (!Object.prototype.hasOwnProperty.call(scriptRoot.scriptFiles, entryPath)) {
      this.world.emit('toast', 'Script entry missing from module files.')
      return null
    }
    let requestError = error
    if (mode === 'fix') {
      if (!requestError && targetApp?.scriptError) {
        requestError = targetApp.scriptError
      }
      if (!requestError) {
        this.world.emit('toast', 'No script error available to fix.')
        return null
      }
    } else {
      requestError = null
      if (!prompt || !prompt.trim()) {
        this.world.emit('toast', 'AI edit prompt required.')
        return null
      }
    }
    const requestId = uuid()
    const payload = {
      requestId,
      scriptRootId: scriptRoot.id,
      targetBlueprintId,
      mode,
      prompt: prompt || null,
      error: requestError || null,
    }
    const normalizedAttachments = normalizeAttachments(attachments)
    if (normalizedAttachments) {
      payload.attachments = normalizedAttachments
    }
    if (targetApp?.data?.id) {
      payload.appId = targetApp.data.id
    }
    this.inFlightByBlueprint.set(targetBlueprintId, {
      requestId,
      scriptRootId: scriptRoot.id,
      startedAt: Date.now(),
    })
    this.world.emit?.('script-ai-pending', {
      scriptRootId: scriptRoot.id,
      targetBlueprintId,
      requestId,
      pending: true,
    })
    this.world.network.send('scriptAiRequest', payload)
    this.world.emit?.('script-ai-request', payload)
    return requestId
  }

  isBlueprintPending = blueprintId => {
    if (typeof blueprintId !== 'string' || !blueprintId) return false
    return this.inFlightByBlueprint.has(blueprintId)
  }

  isRootPending = scriptRootId => {
    if (typeof scriptRootId !== 'string' || !scriptRootId) return false
    for (const pending of this.inFlightByBlueprint.values()) {
      if (pending?.scriptRootId === scriptRootId) return true
    }
    return false
  }

  getPendingForTarget = ({ targetBlueprintId, scriptRootId } = {}) => {
    if (targetBlueprintId) return this.isBlueprintPending(targetBlueprintId)
    if (scriptRootId) return this.isRootPending(scriptRootId)
    return false
  }

  subscribeTarget = ({ targetBlueprintId, scriptRootId, onRequest, onPending, onResponse } = {}) => {
    const matchesTarget = payload => {
      if (!payload) return false
      const payloadBlueprintId = typeof payload.targetBlueprintId === 'string' ? payload.targetBlueprintId : null
      if (targetBlueprintId && payloadBlueprintId) {
        return payloadBlueprintId === targetBlueprintId
      }
      const payloadRootId = typeof payload.scriptRootId === 'string' ? payload.scriptRootId : null
      if (scriptRootId && payloadRootId) {
        return payloadRootId === scriptRootId
      }
      return true
    }
    const handleRequest = payload => {
      if (!matchesTarget(payload)) return
      onRequest?.(payload)
    }
    const handlePending = payload => {
      if (!matchesTarget(payload)) return
      onPending?.(payload)
    }
    const handleResponse = payload => {
      if (!matchesTarget(payload)) return
      onResponse?.(payload)
    }
    this.world.on?.('script-ai-request', handleRequest)
    this.world.on?.('script-ai-pending', handlePending)
    this.world.on?.('script-ai-response', handleResponse)
    return () => {
      this.world.off?.('script-ai-request', handleRequest)
      this.world.off?.('script-ai-pending', handlePending)
      this.world.off?.('script-ai-response', handleResponse)
    }
  }

  getDocsIndex = () => this.docsIndex

  subscribeDocsIndex = callback => {
    if (typeof callback !== 'function') return () => {}
    this.docsSubscribers.add(callback)
    callback(this.docsIndex)
    this.ensureDocsIndex()
    return () => {
      this.docsSubscribers.delete(callback)
    }
  }

  ensureDocsIndex = async () => {
    const apiUrl = this.world.network?.apiUrl || null
    if (!apiUrl) {
      this.docsApiUrl = null
      this.docsLoaded = true
      if (this.docsIndex.length) {
        this.docsIndex = []
        this.emitDocsIndex()
      }
      return this.docsIndex
    }
    if (this.docsLoadingPromise && this.docsApiUrl === apiUrl) {
      return this.docsLoadingPromise
    }
    if (this.docsLoaded && this.docsApiUrl === apiUrl) {
      return this.docsIndex
    }
    this.docsApiUrl = apiUrl
    this.docsLoaded = false
    const load = async () => {
      try {
        const response = await fetch(`${apiUrl}/ai-docs-index`)
        if (!response.ok) throw new Error('docs_index_failed')
        const data = await response.json()
        const files = Array.isArray(data?.files) ? data.files.filter(Boolean) : []
        this.docsIndex = files
      } catch (err) {
        this.docsIndex = []
      } finally {
        this.docsLoaded = true
        this.docsLoadingPromise = null
        this.emitDocsIndex()
      }
      return this.docsIndex
    }
    this.docsLoadingPromise = load()
    return this.docsLoadingPromise
  }

  emitDocsIndex = () => {
    for (const callback of this.docsSubscribers) {
      callback(this.docsIndex)
    }
  }

  onProposal = payload => {
    if (!payload) return
    const scriptRootId = typeof payload.scriptRootId === 'string' ? payload.scriptRootId : null
    const targetBlueprintId = typeof payload.targetBlueprintId === 'string' ? payload.targetBlueprintId : null
    let clearedBlueprintId = targetBlueprintId
    if (targetBlueprintId) {
      this.inFlightByBlueprint.delete(targetBlueprintId)
    } else if (payload.requestId) {
      for (const [blueprintId, pending] of this.inFlightByBlueprint.entries()) {
        if (pending?.requestId === payload.requestId) {
          this.inFlightByBlueprint.delete(blueprintId)
          clearedBlueprintId = blueprintId
          break
        }
      }
    }
    if (!clearedBlueprintId && scriptRootId) {
      for (const [blueprintId, pending] of this.inFlightByBlueprint.entries()) {
        if (pending?.scriptRootId === scriptRootId) {
          this.inFlightByBlueprint.delete(blueprintId)
          clearedBlueprintId = blueprintId
          break
        }
      }
    }
    if (scriptRootId || clearedBlueprintId) {
      this.world.emit?.('script-ai-pending', {
        scriptRootId,
        targetBlueprintId: clearedBlueprintId,
        requestId: payload.requestId || null,
        pending: false,
      })
    }
    const response = {
      requestId: payload.requestId || null,
      scriptRootId,
      targetBlueprintId: clearedBlueprintId,
      error: payload.error || null,
      message: payload.message || null,
      summary: typeof payload.summary === 'string' ? payload.summary : '',
      source: typeof payload.source === 'string' ? payload.source : '',
      fileCount:
        Number.isFinite(payload.fileCount) && payload.fileCount >= 0
          ? payload.fileCount
          : Array.isArray(payload.files)
            ? payload.files.length
            : 0,
      applied: payload.applied !== false,
      forked: payload.forked === true,
      appliedScriptRootId: typeof payload.appliedScriptRootId === 'string' ? payload.appliedScriptRootId : null,
    }
    this.world.emit?.('script-ai-response', response)
    if (payload.error) {
      const message = payload.message || payload.error || 'AI request failed.'
      this.world.emit('toast', message)
      return
    }
    const successMessage = payload.message || 'AI changes applied.'
    this.world.emit('toast', successMessage)
  }
}
