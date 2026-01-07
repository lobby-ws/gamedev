import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { EventEmitter } from 'events'
import { uuid } from './utils.js'

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function normalizeBaseUrl(url) {
  if (!url) return ''
  return url.replace(/\/+$/, '')
}

function toWsUrl(httpUrl) {
  const url = normalizeBaseUrl(httpUrl)
  if (url.startsWith('ws://') || url.startsWith('wss://')) return url
  if (url.startsWith('https://')) return `wss://${url.slice('https://'.length)}`
  if (url.startsWith('http://')) return `ws://${url.slice('http://'.length)}`
  return `ws://${url}`
}

function joinUrl(base, pathname) {
  const a = normalizeBaseUrl(base)
  const b = (pathname || '').replace(/^\/+/, '')
  return `${a}/${b}`
}

function extractAssetFilename(url) {
  if (typeof url !== 'string') return null
  if (!url.startsWith('asset://')) return null
  return url.slice('asset://'.length)
}

function isHashedAssetFilename(filename) {
  const ext = path.extname(filename)
  if (!ext) return false
  const base = filename.slice(0, -ext.length)
  return /^[a-f0-9]{64}$/i.test(base)
}

function sanitizeFileBaseName(name) {
  const trimmed = (name || '').toString().trim()
  const base = trimmed.replace(/[^a-zA-Z0-9._ -]+/g, '-').replace(/\s+/g, ' ').trim()
  if (!base) return 'file'
  return base
}

function sanitizeDirName(name) {
  const base = sanitizeFileBaseName(name)
  return base.replace(/[. ]+$/g, '').replace(/^[. ]+/g, '') || 'app'
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function listSubdirs(dirPath) {
  if (!fs.existsSync(dirPath)) return []
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
}

function isDirEmpty(dirPath) {
  return listSubdirs(dirPath).length === 0
}

class WorldAdminClient extends EventEmitter {
  constructor({ worldUrl, adminCode }) {
    super()
    this.worldUrl = normalizeBaseUrl(worldUrl)
    this.adminCode = adminCode || null
    this.ws = null
    this.pending = new Map()
  }

  get httpBase() {
    return this.worldUrl
  }

  get wsBase() {
    return toWsUrl(this.worldUrl)
  }

  get wsAdminUrl() {
    return joinUrl(this.wsBase, '/admin')
  }

  adminHeaders() {
    if (!this.adminCode) return {}
    return { 'X-Admin-Code': this.adminCode }
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsAdminUrl)
      this.ws = ws

      const onOpen = () => {
        ws.send(JSON.stringify({ type: 'auth', code: this.adminCode }))
      }

      const onMessage = event => {
        let msg
        try {
          msg = JSON.parse(event.data)
        } catch {
          return
        }

        if (msg?.type === 'auth_ok') {
          cleanup()
          this._attachListeners(ws)
          resolve()
          return
        }

        if (msg?.type === 'auth_error') {
          cleanup()
          reject(new Error(msg.error || 'auth_error'))
        }
      }

      const onError = err => {
        cleanup()
        reject(err instanceof Error ? err : new Error('ws_error'))
      }

      const onClose = () => {
        cleanup()
        reject(new Error('ws_closed'))
      }

      const cleanup = () => {
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('message', onMessage)
        ws.removeEventListener('error', onError)
        ws.removeEventListener('close', onClose)
      }

      ws.addEventListener('open', onOpen)
      ws.addEventListener('message', onMessage)
      ws.addEventListener('error', onError)
      ws.addEventListener('close', onClose)
    })
  }

  _attachListeners(ws) {
    ws.addEventListener('message', event => {
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }

      const requestId = msg?.requestId
      if (requestId && (msg.type === 'ok' || msg.type === 'error')) {
        const pending = this.pending.get(requestId)
        if (!pending) return
        this.pending.delete(requestId)
        if (msg.type === 'ok') {
          pending.resolve(msg)
        } else {
          const err = new Error(msg.error || 'error')
          err.code = msg.error
          err.current = msg.current
          pending.reject(err)
        }
        return
      }

      this.emit('message', msg)
    })

    ws.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error('ws_closed'))
      }
      this.pending.clear()
      this.emit('disconnect')
    })
  }

  request(type, payload = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('not_connected'))
    }
    const requestId = uuid()
    const message = { type, requestId, ...payload }
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject })
      this.ws.send(JSON.stringify(message))
    })
  }

  async getSnapshot() {
    const res = await fetch(joinUrl(this.httpBase, '/admin/snapshot'), {
      headers: this.adminHeaders(),
    })
    if (!res.ok) {
      throw new Error(`snapshot_failed:${res.status}`)
    }
    return res.json()
  }

  async getBlueprint(id) {
    const res = await fetch(joinUrl(this.httpBase, `/admin/blueprints/${encodeURIComponent(id)}`), {
      headers: this.adminHeaders(),
    })
    if (!res.ok) {
      throw new Error(`blueprint_failed:${res.status}`)
    }
    const data = await res.json()
    return data.blueprint
  }

  async uploadAsset({ filename, buffer, mimeType }) {
    const check = await fetch(joinUrl(this.httpBase, `/admin/upload-check?filename=${encodeURIComponent(filename)}`), {
      headers: this.adminHeaders(),
    })
    if (!check.ok) {
      throw new Error(`upload_check_failed:${check.status}`)
    }
    const { exists } = await check.json()
    if (exists) return { ok: true, filename, exists: true }

    const form = new FormData()
    const file = new File([buffer], filename, { type: mimeType || 'application/octet-stream' })
    form.set('file', file)

    const upload = await fetch(joinUrl(this.httpBase, '/admin/upload'), {
      method: 'POST',
      headers: this.adminHeaders(),
      body: form,
    })
    if (!upload.ok) {
      throw new Error(`upload_failed:${upload.status}`)
    }
    return upload.json()
  }
}

