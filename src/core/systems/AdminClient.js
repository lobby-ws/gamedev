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
    this.requireCode = false
  }

  init() {
    this.code = storage.get('adminCode')
  }

  onSnapshot(data) {
    this.adminUrl = normalizeAdminUrl(data.adminUrl) || deriveAdminUrl(data.apiUrl)
    this.requireCode = !!data.hasAdminCode
    this.connect()
  }

  setCode(code) {
    this.code = code
    storage.set('adminCode', code)
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
    this.sendRaw({
      type: 'auth',
      code: this.code,
      networkId: this.world.network?.id || null,
    })
  }

  onMessage = event => {
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch (err) {
      console.error('[admin] invalid message', err)
      return
    }
    if (msg.type === 'auth_ok') {
      this.authenticated = true
      this.flushQueue()
      return
    }
    if (msg.type === 'auth_error') {
      this.error = msg.error || 'auth_error'
      return
    }
    if (msg.type === 'error') {
      this.error = msg.error || 'error'
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
      this.sendRaw(msg)
    }
  }

  sendRaw(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.authenticated) {
      this.sendRaw(msg)
    } else {
      this.queue.push(msg)
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

  blueprintAdd(blueprint, { ignoreNetworkId } = {}) {
    this.send({
      type: 'blueprint_add',
      blueprint,
      networkId: ignoreNetworkId,
    })
  }

  blueprintModify(change, { ignoreNetworkId } = {}) {
    this.send({
      type: 'blueprint_modify',
      change,
      networkId: ignoreNetworkId,
    })
  }
}
