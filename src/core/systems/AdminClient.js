import { readPacket, writePacket } from '../packets'
import { storage } from '../storage'
import { hashFile } from '../utils-client'
import { System } from './System'

function normalizeAdminUrl(url) {
  if (!url) return null
  return url.replace(/\/admin\/?$/, '')
}

function deriveAdminUrl(apiUrl) {
  if (!apiUrl) return null
  return normalizeAdminUrl(apiUrl.replace(/\/api\/?$/, ''))
}

function joinUrl(base, path) {
  return `${base.replace(/\/$/, '')}${path}`
}

function toWsUrl(baseUrl) {
  const wsBase = baseUrl.replace(/^http/, 'ws')
  return joinUrl(wsBase, '/admin')
}

export class AdminClient extends System {
  constructor(world) {
    super(world)
    this.ws = null
    this.adminUrl = null
    this.connected = false
    this.authenticated = false
    this.error = null
    this.queue = []
    this.code = null
    this.deployLockToken = null
    this.deployLockScope = null
    this.requireCode = false
  }

  init({ adminUrl, requireAdminCode } = {}) {
    this.code = storage.get('adminCode')
    if (adminUrl) {
      this.adminUrl = normalizeAdminUrl(adminUrl)
      this.requireCode = !!requireAdminCode
      this.connect()
    }
  }

  onSnapshot(data) {
    this.adminUrl = normalizeAdminUrl(data.adminUrl) || deriveAdminUrl(data.apiUrl)
    this.requireCode = !!data.hasAdminCode
    this.connect()
  }

  setCode(code) {
    this.code = code
    storage.set('adminCode', code)
    this.world.emit('admin-code', code)
    this.error = null
    this.disconnect()
    this.connect()
  }

  connect() {
    if (this.ws || !this.adminUrl) return
    if (this.requireCode && !this.code) {
      this.error = 'missing_code'
      return
    }
    const wsUrl = toWsUrl(this.adminUrl)
    this.ws = new WebSocket(wsUrl)
    this.ws.binaryType = 'arraybuffer'
    this.ws.addEventListener('open', this.onOpen)
    this.ws.addEventListener('message', this.onMessage)
    this.ws.addEventListener('close', this.onClose)
    this.ws.addEventListener('error', this.onError)
  }