export class DirectAppServer {
  constructor({ worldUrl, adminCode, rootDir = process.cwd() }) {
    this.rootDir = rootDir
    this.worldUrl = normalizeBaseUrl(worldUrl)
    this.adminCode = adminCode || null
    this.appsDir = path.join(this.rootDir, 'apps')
    this.assetsDir = path.join(this.rootDir, 'assets')
    this.worldFile = path.join(this.rootDir, 'world.json')

    this.client = new WorldAdminClient({ worldUrl: this.worldUrl, adminCode: this.adminCode })
    this.deployTimers = new Map()
    this.pendingWrites = new Set()
    this.watchers = new Map()
    this.reconnecting = false

    this.assetsUrl = null
  }

  async start() {
    ensureDir(this.appsDir)
    ensureDir(this.assetsDir)

    await this.client.connect()
    const snapshot = await this.client.getSnapshot()
    this.assetsUrl = snapshot.assetsUrl

    await this._reconcileFromSnapshot(snapshot, { force: isDirEmpty(this.appsDir) })
    this._startWatchers()
    this._attachRemoteHandlers()
    this.client.on('disconnect', () => {
      this._startReconnectLoop()
    })
    console.log(`✅ Connected to ${this.worldUrl} (/admin)`)
  }

  async _startReconnectLoop() {
    if (this.reconnecting) return
    this.reconnecting = true
    let delay = 500
    while (this.reconnecting) {
      try {
        console.warn(`⚠️  Disconnected from ${this.worldUrl}, reconnecting...`)
        await this.client.connect()
        const snapshot = await this.client.getSnapshot()
        this.assetsUrl = snapshot.assetsUrl
        await this._reconcileFromSnapshot(snapshot, { force: false })
        console.log(`✅ Reconnected to ${this.worldUrl} (/admin)`)
        this.reconnecting = false
        return
      } catch (err) {
        await sleep(delay)
        delay = Math.min(delay * 2, 10000)
      }
    }
  }

