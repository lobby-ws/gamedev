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
    this.threadsByTarget = new Map()
    this.threadSubscribersByTarget = new Map()
    this.docsIndex = []
    this.docsApiUrl = null
    this.docsLoaded = false
    this.docsLoadingPromise = null
    this.docsSubscribers = new Set()
  }

  destroy() {
    this.inFlightByBlueprint.clear()
    this.threadsByTarget.clear()
    this.threadSubscribersByTarget.clear()
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
    if (mode === 'edit' && prompt) {
      this.appendThreadEntry({
        targetBlueprintId,
        scriptRootId: scriptRoot.id,
        requestId,
        type: 'user',
        text: prompt.trim(),
      })
    } else if (mode === 'fix') {
      this.appendThreadEntry({
        targetBlueprintId,
        scriptRootId: scriptRoot.id,
        requestId,
        type: 'user',
        text: 'Fix the current script error.',
      })
    }
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

  getTargetKey = ({ targetBlueprintId, scriptRootId } = {}) => {
    const bp = typeof targetBlueprintId === 'string' && targetBlueprintId ? targetBlueprintId : ''
    const root = typeof scriptRootId === 'string' && scriptRootId ? scriptRootId : ''
    return `${bp}::${root}`
  }

  getThreadForTarget = ({ targetBlueprintId, scriptRootId } = {}) => {
    const key = this.getTargetKey({ targetBlueprintId, scriptRootId })
    return this.threadsByTarget.get(key) || []
  }

  subscribeThread = ({ targetBlueprintId, scriptRootId, onChange } = {}) => {
    if (typeof onChange !== 'function') return () => {}
    const key = this.getTargetKey({ targetBlueprintId, scriptRootId })
    if (!this.threadSubscribersByTarget.has(key)) {
      this.threadSubscribersByTarget.set(key, new Set())
    }
    const subs = this.threadSubscribersByTarget.get(key)
    subs.add(onChange)
    onChange(this.threadsByTarget.get(key) || [])
    return () => {
      subs.delete(onChange)
      if (!subs.size) this.threadSubscribersByTarget.delete(key)
    }
  }

  appendThreadEntry = ({ targetBlueprintId, scriptRootId, requestId, type, text, meta } = {}) => {
    if (!type) return
    const key = this.getTargetKey({ targetBlueprintId, scriptRootId })
    const current = this.threadsByTarget.get(key) || []
    const next = current.concat({
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      requestId: requestId || null,
      type,
      text: typeof text === 'string' ? text : '',
      meta: meta && typeof meta === 'object' ? meta : null,
      createdAt: Date.now(),
    })
    const bounded = next.length > 160 ? next.slice(next.length - 160) : next
    this.threadsByTarget.set(key, bounded)
    this.emitThread(key)
  }

  emitThread = key => {
    const subs = this.threadSubscribersByTarget.get(key)
    if (!subs || !subs.size) return
    const items = this.threadsByTarget.get(key) || []
    for (const callback of subs) {
      callback(items)
    }
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

  onEvent = payload => {
    if (!payload) return
    const targetBlueprintId = typeof payload.targetBlueprintId === 'string' ? payload.targetBlueprintId : null
    const scriptRootId = typeof payload.scriptRootId === 'string' ? payload.scriptRootId : null
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : null
    const type = typeof payload.type === 'string' ? payload.type : ''
    if (!type) return
    if (type === 'session_start') {
      this.appendThreadEntry({
        targetBlueprintId,
        scriptRootId,
        requestId,
        type: 'system',
        text: payload.mode === 'fix' ? 'Started AI fix request.' : 'Started AI edit request.',
      })
      return
    }
    if (type === 'phase') {
      const phase = typeof payload.phase === 'string' ? payload.phase : ''
      const labels = {
        collecting_context: 'Collecting context...',
        thinking: 'Thinking...',
        generating_patch: 'Generating patch...',
        applying: 'Applying changes...',
      }
      this.appendThreadEntry({
        targetBlueprintId,
        scriptRootId,
        requestId,
        type: 'phase',
        text: labels[phase] || phase || 'Working...',
        meta: { phase },
      })
      return
    }
    if (type === 'patch_preview') {
      const files = Array.isArray(payload.files) ? payload.files.filter(Boolean) : []
      const summary = typeof payload.summary === 'string' ? payload.summary.trim() : ''
      const text = summary || `Prepared changes for ${files.length} file${files.length === 1 ? '' : 's'}.`
      this.appendThreadEntry({
        targetBlueprintId,
        scriptRootId,
        requestId,
        type: 'assistant',
        text,
        meta: files.length ? { files } : null,
      })
      return
    }
    if (type === 'apply_result') {
      const message = typeof payload.message === 'string' ? payload.message : ''
      const count = Number.isFinite(payload.fileCount) ? payload.fileCount : 0
      this.appendThreadEntry({
        targetBlueprintId,
        scriptRootId,
        requestId,
        type: payload.ok ? 'success' : 'error',
        text: message || (payload.ok ? `Applied ${count} file change(s).` : 'Apply failed.'),
      })
      return
    }
    if (type === 'assistant_message' || type === 'assistant_delta') {
      const text = typeof payload.text === 'string' ? payload.text : ''
      if (!text) return
      this.appendThreadEntry({
        targetBlueprintId,
        scriptRootId,
        requestId,
        type: 'assistant',
        text,
      })
      return
    }
    if (type === 'error') {
      const message = typeof payload.message === 'string' ? payload.message : 'AI request failed.'
      this.appendThreadEntry({
        targetBlueprintId,
        scriptRootId,
        requestId,
        type: 'error',
        text: message,
      })
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
