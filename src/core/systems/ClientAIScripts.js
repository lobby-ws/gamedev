import { System } from './System'
import { uuid } from '../utils'
import { isValidScriptPath } from '../blueprintValidation'
import { buildUnifiedAiRequestPayload } from '../ai/AIRequestContract'

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

export class ClientAIScripts extends System {
  constructor(world) {
    super(world)
    this.pendingByRoot = new Map()
  }

  init() {
    this.world.on('ui', this.onUi)
  }

  destroy() {
    this.world.off('ui', this.onUi)
    this.pendingByRoot.clear()
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
    const appId = targetApp?.data?.id || null
    let clientLogs = null
    if (mode === 'fix' && appId) {
      const entries = this.world.appLogs?.getEntries?.(appId)
      if (Array.isArray(entries) && entries.length) {
        clientLogs = entries
      }
    }
    const requestPrompt = mode === 'edit' ? prompt.trim() : ''
    const payload = buildUnifiedAiRequestPayload({
      requestId,
      mode,
      prompt: requestPrompt,
      error: requestError || null,
      target: {
        scriptRootId: scriptRoot.id,
        blueprintId: scriptRoot.id,
        appId,
      },
      attachments,
      clientLogs,
      includeLegacyFields: true,
    })
    this.world.network.send('scriptAiRequest', payload)
    this.world.emit?.('script-ai-request', payload)
    return requestId
  }

  onProposal = payload => {
    if (!payload) return
    const response = {
      requestId: payload.requestId || null,
      scriptRootId: typeof payload.scriptRootId === 'string' ? payload.scriptRootId : null,
      error: payload.error || null,
      message: payload.message || null,
      summary: typeof payload.summary === 'string' ? payload.summary : '',
      source: typeof payload.source === 'string' ? payload.source : '',
      fileCount: Array.isArray(payload.files) ? payload.files.length : 0,
    }
    this.world.emit?.('script-ai-response', response)
    if (payload.error) {
      const message = payload.message || payload.error || 'AI request failed.'
      this.world.emit('toast', message)
      return
    }
    const scriptRootId = typeof payload.scriptRootId === 'string' ? payload.scriptRootId : null
    const api = this.world.ui?.scriptEditorAI
    const activeRoot = resolveScriptRootForApp(this.world.ui?.state?.app, this.world)
    const activeRootId = activeRoot?.id || null
    if (api?.proposeChanges && (!scriptRootId || scriptRootId === activeRootId)) {
      api.proposeChanges(payload)
      return
    }
    if (scriptRootId) {
      this.pendingByRoot.set(scriptRootId, payload)
    } else {
      const fallbackId = payload.requestId || `pending-${Date.now()}`
      this.pendingByRoot.set(fallbackId, payload)
    }
    this.world.emit('toast', 'AI changes ready. Open the Script pane to review.')
  }

  onUi = () => {
    if (!this.pendingByRoot.size) return
    const api = this.world.ui?.scriptEditorAI
    if (!api?.proposeChanges) return
    const activeRoot = resolveScriptRootForApp(this.world.ui?.state?.app, this.world)
    const activeRootId = activeRoot?.id
    if (!activeRootId) return
    const pending = this.pendingByRoot.get(activeRootId)
    if (!pending) return
    this.pendingByRoot.delete(activeRootId)
    api.proposeChanges(pending)
  }
}