  _loadWorldState() {
    const state = readJson(this.worldFile)
    if (!state || typeof state !== 'object') {
      return { worldUrl: this.worldUrl, assetsUrl: this.assetsUrl, blueprints: {} }
    }
    state.blueprints = state.blueprints && typeof state.blueprints === 'object' ? state.blueprints : {}
    if (state.worldUrl !== this.worldUrl) state.worldUrl = this.worldUrl
    if (this.assetsUrl) state.assetsUrl = this.assetsUrl
    return state
  }

  _saveWorldState(state) {
    writeJson(this.worldFile, state)
  }

  _chooseAppName(worldState, blueprint) {
    const preferred = sanitizeDirName(blueprint.name || blueprint.id || 'app')
    const taken = new Set(Object.values(worldState.blueprints).map(v => v?.appName).filter(Boolean))
    if (!taken.has(preferred) && !fs.existsSync(path.join(this.appsDir, preferred))) return preferred

    const idPrefix = (blueprint.id || '').replace(/[^a-zA-Z0-9]+/g, '').slice(0, 6) || 'bp'
    const withSuffix = `${preferred}__${idPrefix}`
    if (!taken.has(withSuffix) && !fs.existsSync(path.join(this.appsDir, withSuffix))) return withSuffix

    for (let n = 2; n < 10000; n += 1) {
      const candidate = `${withSuffix}_${n}`
      if (!taken.has(candidate) && !fs.existsSync(path.join(this.appsDir, candidate))) return candidate
    }
    throw new Error(`failed_to_allocate_app_name:${withSuffix}`)
  }

  async _reconcileFromSnapshot(snapshot, { force } = {}) {
    const worldState = this._loadWorldState()
    const blueprints = Array.isArray(snapshot.blueprints) ? snapshot.blueprints : []

    for (const blueprint of blueprints) {
      if (!blueprint?.id) continue
      const existing = worldState.blueprints[blueprint.id]
      const appName = existing?.appName || this._chooseAppName(worldState, blueprint)
      worldState.blueprints[blueprint.id] = { appName, version: blueprint.version }
      await this._writeBlueprintToDisk({ appName, blueprint, force })
    }

    this._saveWorldState(worldState)
  }

  async _writeBlueprintToDisk({ appName, blueprint, force }) {
    const appPath = path.join(this.appsDir, appName)
    ensureDir(appPath)

    const blueprintPath = path.join(appPath, 'blueprint.json')
    const shouldWriteBlueprint = force || !fs.existsSync(blueprintPath)
    if (shouldWriteBlueprint) {
      const localBlueprint = await this._blueprintToLocalDefaults(appName, blueprint)
      this._writeFileAtomic(blueprintPath, JSON.stringify(localBlueprint, null, 2) + '\n')
    }

    const scriptPath = path.join(appPath, 'index.js')
    const shouldWriteScript = force || !fs.existsSync(scriptPath)
    if (shouldWriteScript) {
      const script = await this._downloadScript(blueprint.script)
      this._writeFileAtomic(scriptPath, script)
    }
  }

  async _downloadScript(scriptUrl) {
    if (!scriptUrl) return ''
    if (!scriptUrl.startsWith('asset://')) {
      return typeof scriptUrl === 'string' ? scriptUrl : ''
    }
    const filename = extractAssetFilename(scriptUrl)
    if (!filename) return ''
    const res = await fetch(joinUrl(this.assetsUrl, filename))
    if (!res.ok) {
      throw new Error(`script_download_failed:${res.status}`)
    }
    return res.text()
  }