  disconnect() {
    if (!this.ws) return
    this.ws.removeEventListener('open', this.onOpen)
    this.ws.removeEventListener('message', this.onMessage)
    this.ws.removeEventListener('close', this.onClose)
    this.ws.removeEventListener('error', this.onError)
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close()
    }
    this.ws = null
    this.connected = false
    this.authenticated = false
  }

  onOpen = () => {
    this.connected = true
    this.authenticated = false
    this.error = null
    this.sendPacket('adminAuth', {
      code: this.code,
      subscriptions: { snapshot: false, players: false, runtime: false },
      networkId: this.world.network?.id || null,
    })
  }

  onMessage = event => {
    const [method, data] = readPacket(event.data)
    if (!method) return
    if (method === 'onAdminAuthOk') {
      this.authenticated = true
      this.flushQueue()
      return
    }
    if (method === 'onAdminAuthError') {
      this.error = data?.error || 'auth_error'
      return
    }
    if (method === 'onAdminResult' && data && data.ok === false) {
      this.error = data.error || 'error'
      return
    }
  }

  onClose = () => {
    this.connected = false
    this.authenticated = false
    this.ws = null
  }

  onError = () => {
    this.error = 'connection_error'
  }

  flushQueue() {
    if (!this.authenticated) return
    while (this.queue.length) {
      const msg = this.queue.shift()
      this.sendPacket('adminCommand', msg)
    }
  }

  sendPacket(name, payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(writePacket(name, payload))
    }
  }

  send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.authenticated) {
      this.sendPacket('adminCommand', payload)
    } else {
      this.queue.push(payload)
      this.connect()
    }
  }

  async upload(file) {
    if (!this.adminUrl) throw new Error('admin_url_missing')
    if (this.requireCode && !this.code) throw new Error('admin_code_missing')
    const hash = await hashFile(file)
    const ext = file.name.split('.').pop().toLowerCase()
    const filename = `${hash}.${ext}`
    const headers = this.code ? { 'X-Admin-Code': this.code } : undefined
    const checkUrl = joinUrl(this.adminUrl, `/admin/upload-check?filename=${encodeURIComponent(filename)}`)
    const checkResp = await fetch(checkUrl, { headers })
    if (checkResp.status === 403) throw new Error('admin_required')
    const data = await checkResp.json()
    if (data.exists) return
    const form = new FormData()
    form.append('file', file)
    const uploadUrl = joinUrl(this.adminUrl, '/admin/upload')
    const uploadResp = await fetch(uploadUrl, { method: 'POST', body: form, headers })
    if (!uploadResp.ok) throw new Error('upload_failed')
  }

  getDeployHeaders() {
    const headers = {}
    if (this.code) headers['X-Admin-Code'] = this.code
    return Object.keys(headers).length > 0 ? headers : undefined
  }

  async acquireDeployLock({ owner, ttl, scope } = {}) {
    if (!this.adminUrl) throw new Error('admin_url_missing')
    if (this.requireCode && !this.code) throw new Error('admin_code_missing')
    const headers = this.getDeployHeaders() || {}
    const payload = {}
    if (owner) payload.owner = owner
    if (ttl) payload.ttl = ttl
    if (scope) payload.scope = scope
    const res = await fetch(joinUrl(this.adminUrl, '/admin/deploy-lock'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(payload),
    })
    if (res.status === 403) {
      const error = new Error('admin_required')
      error.code = 'admin_required'
      throw error
    }
    if (res.status === 409) {
      let data = null
      try {
        data = await res.json()
      } catch {}
      const code = data?.error || 'locked'
      const error = new Error(code)
      error.code = code
      error.lock = data?.lock
      throw error
    }
    if (!res.ok) {
      const error = new Error('deploy_lock_failed')
      error.code = 'deploy_lock_failed'
      throw error
    }
    const data = await res.json()
    this.deployLockToken = data?.token || null
    this.deployLockScope = scope || null
    return data
  }

  async releaseDeployLock(token, scope) {
    if (!this.adminUrl) throw new Error('admin_url_missing')
    if (this.requireCode && !this.code) throw new Error('admin_code_missing')
    const lockToken = token || this.deployLockToken
    if (!lockToken) return { ok: true }
    const lockScope = scope || this.deployLockScope
    const payload = { token: lockToken }
    if (lockScope) payload.scope = lockScope
    const headers = this.getDeployHeaders() || {}
    const res = await fetch(joinUrl(this.adminUrl, '/admin/deploy-lock'), {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(payload),
    })
    if (res.status === 403) {
      const error = new Error('admin_required')
      error.code = 'admin_required'
      throw error
    }
    if (!res.ok) {
      let data = null
      try {
        data = await res.json()
      } catch {}
      const code = data?.error || 'deploy_lock_release_failed'
      const error = new Error(code)
      error.code = code
      throw error
    }
    if (lockToken === this.deployLockToken) {
      this.deployLockToken = null
      this.deployLockScope = null
    }
    try {
      return await res.json()
    } catch {
      return { ok: true }
    }
  }

  blueprintAdd(blueprint, { ignoreNetworkId, lockToken } = {}) {
    this.send({
      type: 'blueprint_add',
      blueprint,
      networkId: ignoreNetworkId,
      lockToken,
    })
  }

  blueprintModify(change, { ignoreNetworkId, lockToken } = {}) {
    this.send({
      type: 'blueprint_modify',
      change,
      networkId: ignoreNetworkId,
      lockToken,
    })
  }

  async blueprintRemove(id) {
    if (!this.adminUrl) throw new Error('admin_url_missing')
    if (this.requireCode && !this.code) throw new Error('admin_code_missing')
    const headers = this.code ? { 'X-Admin-Code': this.code } : undefined
    const url = joinUrl(this.adminUrl, `/admin/blueprints/${encodeURIComponent(id)}`)
    const res = await fetch(url, { method: 'DELETE', headers })
    if (res.status === 403) throw new Error('admin_required')
    if (!res.ok) {
      let error = null
      try {
        const data = await res.json()
        error = data?.error || null
      } catch {}
      throw new Error(error || `blueprint_remove_failed:${res.status}`)
    }
    try {
      return await res.json()
    } catch {
      return { ok: true }
    }
  }

  entityAdd(entity, { ignoreNetworkId } = {}) {
    this.send({
      type: 'entity_add',
      entity,
      networkId: ignoreNetworkId,
    })
  }

  entityModify(change, { ignoreNetworkId } = {}) {
    this.send({
      type: 'entity_modify',
      change,
      networkId: ignoreNetworkId,
    })
  }

  entityRemove(id, { ignoreNetworkId } = {}) {
    this.send({
      type: 'entity_remove',
      id,
      networkId: ignoreNetworkId,
    })
  }

  settingsModify({ key, value }, { ignoreNetworkId } = {}) {
    this.send({
      type: 'settings_modify',
      key,
      value,
      networkId: ignoreNetworkId,
    })
  }

  spawnModify(op, { networkId } = {}) {
    const targetId = networkId || this.world.network?.id || null
    this.send({
      type: 'spawn_modify',
      op,
      networkId: targetId,
    })
  }

  modifyRank(playerId, rank) {
    this.send({
      type: 'modify_rank',
      playerId,
      rank,
    })
  }

  kick(playerId) {
    this.send({
      type: 'kick',
      playerId,
    })
  }

  mute(playerId, muted) {
    this.send({
      type: 'mute',
      playerId,
      muted,
    })
  }
}
