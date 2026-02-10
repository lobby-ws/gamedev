import { System } from './System'
import { uuid } from '../utils'
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

export class ClientAIScripts extends System {
  constructor(world) {
    super(world)
    this.inFlightByBlueprint = new Map()
  }

  init() {
    // no-op
  }

  destroy() {
    this.inFlightByBlueprint.clear()
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

  onProposal = payload => {
    if (!payload) return
    const scriptRootId = typeof payload.scriptRootId === 'string' ? payload.scriptRootId : null
    const targetBlueprintId =
      typeof payload.targetBlueprintId === 'string' ? payload.targetBlueprintId : null
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
      appliedScriptRootId:
        typeof payload.appliedScriptRootId === 'string' ? payload.appliedScriptRootId : null,
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