  async _blueprintToLocalDefaults(appName, blueprint) {
    const output = {}
    output.name = blueprint.name || appName
    if (blueprint.author != null) output.author = blueprint.author
    if (blueprint.url != null) output.url = blueprint.url
    if (blueprint.desc != null) output.desc = blueprint.desc
    if (blueprint.preload != null) output.preload = blueprint.preload
    if (blueprint.public != null) output.public = blueprint.public
    if (blueprint.locked != null) output.locked = blueprint.locked
    if (blueprint.unique != null) output.unique = blueprint.unique
    if (blueprint.disabled != null) output.disabled = blueprint.disabled

    if (typeof blueprint.model === 'string') {
      output.model = await this._maybeDownloadAsset(appName, blueprint.model, `${appName}${path.extname(blueprint.model) || '.glb'}`)
    }

    if (blueprint.image && typeof blueprint.image === 'object') {
      const img = { ...blueprint.image }
      if (typeof img.url === 'string') {
        const ext = path.extname(img.url) || '.png'
        img.url = await this._maybeDownloadAsset(appName, img.url, `${appName}__image${ext}`)
      }
      output.image = img
    } else if (blueprint.image == null) {
      output.image = null
    } else {
      output.image = blueprint.image
    }

    if (blueprint.props && typeof blueprint.props === 'object') {
      const props = {}
      for (const [key, value] of Object.entries(blueprint.props)) {
        if (value && typeof value === 'object' && typeof value.url === 'string') {
          const v = { ...value }
          const ext = path.extname(v.url) || ''
          const suggested = sanitizeFileBaseName(v.name || key) + ext
          v.url = await this._maybeDownloadAsset(appName, v.url, suggested)
          props[key] = v
        } else {
          props[key] = value
        }
      }
      output.props = props
    } else {
      output.props = {}
    }

    return output
  }

  async _maybeDownloadAsset(appName, url, suggestedName) {
    if (typeof url !== 'string') return url
    if (url.startsWith('assets/')) return url
    if (!url.startsWith('asset://')) return url

    const filename = extractAssetFilename(url)
    if (!filename) return url

    const ext = path.extname(filename).toLowerCase()
    const expectedHash = isHashedAssetFilename(filename) ? filename.slice(0, -ext.length).toLowerCase() : null

    const res = await fetch(joinUrl(this.assetsUrl, filename))
    if (!res.ok) {
      throw new Error(`asset_download_failed:${res.status}`)
    }
    const buffer = Buffer.from(await res.arrayBuffer())
    const hash = sha256(buffer)
    if (expectedHash && hash !== expectedHash) {
      throw new Error(`asset_hash_mismatch:${filename}`)
    }

    const base = sanitizeFileBaseName(path.basename(suggestedName, ext) || `${appName}${ext}`)
    for (let idx = 0; idx < 10000; idx += 1) {
      const suffix = idx === 0 ? '' : `_${idx}`
      const candidate = `${base}${suffix}${ext}`
      const relPath = path.posix.join('assets', candidate)
      const absPath = path.join(this.rootDir, relPath)
      if (!fs.existsSync(absPath)) {
        this._writeFileAtomic(absPath, buffer)
        return relPath
      }
      const existingHash = sha256(fs.readFileSync(absPath))
      if (existingHash === hash) return relPath
    }
    throw new Error(`failed_to_allocate_asset_name:${base}${ext}`)
  }

  _writeFileAtomic(filePath, content) {
    this.pendingWrites.add(filePath)
    ensureDir(path.dirname(filePath))
    const tmpPath = `${filePath}.tmp-${uuid()}`
    if (Buffer.isBuffer(content)) {
      fs.writeFileSync(tmpPath, content)
    } else {
      fs.writeFileSync(tmpPath, content, 'utf8')
    }
    fs.renameSync(tmpPath, filePath)
    setTimeout(() => this.pendingWrites.delete(filePath), 500)
  }

