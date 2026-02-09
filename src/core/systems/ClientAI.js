import { System } from './System'

function normalizePrompt(value) {
  if (typeof value !== 'string') return ''
  return value.trim()
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

export class ClientAI extends System {
  constructor(world) {
    super(world)
    this.enabled = false
    this.provider = null
    this.model = null
    this.effort = null
  }

  deserialize(data) {
    if (!data || typeof data !== 'object') {
      this.enabled = false
      this.provider = null
      this.model = null
      this.effort = null
      return
    }
    this.enabled = !!data.enabled
    this.provider = data.provider || null
    this.model = data.model || null
    this.effort = data.effort || null
  }

  createFromPrompt = async input => {
    const payload = typeof input === 'string' ? { prompt: input } : input || {}
    const trimmed = normalizePrompt(payload.prompt)
    if (!trimmed) {
      const err = new Error('missing_prompt')
      err.code = 'missing_prompt'
      throw err
    }
    if (!this.enabled) {
      const err = new Error('ai_disabled')
      err.code = 'ai_disabled'
      throw err
    }

    const normalizedAttachments = normalizeAttachments(payload.attachments)
    const scriptRootId = typeof payload.scriptRootId === 'string' ? payload.scriptRootId.trim() : ''

    if (!this.world.drafts?.createDraftApp) {
      const err = new Error('drafts_unavailable')
      err.code = 'drafts_unavailable'
      throw err
    }
    const promptPreview = trimmed.length > 100 ? `${trimmed.slice(0, 100)}...` : trimmed
    const result = await this.world.drafts.createDraftApp({
      name: 'AI Draft',
      props: {
        prompt: promptPreview,
      },
    })
    const request = {
      blueprintId: result.blueprintId,
      appId: result.appId,
      prompt: trimmed,
    }
    if (normalizedAttachments) {
      request.attachments = normalizedAttachments
    }
    if (scriptRootId) {
      request.scriptRootId = scriptRootId
    }
    this.world.network.send('aiCreateRequest', request)
    return result
  }
}
