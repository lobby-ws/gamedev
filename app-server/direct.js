import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { EventEmitter } from 'events'
import { isEqual } from 'lodash-es'
import { uuid } from './utils.js'
import { WorldManifest } from './WorldManifest.js'
import { deriveBlueprintId, parseBlueprintId, isBlueprintDenylist } from './blueprintUtils.js'
import { readPacket, writePacket } from '../src/core/packets.js'

const BLUEPRINT_FIELDS = [
  'model',
  'image',
  'props',
  'preload',
  'public',
  'locked',
  'frozen',
  'unique',
  'scene',
  'disabled',
  'author',
  'url',
  'desc',
]

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

function normalizeAssetPath(value) {
  if (typeof value !== 'string') return value
  return value.replace(/\\/g, '/')
}

function pickBlueprintFields(source) {
  const out = {}
  for (const key of BLUEPRINT_FIELDS) {
    if (source[key] !== undefined) out[key] = source[key]
  }
  return out
}

function normalizeBlueprintForCompare(source) {
  if (!source || typeof source !== 'object') return null
  return {
    id: source.id,
    name: source.name,
    script: source.script,
    ...pickBlueprintFields(source),
  }
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

  adminHeaders(extra = {}) {
    const headers = { ...extra }
    if (this.adminCode) headers['X-Admin-Code'] = this.adminCode
    return headers
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsAdminUrl)
      this.ws = ws

      const onOpen = () => {
        ws.send(
          writePacket('adminAuth', {
            code: this.adminCode,
            needsHeartbeat: false,
          })
        )
      }

      const onMessage = event => {
        const [method, data] = readPacket(event.data)
        if (!method) return
        if (method === 'onAdminAuthOk') {
          cleanup()
          this._attachListeners(ws)
          resolve()
          return
        }

        if (method === 'onAdminAuthError') {
          cleanup()
          reject(new Error(data?.error || 'auth_error'))
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
      const [method, data] = readPacket(event.data)
      if (!method) return

      if (method === 'onAdminResult') {
        const requestId = data?.requestId
        if (!requestId) return
        const pending = this.pending.get(requestId)
        if (!pending) return
        this.pending.delete(requestId)
        if (data.ok) {
          pending.resolve(data)
        } else {
          const err = new Error(data.error || 'error')
          err.code = data.error
          err.current = data.current
          pending.reject(err)
        }
        return
      }

      const type = method.slice(2)
      if (type) {
        const name = type.charAt(0).toLowerCase() + type.slice(1)
        if (name === 'blueprintAdded' || name === 'blueprintModified') {
          this.emit('message', { type: name, blueprint: data })
          return
        }
        if (name === 'entityAdded' || name === 'entityModified') {
          this.emit('message', { type: name, entity: data })
          return
        }
        if (name === 'entityRemoved') {
          this.emit('message', { type: name, id: data })
          return
        }
      }

      this.emit('message', { type: null, data })
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
      this.ws.send(writePacket('adminCommand', message))
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

  async setSpawn({ position, quaternion }) {
    const res = await fetch(joinUrl(this.httpBase, '/admin/spawn'), {
      method: 'PUT',
      headers: this.adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ position, quaternion }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => null)
      const err = data?.error ? `spawn_failed:${data.error}` : `spawn_failed:${res.status}`
      throw new Error(err)
    }
    return res.json()
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
    this.manifest = new WorldManifest(this.worldFile)

    this.client = new WorldAdminClient({ worldUrl: this.worldUrl, adminCode: this.adminCode })
    this.deployTimers = new Map()
    this.pendingWrites = new Set()
    this.watchers = new Map()
    this.reconnecting = false
    this.pendingManifestWrite = null

    this.assetsUrl = null
    this.snapshot = null
  }

  async connect() {
    await this.client.connect()
    const snapshot = await this.client.getSnapshot()
    this.assetsUrl = snapshot.assetsUrl
    this._validateWorldId(snapshot.worldId)
    this._initSnapshot(snapshot)
    return snapshot
  }

  _validateWorldId(remoteWorldId) {
    const localWorldId = process.env.WORLD_ID
    if (!localWorldId) {
      throw new Error('Missing WORLD_ID in .env. Set WORLD_ID to match the target world.')
    }
    if (!remoteWorldId) {
      throw new Error('Missing worldId from /admin/snapshot.')
    }
    if (remoteWorldId !== localWorldId) {
      throw new Error(`WORLD_ID mismatch: local=${localWorldId} remote=${remoteWorldId}`)
    }
  }

  _initSnapshot(snapshot) {
    const settings = snapshot.settings && typeof snapshot.settings === 'object' ? { ...snapshot.settings } : {}
    const spawn = {
      position: Array.isArray(snapshot.spawn?.position) ? snapshot.spawn.position.slice(0, 3) : [0, 0, 0],
      quaternion: Array.isArray(snapshot.spawn?.quaternion) ? snapshot.spawn.quaternion.slice(0, 4) : [0, 0, 0, 1],
    }
    const blueprints = new Map()
    const blueprintList = Array.isArray(snapshot.blueprints) ? snapshot.blueprints : []
    for (const blueprint of blueprintList) {
      if (blueprint?.id) blueprints.set(blueprint.id, blueprint)
    }
    const entities = new Map()
    const entityList = Array.isArray(snapshot.entities) ? snapshot.entities : []
    for (const entity of entityList) {
      if (entity?.id) entities.set(entity.id, entity)
    }
    this.snapshot = {
      worldId: snapshot.worldId || null,
      assetsUrl: snapshot.assetsUrl || null,
      settings,
      spawn,
      blueprints,
      entities,
    }
  }

  async start() {
    ensureDir(this.appsDir)
    ensureDir(this.assetsDir)

    const snapshot = await this.connect()

    const hasWorldFile = fs.existsSync(this.worldFile)
    const hasApps = this._hasLocalApps()

    if (!hasWorldFile && !hasApps) {
      await this.exportWorldToDisk(snapshot)
    } else if (!hasWorldFile && hasApps) {
      throw new Error(
        'world.json missing; cannot safely apply exact world layout. ' +
          'Run "hyperfy world export" to generate it from the world, or create world.json to seed a new world.'
      )
    } else {
      const manifest = this.manifest.read()
      if (!manifest) {
        throw new Error('world.json is missing or invalid JSON.')
      }
      const errors = this.manifest.validate(manifest)
      if (errors.length) {
        throw new Error(`Invalid world.json:\n- ${errors.join('\n- ')}`)
      }
      await this._deployAllBlueprints()
      await this._applyManifestToWorld(manifest)
    }

    this._startWatchers()
    this._attachRemoteHandlers()
    this.client.on('disconnect', () => {
      this._startReconnectLoop()
    })
    console.log(`✅ Connected to ${this.worldUrl} (/admin)`) 
  }

  async exportWorldToDisk(snapshot = this.snapshot) {
    const nextSnapshot = snapshot || (await this.client.getSnapshot())
    this.assetsUrl = nextSnapshot.assetsUrl
    if (!this.snapshot) this._initSnapshot(nextSnapshot)

    const manifest = this.manifest.fromSnapshot(nextSnapshot)
    this._writeWorldFile(manifest)

    const blueprints = Array.isArray(nextSnapshot.blueprints) ? nextSnapshot.blueprints : []
    for (const blueprint of blueprints) {
      if (!blueprint?.id) continue
      await this._writeBlueprintToDisk({ blueprint, force: true })
    }
  }

  async importWorldFromDisk() {
    const manifest = this.manifest.read()
    if (!manifest) {
      throw new Error('world.json missing. Run "hyperfy world export" to generate it first.')
    }
    const errors = this.manifest.validate(manifest)
    if (errors.length) {
      throw new Error(`Invalid world.json:\n- ${errors.join('\n- ')}`)
    }
    await this._deployAllBlueprints()
    await this._applyManifestToWorld(manifest)
  }

  async deployApp(appName) {
    await this._deployBlueprintsForApp(appName)
  }

  async deployBlueprint(id) {
    await this._deployBlueprintById(id)
  }

  async _startReconnectLoop() {
    if (this.reconnecting) return
    this.reconnecting = true
    let delay = 500
    while (this.reconnecting) {
      try {
        console.warn(`⚠️  Disconnected from ${this.worldUrl}, reconnecting...`)
        const snapshot = await this.connect()
        if (!fs.existsSync(this.worldFile) && !this._hasLocalApps()) {
          await this.exportWorldToDisk(snapshot)
        } else if (fs.existsSync(this.worldFile)) {
          const manifest = this.manifest.read()
          if (!manifest) {
            throw new Error('world.json is missing or invalid JSON.')
          }
          const errors = this.manifest.validate(manifest)
          if (errors.length) {
            throw new Error(`Invalid world.json:\n- ${errors.join('\n- ')}`)
          }
          await this._deployAllBlueprints()
          await this._applyManifestToWorld(manifest)
        }
        console.log(`✅ Reconnected to ${this.worldUrl} (/admin)`) 
        this.reconnecting = false
        return
      } catch (err) {
        await sleep(delay)
        delay = Math.min(delay * 2, 10000)
      }
    }
  }

  _hasLocalApps() {
    const blueprints = this._indexLocalBlueprints()
    return blueprints.size > 0
  }

  _indexLocalBlueprints() {
    const index = new Map()
    if (!fs.existsSync(this.appsDir)) return index

    for (const appName of listSubdirs(this.appsDir)) {
      const appPath = path.join(this.appsDir, appName)
      const entries = fs.existsSync(appPath)
        ? fs.readdirSync(appPath, { withFileTypes: true })
        : []
      const scriptPath = this._getScriptPath(appName)

      for (const entry of entries) {
        if (!entry.isFile()) continue
        if (!entry.name.endsWith('.json')) continue
        if (isBlueprintDenylist(entry.name)) continue
        const fileBase = path.basename(entry.name, '.json')
        const id = deriveBlueprintId(appName, fileBase)
        const configPath = path.join(appPath, entry.name)
        index.set(id, { id, appName, fileBase, configPath, scriptPath })
      }
    }

    return index
  }

  _getScriptPath(appName) {
    const appPath = path.join(this.appsDir, appName)
    const tsPath = path.join(appPath, 'index.ts')
    const jsPath = path.join(appPath, 'index.js')
    if (fs.existsSync(tsPath)) return tsPath
    if (fs.existsSync(jsPath)) return jsPath
    return null
  }

  _writeWorldFile(manifest) {
    if (isEqual(this.manifest.data, manifest)) return
    this._writeFileAtomic(this.worldFile, JSON.stringify(manifest, null, 2) + '\n')
    this.manifest.data = manifest
  }

  _startWatchers() {
    this._watchAppsDir()
    this._watchAssetsDir()
    this._watchWorldFile()
    for (const appName of listSubdirs(this.appsDir)) {
      this._watchAppDir(appName)
    }
  }

  _watchAppsDir() {
    if (this.watchers.has('appsDir')) return
    if (!fs.existsSync(this.appsDir)) return
    const watcher = fs.watch(this.appsDir, { recursive: false }, (eventType, filename) => {
      if (eventType !== 'rename' || !filename) return
      const abs = path.join(this.appsDir, filename)
      if (!fs.existsSync(abs)) return
      if (!fs.statSync(abs).isDirectory()) return
      this._watchAppDir(filename)
    })
    this.watchers.set('appsDir', watcher)
  }

  _watchAppDir(appName) {
    const appPath = path.join(this.appsDir, appName)
    if (this.watchers.has(appPath)) return
    if (!fs.existsSync(appPath)) return
    const watcher = fs.watch(appPath, { recursive: false }, (eventType, filename) => {
      if (!filename) return
      const abs = path.join(appPath, filename)
      if (this.pendingWrites.has(abs)) return
      if (!fs.existsSync(abs) && eventType === 'change') return

      if (filename === 'index.js' || filename === 'index.ts') {
        if (fs.existsSync(abs)) this._scheduleDeployApp(appName)
        return
      }

      if (filename.endsWith('.json') && !isBlueprintDenylist(filename)) {
        if (!fs.existsSync(abs)) return
        const fileBase = path.basename(filename, '.json')
        const id = deriveBlueprintId(appName, fileBase)
        this._scheduleDeployBlueprint(id)
      }
    })
    this.watchers.set(appPath, watcher)
  }

  _watchWorldFile() {
    if (this.watchers.has('worldFile')) return
    if (!fs.existsSync(this.worldFile)) return
    const watcher = fs.watch(this.worldFile, eventType => {
      if (eventType !== 'change') return
      if (this.pendingWrites.has(this.worldFile)) return
      this._onWorldFileChanged()
    })
    this.watchers.set('worldFile', watcher)
  }

  _watchAssetsDir() {
    if (this.watchers.has('assetsDir')) return
    if (!fs.existsSync(this.assetsDir)) return
    const watcher = fs.watch(this.assetsDir, { recursive: false }, (eventType, filename) => {
      if (!filename) return
      if (eventType !== 'change') return
      const rel = path.posix.join('assets', filename)
      const abs = path.join(this.assetsDir, filename)
      if (this.pendingWrites.has(abs)) return
      this._onAssetChanged(rel)
    })
    this.watchers.set('assetsDir', watcher)
  }

  _scheduleManifestWrite() {
    if (this.pendingManifestWrite) clearTimeout(this.pendingManifestWrite)
    this.pendingManifestWrite = setTimeout(() => {
      this.pendingManifestWrite = null
      if (!this.snapshot) return
      const data = {
        settings: this.snapshot.settings,
        spawn: this.snapshot.spawn,
        entities: Array.from(this.snapshot.entities.values()),
      }
      const manifest = this.manifest.fromSnapshot(data)
      this._writeWorldFile(manifest)
    }, 250)
  }

  async _onWorldFileChanged() {
    try {
      const manifest = this.manifest.read()
      if (!manifest) return
      const errors = this.manifest.validate(manifest)
      if (errors.length) {
        console.error(`❌ Invalid world.json:\n- ${errors.join('\n- ')}`)
        return
      }
      await this._deployAllBlueprints()
      await this._applyManifestToWorld(manifest)
    } catch (err) {
      console.error('❌ Failed to apply world.json:', err?.message || err)
    }
  }

  _scheduleDeployApp(appName) {
    const key = `app:${appName}`
    if (this.deployTimers.has(key)) clearTimeout(this.deployTimers.get(key))
    const timer = setTimeout(() => {
      this.deployTimers.delete(key)
      this._deployBlueprintsForApp(appName).catch(err => {
        console.error(`❌ Deploy failed for ${appName}:`, err?.message || err)
      })
    }, 750)
    this.deployTimers.set(key, timer)
  }

  _scheduleDeployBlueprint(id) {
    const key = `bp:${id}`
    if (this.deployTimers.has(key)) clearTimeout(this.deployTimers.get(key))
    const timer = setTimeout(() => {
      this.deployTimers.delete(key)
      this._deployBlueprintById(id).catch(err => {
        console.error(`❌ Deploy failed for ${id}:`, err?.message || err)
      })
    }, 750)
    this.deployTimers.set(key, timer)
  }

  async _deployAllBlueprints() {
    const index = this._indexLocalBlueprints()
    const byApp = new Map()
    for (const info of index.values()) {
      if (!byApp.has(info.appName)) byApp.set(info.appName, [])
      byApp.get(info.appName).push(info)
    }
    for (const [appName, infos] of byApp.entries()) {
      await this._deployBlueprintsForApp(appName, infos, index)
    }
  }

  async _deployBlueprintById(id) {
    const index = this._indexLocalBlueprints()
    const info = index.get(id)
    if (!info) return
    await this._deployBlueprintsForApp(info.appName, [info], index)
  }

  async _deployBlueprintsForApp(appName, infos = null, index = null) {
    const blueprintIndex = index || this._indexLocalBlueprints()
    const list = infos || Array.from(blueprintIndex.values()).filter(item => item.appName === appName)
    if (!list.length) return

    const scriptInfo = await this._uploadScriptForApp(appName, list[0].scriptPath)
    for (const info of list) {
      await this._deployBlueprint(info, scriptInfo)
    }
  }

  async _uploadScriptForApp(appName, scriptPath = null) {
    const resolvedPath = scriptPath || this._getScriptPath(appName)
    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
      throw new Error(`missing_script:${appName}`)
    }
    const scriptText = fs.readFileSync(resolvedPath, 'utf8')
    const scriptHash = sha256(Buffer.from(scriptText, 'utf8'))
    const scriptFilename = `${scriptHash}.js`
    await this.client.uploadAsset({
      filename: scriptFilename,
      buffer: Buffer.from(scriptText, 'utf8'),
      mimeType: 'text/javascript',
    })
    return { scriptUrl: `asset://${scriptFilename}`, scriptPath: resolvedPath, scriptText }
  }

  async _deployBlueprint(info, scriptInfo) {
    const cfg = readJson(info.configPath)
    if (!cfg || typeof cfg !== 'object') {
      console.error(`❌ Invalid blueprint config: ${info.configPath}`)
      return
    }

    const payload = {
      id: info.id,
      name: info.fileBase,
      script: scriptInfo.scriptUrl,
      ...pickBlueprintFields(cfg),
    }

    const resolved = await this._resolveLocalBlueprintToAssetUrls(payload)

    const current = this.snapshot?.blueprints?.get(info.id) || null
    if (!current) {
      resolved.version = 0
      await this.client.request('blueprint_add', { blueprint: resolved })
    } else {
      const nextCompare = normalizeBlueprintForCompare(resolved)
      const currentCompare = normalizeBlueprintForCompare(current)
      if (isEqual(nextCompare, currentCompare)) return
      const attempt = async version => {
        resolved.version = version
        await this.client.request('blueprint_modify', { change: resolved })
      }
      try {
        await attempt((current.version || 0) + 1)
      } catch (err) {
        if (err?.code !== 'version_mismatch') throw err
        const latest = err.current || (await this.client.getBlueprint(info.id))
        await attempt((latest?.version || 0) + 1)
      }
    }

    const updated = await this.client.getBlueprint(info.id)
    if (updated?.id) {
      this.snapshot.blueprints.set(updated.id, updated)
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
    const normalized = normalizeAssetPath(url)
    if (normalized.startsWith('asset://')) return normalized
    if (!normalized.startsWith('assets/')) return normalized

    const abs = path.join(this.rootDir, normalized)
    if (!fs.existsSync(abs)) return normalized
    const buffer = fs.readFileSync(abs)
    const hash = sha256(buffer)
    const ext = path.extname(normalized).toLowerCase().replace(/^\./, '') || 'bin'
    const filename = `${hash}.${ext}`
    await this.client.uploadAsset({ filename, buffer })
    return `asset://${filename}`
  }

  async _applyManifestToWorld(manifest) {
    if (!this.snapshot) return

    for (const [key, value] of Object.entries(manifest.settings || {})) {
      if (!isEqual(this.snapshot.settings?.[key], value)) {
        await this.client.request('settings_modify', { key, value })
        this.snapshot.settings[key] = value
      }
    }

    const spawnChanged =
      !isEqual(this.snapshot.spawn?.position, manifest.spawn?.position) ||
      !isEqual(this.snapshot.spawn?.quaternion, manifest.spawn?.quaternion)

    if (spawnChanged) {
      await this.client.setSpawn({
        position: manifest.spawn.position,
        quaternion: manifest.spawn.quaternion,
      })
      this.snapshot.spawn = {
        position: manifest.spawn.position.slice(0, 3),
        quaternion: manifest.spawn.quaternion.slice(0, 4),
      }
    }

    const desired = new Map()
    for (const entity of manifest.entities || []) {
      desired.set(entity.id, entity)
    }
    const current = new Map()
    for (const entity of this.snapshot.entities.values()) {
      if (entity?.type === 'app') current.set(entity.id, entity)
    }

    for (const [id, entity] of desired.entries()) {
      const existing = current.get(id)
      if (!existing) {
        const data = {
          id: entity.id,
          type: 'app',
          blueprint: entity.blueprint,
          position: entity.position,
          quaternion: entity.quaternion,
          scale: entity.scale,
          mover: null,
          uploader: null,
          pinned: entity.pinned,
          state: entity.state,
        }
        await this.client.request('entity_add', { entity: data })
        this.snapshot.entities.set(id, { ...data })
        continue
      }

      const change = { id }
      if (!isEqual(existing.blueprint, entity.blueprint)) change.blueprint = entity.blueprint
      if (!isEqual(existing.position, entity.position)) change.position = entity.position
      if (!isEqual(existing.quaternion, entity.quaternion)) change.quaternion = entity.quaternion
      if (!isEqual(existing.scale, entity.scale)) change.scale = entity.scale
      if (!isEqual(existing.pinned, entity.pinned)) change.pinned = entity.pinned
      if (!isEqual(existing.state, entity.state)) change.state = entity.state

      if (Object.keys(change).length > 1) {
        await this.client.request('entity_modify', { change })
        this.snapshot.entities.set(id, { ...existing, ...change })
      }
    }

    for (const [id] of current.entries()) {
      if (!desired.has(id)) {
        await this.client.request('entity_remove', { id })
        this.snapshot.entities.delete(id)
      }
    }
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
      if (msg.type === 'blueprintRemoved' && msg.id) {
        await this._onRemoteBlueprintRemoved(msg.id)
      }
      if (msg.type === 'entityAdded' && msg.entity?.id) {
        this.snapshot.entities.set(msg.entity.id, msg.entity)
        this._scheduleManifestWrite()
      }
      if (msg.type === 'entityModified' && msg.entity?.id) {
        const existing = this.snapshot.entities.get(msg.entity.id)
        this.snapshot.entities.set(msg.entity.id, { ...existing, ...msg.entity })
        this._scheduleManifestWrite()
      }
      if (msg.type === 'entityRemoved' && msg.id) {
        this.snapshot.entities.delete(msg.id)
        this._scheduleManifestWrite()
      }
      if (msg.type === 'settingsModified' && msg.data?.key) {
        this.snapshot.settings[msg.data.key] = msg.data.value
        this._scheduleManifestWrite()
      }
      if (msg.type === 'spawnModified' && msg.spawn) {
        this.snapshot.spawn = {
          position: Array.isArray(msg.spawn.position) ? msg.spawn.position.slice(0, 3) : [0, 0, 0],
          quaternion: Array.isArray(msg.spawn.quaternion) ? msg.spawn.quaternion.slice(0, 4) : [0, 0, 0, 1],
        }
        this._scheduleManifestWrite()
      }
    })
  }

  async _onRemoteBlueprint(blueprint) {
    this.snapshot.blueprints.set(blueprint.id, blueprint)
    await this._writeBlueprintToDisk({ blueprint, force: true })
    const parsed = parseBlueprintId(blueprint.id)
    this._watchAppDir(parsed.appName)
  }

  async _onRemoteBlueprintRemoved(id) {
    this.snapshot.blueprints.delete(id)
    const parsed = parseBlueprintId(id)
    const configPath = path.join(this.appsDir, parsed.appName, `${parsed.fileBase}.json`)
    if (fs.existsSync(configPath)) {
      try {
        fs.rmSync(configPath, { force: true })
      } catch (err) {
        console.warn(`⚠️  Failed to delete blueprint config: ${configPath}`)
      }
    }
  }

  async _writeBlueprintToDisk({ blueprint, force }) {
    const { appName, fileBase } = parseBlueprintId(blueprint.id)
    const appPath = path.join(this.appsDir, appName)
    ensureDir(appPath)

    const blueprintPath = path.join(appPath, `${fileBase}.json`)
    const localBlueprint = await this._blueprintToLocalConfig(appName, blueprint)
    if (force || !fs.existsSync(blueprintPath)) {
      this._writeFileAtomic(blueprintPath, JSON.stringify(localBlueprint, null, 2) + '\n')
    } else {
      const existing = readJson(blueprintPath)
      if (!isEqual(existing, localBlueprint)) {
        this._writeFileAtomic(blueprintPath, JSON.stringify(localBlueprint, null, 2) + '\n')
      }
    }

    const scriptPath = path.join(appPath, 'index.js')
    const shouldWriteScript = force || !fs.existsSync(scriptPath)
    if (shouldWriteScript) {
      const script = await this._downloadScript(blueprint.script)
      if (script != null) {
        this._writeFileAtomic(scriptPath, script)
      }
    }
  }

  async _downloadScript(scriptUrl) {
    if (!scriptUrl) return ''
    if (!scriptUrl.startsWith('asset://')) {
      return typeof scriptUrl === 'string' ? scriptUrl : ''
    }
    const filename = extractAssetFilename(scriptUrl)
    if (!filename) return ''
    const maxAttempts = 4
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const res = await fetch(joinUrl(this.assetsUrl, filename))
      if (res.ok) {
        return res.text()
      }
      if (res.status === 404 && attempt < maxAttempts - 1) {
        await sleep(250 * (attempt + 1))
        continue
      }
      if (res.status === 404) {
        console.warn(`⚠️  Script not found yet: ${filename}`)
        return null
      }
      throw new Error(`script_download_failed:${res.status}`)
    }
    return null
  }

  async _blueprintToLocalConfig(appName, blueprint) {
    const output = {}
    if (blueprint.author !== undefined) output.author = blueprint.author
    if (blueprint.url !== undefined) output.url = blueprint.url
    if (blueprint.desc !== undefined) output.desc = blueprint.desc
    if (blueprint.preload !== undefined) output.preload = blueprint.preload
    if (blueprint.public !== undefined) output.public = blueprint.public
    if (blueprint.locked !== undefined) output.locked = blueprint.locked
    if (blueprint.frozen !== undefined) output.frozen = blueprint.frozen
    if (blueprint.unique !== undefined) output.unique = blueprint.unique
    if (blueprint.disabled !== undefined) output.disabled = blueprint.disabled
    if (blueprint.scene !== undefined) output.scene = blueprint.scene

    if (typeof blueprint.model === 'string') {
      output.model = await this._maybeDownloadAsset(
        appName,
        blueprint.model,
        `${appName}${path.extname(blueprint.model) || '.glb'}`
      )
    } else if (blueprint.model !== undefined) {
      output.model = blueprint.model
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
    } else if (blueprint.image !== undefined) {
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
    } else if (blueprint.props !== undefined) {
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

    let buffer = null
    const maxAttempts = 4
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const res = await fetch(joinUrl(this.assetsUrl, filename))
      if (res.ok) {
        buffer = Buffer.from(await res.arrayBuffer())
        break
      }
      if (res.status === 404 && attempt < maxAttempts - 1) {
        await sleep(250 * (attempt + 1))
        continue
      }
      if (res.status === 404) {
        console.warn(`⚠️  Asset not found yet: ${filename}`)
        return url
      }
      throw new Error(`asset_download_failed:${res.status}`)
    }
    if (!buffer) return url
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

  _onAssetChanged(assetRelPath) {
    const index = this._indexLocalBlueprints()
    for (const info of index.values()) {
      const cfg = readJson(info.configPath)
      if (!cfg || typeof cfg !== 'object') continue
      if (normalizeAssetPath(cfg.model) === assetRelPath) {
        this._scheduleDeployBlueprint(info.id)
        continue
      }
      if (cfg.image && typeof cfg.image === 'object' && normalizeAssetPath(cfg.image.url) === assetRelPath) {
        this._scheduleDeployBlueprint(info.id)
        continue
      }
      const props = cfg.props && typeof cfg.props === 'object' ? cfg.props : {}
      for (const value of Object.values(props)) {
        if (value && typeof value === 'object' && normalizeAssetPath(value.url) === assetRelPath) {
          this._scheduleDeployBlueprint(info.id)
          break
        }
      }
    }
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