  _attachRemoteHandlers() {
    this.client.on('message', async msg => {
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'blueprintAdded' && msg.blueprint?.id) {
        await this._onRemoteBlueprint(msg.blueprint)
      }
      if (msg.type === 'blueprintModified' && msg.blueprint?.id) {
        await this._onRemoteBlueprint(msg.blueprint)
      }
    })
  }

  async _onRemoteBlueprint(blueprint) {
    const worldState = this._loadWorldState()
    const existing = worldState.blueprints[blueprint.id]
    const appName = existing?.appName || this._chooseAppName(worldState, blueprint)
    const prevVersion = existing?.version
    if (typeof prevVersion === 'number' && typeof blueprint.version === 'number' && blueprint.version <= prevVersion) {
      return
    }
    worldState.blueprints[blueprint.id] = { appName, version: blueprint.version }
    this._saveWorldState(worldState)
    await this._writeBlueprintToDisk({ appName, blueprint, force: true })
    this._ensureAppWatchers(appName)
  }

  _startWatchers() {
    this._watchAppsDir()
    this._watchAssetsDir()
    for (const appName of listSubdirs(this.appsDir)) {
      this._ensureAppWatchers(appName)
    }
  }

  _watchAppsDir() {
    if (this.watchers.has('appsDir')) return
    const watcher = fs.watch(this.appsDir, { recursive: false }, (eventType, filename) => {
      if (eventType !== 'rename' || !filename) return
      const abs = path.join(this.appsDir, filename)
      if (!fs.existsSync(abs)) return
      if (!fs.statSync(abs).isDirectory()) return
      this._ensureAppWatchers(filename)
    })
    this.watchers.set('appsDir', watcher)
  }

  _watchAssetsDir() {
    if (this.watchers.has('assetsDir')) return
    const watcher = fs.watch(this.assetsDir, { recursive: false }, (eventType, filename) => {
      if (eventType !== 'change' || !filename) return
      const rel = path.posix.join('assets', filename)
      this._onAssetChanged(rel)
    })
    this.watchers.set('assetsDir', watcher)
  }

  _ensureAppWatchers(appName) {
    this._watchFile(path.join(this.appsDir, appName, 'index.js'), () => this._scheduleDeploy(appName))
    this._watchFile(path.join(this.appsDir, appName, 'index.ts'), () => this._scheduleDeploy(appName))
    this._watchFile(path.join(this.appsDir, appName, 'blueprint.json'), () => this._scheduleDeploy(appName))
  }

  _watchFile(filePath, onChange) {
    if (this.watchers.has(filePath)) return
    if (!fs.existsSync(filePath)) return
    const watcher = fs.watch(filePath, eventType => {
      if (eventType !== 'change') return
      if (this.pendingWrites.has(filePath)) return
      onChange()
    })
    this.watchers.set(filePath, watcher)
  }

  _onAssetChanged(assetRelPath) {
    const worldState = this._loadWorldState()
    const apps = new Set(Object.values(worldState.blueprints).map(v => v?.appName).filter(Boolean))
    for (const appName of apps) {
      const blueprintPath = path.join(this.appsDir, appName, 'blueprint.json')
      const cfg = readJson(blueprintPath)
      if (!cfg || typeof cfg !== 'object') continue
      if (cfg.model === assetRelPath) {
        this._scheduleDeploy(appName)
        continue
      }
      if (cfg.image && typeof cfg.image === 'object' && cfg.image.url === assetRelPath) {
        this._scheduleDeploy(appName)
        continue
      }
      const props = cfg.props && typeof cfg.props === 'object' ? cfg.props : {}
      for (const value of Object.values(props)) {
        if (value && typeof value === 'object' && value.url === assetRelPath) {
          this._scheduleDeploy(appName)
          break
        }
      }
    }
  }

  _scheduleDeploy(appName) {
    if (this.deployTimers.has(appName)) {
      clearTimeout(this.deployTimers.get(appName))
    }
    const timer = setTimeout(() => {
      this.deployTimers.delete(appName)
      this._deployApp(appName).catch(err => {
        console.error(`❌ Deploy failed for ${appName}:`, err?.message || err)
      })
    }, 750)
    this.deployTimers.set(appName, timer)
  }

  _findBlueprintIdForApp(worldState, appName) {
    for (const [id, info] of Object.entries(worldState.blueprints || {})) {
      if (info?.appName === appName) return id
    }
    return null
  }

  async _deployApp(appName) {
    const worldState = this._loadWorldState()
    const blueprintId = this._findBlueprintIdForApp(worldState, appName)
    if (!blueprintId) return

    const appPath = path.join(this.appsDir, appName)
    const blueprintPath = path.join(appPath, 'blueprint.json')
    const cfg = readJson(blueprintPath) || {}

    const scriptPathJs = path.join(appPath, 'index.js')
    const scriptPathTs = path.join(appPath, 'index.ts')
    const scriptPath = fs.existsSync(scriptPathTs) ? scriptPathTs : scriptPathJs
    const scriptText = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : ''
    const scriptHash = sha256(Buffer.from(scriptText, 'utf8'))
    const scriptFilename = `${scriptHash}.js`
    await this.client.uploadAsset({ filename: scriptFilename, buffer: Buffer.from(scriptText, 'utf8'), mimeType: 'text/javascript' })
    const scriptUrl = `asset://${scriptFilename}`

    const resolved = await this._resolveLocalBlueprintToAssetUrls(cfg)
    resolved.id = blueprintId
    resolved.script = scriptUrl

    const attempt = async version => {
      resolved.version = version
      await this.client.request('blueprint_modify', { change: resolved })
      const updated = await this.client.getBlueprint(blueprintId)
      worldState.blueprints[blueprintId] = { appName, version: updated.version }
      this._saveWorldState(worldState)
    }

    const currentVersion = typeof worldState.blueprints?.[blueprintId]?.version === 'number' ? worldState.blueprints[blueprintId].version : null
    const nextVersion = typeof currentVersion === 'number' ? currentVersion + 1 : 1
    try {
      await attempt(nextVersion)
    } catch (err) {
      if (err?.code !== 'version_mismatch') throw err
      const current = err.current || (await this.client.getBlueprint(blueprintId))
      const overrideVersion = (current?.version || 0) + 1
      await attempt(overrideVersion)
    }
  }

  async _resolveLocalBlueprintToAssetUrls(cfg) {
    const out = { ...cfg }

    if (typeof out.model === 'string') {
      out.model = await this._resolveLocalAssetToWorldUrl(out.model)
    }
    if (out.image && typeof out.image === 'object' && typeof out.image.url === 'string') {
      out.image = { ...out.image, url: await this._resolveLocalAssetToWorldUrl(out.image.url) }
    }
    if (out.props && typeof out.props === 'object') {
      const nextProps = {}
      for (const [k, v] of Object.entries(out.props)) {
        if (v && typeof v === 'object' && typeof v.url === 'string') {
          nextProps[k] = { ...v, url: await this._resolveLocalAssetToWorldUrl(v.url) }
        } else {
          nextProps[k] = v
        }
      }
      out.props = nextProps
    }
    return out
  }

  async _resolveLocalAssetToWorldUrl(url) {
    if (typeof url !== 'string') return url
    if (url.startsWith('asset://')) return url
    if (!url.startsWith('assets/')) return url

    const abs = path.join(this.rootDir, url)
    if (!fs.existsSync(abs)) return url
    const buffer = fs.readFileSync(abs)
    const hash = sha256(buffer)
    const ext = path.extname(url).toLowerCase().replace(/^\./, '') || 'bin'
    const filename = `${hash}.${ext}`
    await this.client.uploadAsset({ filename, buffer })
    return `asset://${filename}`
  }
}

export async function main() {
  const worldUrl = process.env.WORLD_URL
  const adminCode = process.env.ADMIN_CODE
  if (!worldUrl) {
    console.error('Missing env WORLD_URL (e.g. http://localhost:3000)')
    process.exit(1)
  }
  const server = new DirectAppServer({ worldUrl, adminCode })
  await server.start()
  await new Promise(() => {})
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
