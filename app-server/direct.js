import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { EventEmitter } from 'events'
import { isEqual } from 'lodash-es'
import { parse as acornParse } from 'acorn'
import { uuid } from './utils.js'
import { WorldManifest } from './WorldManifest.js'
import { deriveBlueprintId, parseBlueprintId, isBlueprintDenylist } from './blueprintUtils.js'
import { scaffoldBaseProject, scaffoldBuiltins } from './scaffold.js'
import { BUILTIN_BLUEPRINT_IDS, SCENE_TEMPLATE } from './templates/builtins.js'
import { readPacket, writePacket } from '../src/core/packets.js'
import { isValidScriptPath } from '../src/core/blueprintValidation.js'

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

const SCRIPT_EXTENSIONS = new Set(['.js', '.ts'])
const SCRIPT_DIR_SKIP = new Set(['.git', 'node_modules'])
const SHARED_DIR_NAME = 'shared'
const SHARED_IMPORT_PREFIX = '@shared/'
const SHARED_IMPORT_ALIAS = 'shared/'

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

async function normalizePacketData(data) {
  if (!data) return data
  if (data instanceof Uint8Array) return data
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    const buffer = await data.arrayBuffer()
    return new Uint8Array(buffer)
  }
  return data
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

function normalizeScriptRelPath(value) {
  if (typeof value !== 'string') return value
  return value.replace(/\\/g, '/')
}

function isRelativeImport(specifier) {
  return typeof specifier === 'string' && (specifier.startsWith('./') || specifier.startsWith('../'))
}

function normalizeRelativePath(referrerPath, importSpecifier) {
  if (typeof referrerPath !== 'string' || typeof importSpecifier !== 'string') return null
  if (importSpecifier.includes('\\')) return null
  const refSegments = normalizeScriptRelPath(referrerPath).split('/').filter(Boolean)
  refSegments.pop()
  const specSegments = importSpecifier.split('/')
  const nextSegments = [...refSegments]
  for (const segment of specSegments) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (nextSegments.length === 0) return null
      nextSegments.pop()
      continue
    }
    nextSegments.push(segment)
  }
  const normalized = nextSegments.join('/')
  return normalized || null
}

function normalizeSharedSpecifier(specifier) {
  if (typeof specifier !== 'string') return null
  const normalized = normalizeScriptRelPath(specifier)
  if (normalized.startsWith(SHARED_IMPORT_PREFIX)) {
    return isValidScriptPath(normalized) ? normalized : null
  }
  if (normalized.startsWith(SHARED_IMPORT_ALIAS)) {
    const rest = normalized.slice(SHARED_IMPORT_ALIAS.length)
    if (!rest) return null
    const relPath = `${SHARED_IMPORT_PREFIX}${rest}`
    return isValidScriptPath(relPath) ? relPath : null
  }
  return null
}

function getSharedDiskRelativePath(relPath) {
  if (typeof relPath !== 'string') return null
  const normalized = normalizeScriptRelPath(relPath)
  if (normalized.startsWith(SHARED_IMPORT_PREFIX)) {
    const rest = normalized.slice(SHARED_IMPORT_PREFIX.length)
    return rest || null
  }
  if (normalized.startsWith(SHARED_IMPORT_ALIAS)) {
    const rest = normalized.slice(SHARED_IMPORT_ALIAS.length)
    return rest || null
  }
  return null
}

const IMPORT_EXPORT_SPECIFIER_REGEX =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*from\s*)?['"]([^'"]+)['"]/g
const DYNAMIC_IMPORT_SPECIFIER_REGEX = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

function extractImportSpecifiersFallback(sourceText) {
  const specifiers = new Set()
  IMPORT_EXPORT_SPECIFIER_REGEX.lastIndex = 0
  DYNAMIC_IMPORT_SPECIFIER_REGEX.lastIndex = 0
  let match = null
  while ((match = IMPORT_EXPORT_SPECIFIER_REGEX.exec(sourceText)) !== null) {
    if (match[1]) specifiers.add(match[1])
  }
  while ((match = DYNAMIC_IMPORT_SPECIFIER_REGEX.exec(sourceText)) !== null) {
    if (match[1]) specifiers.add(match[1])
  }
  return Array.from(specifiers)
}

function extractImportSpecifiers(sourceText) {
  if (typeof sourceText !== 'string' || !sourceText.trim()) return []
  let ast = null
  try {
    ast = acornParse(sourceText, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
    })
  } catch {
    return extractImportSpecifiersFallback(sourceText)
  }

  const specifiers = []
  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') {
      const specifier = node.source?.value
      if (typeof specifier === 'string') specifiers.push(specifier)
      continue
    }
    if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
      const specifier = node.source?.value
      if (typeof specifier === 'string') specifiers.push(specifier)
    }
  }
  return specifiers
}

function isScriptFilename(name) {
  const ext = path.extname(name || '').toLowerCase()
  return SCRIPT_EXTENSIONS.has(ext)
}

function normalizeScriptFormat(value) {
  if (value === 'module' || value === 'legacy-body') return value
  return null
}

function getExportedName(node) {
  if (!node) return null
  if (node.type === 'Identifier') return node.name
  if (node.type === 'Literal') return String(node.value)
  return null
}

function entryHasDefaultExport(sourceText) {
  if (typeof sourceText !== 'string' || !sourceText.trim()) return false
  let ast
  try {
    ast = acornParse(sourceText, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
    })
  } catch {
    return false
  }
  for (const node of ast.body) {
    if (node.type === 'ExportDefaultDeclaration') return true
    if (node.type === 'ExportNamedDeclaration' && Array.isArray(node.specifiers)) {
      for (const spec of node.specifiers) {
        if (spec.type !== 'ExportSpecifier') continue
        const exported = getExportedName(spec.exported)
        if (exported === 'default') return true
      }
    }
  }
  return false
}

function hasScriptFiles(blueprint) {
  return blueprint?.scriptFiles && typeof blueprint.scriptFiles === 'object' && !Array.isArray(blueprint.scriptFiles)
}

function listScriptFiles(rootDir) {
  if (!fs.existsSync(rootDir)) return []
  const files = []
  const pending = [rootDir]
  while (pending.length) {
    const dir = pending.pop()
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SCRIPT_DIR_SKIP.has(entry.name)) continue
        pending.push(path.join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      if (!isScriptFilename(entry.name)) continue
      const absPath = path.join(dir, entry.name)
      const relPath = normalizeScriptRelPath(path.relative(rootDir, absPath))
      files.push({ absPath, relPath })
    }
  }
  files.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return files
}

function collectSharedDependencies(appFiles, sharedDir) {
  const sharedRelPaths = new Set()
  const queue = []

  const enqueue = relPath => {
    if (!relPath) return
    if (!relPath.startsWith(SHARED_IMPORT_PREFIX)) return
    if (!isValidScriptPath(relPath)) return
    if (sharedRelPaths.has(relPath)) return
    sharedRelPaths.add(relPath)
    queue.push(relPath)
  }

  for (const file of appFiles) {
    let sourceText = ''
    try {
      sourceText = fs.readFileSync(file.absPath, 'utf8')
    } catch {
      continue
    }
    const specifiers = extractImportSpecifiers(sourceText)
    for (const specifier of specifiers) {
      const relPath = normalizeSharedSpecifier(specifier)
      if (relPath) enqueue(relPath)
    }
  }

  while (queue.length) {
    const relPath = queue.pop()
    const sharedRel = getSharedDiskRelativePath(relPath)
    if (!sharedRel) continue
    const absPath = path.join(sharedDir, sharedRel)
    if (!fs.existsSync(absPath)) continue
    if (!isScriptFilename(absPath)) continue
    let sourceText = ''
    try {
      sourceText = fs.readFileSync(absPath, 'utf8')
    } catch {
      continue
    }
    const specifiers = extractImportSpecifiers(sourceText)
    for (const specifier of specifiers) {
      const aliasRelPath = normalizeSharedSpecifier(specifier)
      if (aliasRelPath) {
        enqueue(aliasRelPath)
        continue
      }
      if (!isRelativeImport(specifier)) continue
      const resolved = normalizeRelativePath(relPath, specifier)
      if (!resolved) continue
      if (!resolved.startsWith(SHARED_IMPORT_PREFIX)) continue
      if (!isValidScriptPath(resolved)) continue
      enqueue(resolved)
    }
  }

  return sharedRelPaths
}

function buildSharedFileEntries(sharedRelPaths, sharedDir) {
  if (!sharedRelPaths || !sharedDir) return []
  const files = []
  for (const relPath of sharedRelPaths) {
    const sharedRel = getSharedDiskRelativePath(relPath)
    if (!sharedRel) continue
    const absPath = path.join(sharedDir, sharedRel)
    if (!fs.existsSync(absPath)) continue
    if (!isScriptFilename(absPath)) continue
    files.push({ absPath, relPath })
  }
  files.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return files
}

function getExistingAssetUrl(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof value.url === 'string') {
    return value.url
  }
  return null
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
    scriptEntry: source.scriptEntry,
    scriptFiles: source.scriptFiles,
    scriptFormat: source.scriptFormat,
    scriptRef: source.scriptRef,
    ...pickBlueprintFields(source),
  }
}

function normalizeBlueprintForCompareWithoutScript(source) {
  const normalized = normalizeBlueprintForCompare(source)
  if (!normalized) return normalized
  delete normalized.script
  delete normalized.scriptEntry
  delete normalized.scriptFiles
  delete normalized.scriptFormat
  delete normalized.scriptRef
  return normalized
}

function normalizeBlueprintScriptFields(source) {
  if (!source || typeof source !== 'object') return null
  return {
    script: source.script,
    scriptEntry: source.scriptEntry,
    scriptFiles: source.scriptFiles,
    scriptFormat: source.scriptFormat,
    scriptRef: source.scriptRef,
  }
}

function formatNameList(items, limit = 6) {
  if (!Array.isArray(items) || items.length === 0) return ''
  if (items.length <= limit) return items.join(', ')
  const shown = items.slice(0, limit).join(', ')
  return `${shown} (+${items.length - limit} more)`
}

class WorldAdminClient extends EventEmitter {
  constructor({ worldUrl, adminCode, deployCode }) {
    super()
    this.worldUrl = normalizeBaseUrl(worldUrl)
    this.adminCode = adminCode || null
    this.deployCode = deployCode || null
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

  adminHeaders(extra = {}, { includeDeploy } = {}) {
    const headers = { ...extra }
    if (this.adminCode) headers['X-Admin-Code'] = this.adminCode
    if (includeDeploy && this.deployCode) headers['X-Deploy-Code'] = this.deployCode
    return headers
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsAdminUrl)
      ws.binaryType = 'arraybuffer'
      this.ws = ws

      const onOpen = () => {
        ws.send(
          writePacket('adminAuth', {
            code: this.adminCode,
            deployCode: this.deployCode,
            subscriptions: { snapshot: false, players: false, runtime: false },
          })
        )
      }

      const onMessage = async event => {
        let packet
        try {
          packet = await normalizePacketData(event.data)
        } catch (err) {
          console.error(err)
          return
        }
        const [method, data] = readPacket(packet)
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
    ws.addEventListener('message', async event => {
      let packet
      try {
        packet = await normalizePacketData(event.data)
      } catch (err) {
        console.error(err)
        return
      }
      const [method, data] = readPacket(packet)
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
          err.lock = data.lock
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
        if (name === 'blueprintRemoved') {
          const id = data?.id || data
          this.emit('message', { type: name, id })
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
        if (name === 'settingsModified') {
          this.emit('message', { type: name, data })
          return
        }
        if (name === 'spawnModified') {
          this.emit('message', { type: name, spawn: data })
          return
        }
        this.emit('message', { type: name, data })
        return
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

  async removeBlueprint(id) {
    const res = await fetch(joinUrl(this.httpBase, `/admin/blueprints/${encodeURIComponent(id)}`), {
      method: 'DELETE',
      headers: this.adminHeaders(),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => null)
      const err = new Error(data?.error || `blueprint_remove_failed:${res.status}`)
      err.code = data?.error || 'blueprint_remove_failed'
      throw err
    }
    return res.json().catch(() => ({ ok: true }))
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

  async getDeployLockStatus({ scope } = {}) {
    const suffix = scope ? `?scope=${encodeURIComponent(scope)}` : ''
    const res = await fetch(joinUrl(this.httpBase, `/admin/deploy-lock${suffix}`), {
      headers: this.adminHeaders({}, { includeDeploy: true }),
    })
    if (!res.ok) {
      throw new Error(`deploy_lock_status_failed:${res.status}`)
    }
    return res.json()
  }

  async acquireDeployLock({ owner, ttl, scope } = {}) {
    const payload = { owner, ttl }
    if (scope) payload.scope = scope
    const res = await fetch(joinUrl(this.httpBase, '/admin/deploy-lock'), {
      method: 'POST',
      headers: this.adminHeaders({ 'Content-Type': 'application/json' }, { includeDeploy: true }),
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => null)
      const err = new Error(data?.error || `deploy_lock_failed:${res.status}`)
      err.code = data?.error || 'deploy_lock_failed'
      err.lock = data?.lock
      throw err
    }
    return res.json()
  }

  async renewDeployLock({ token, ttl, scope } = {}) {
    const payload = { token, ttl }
    if (scope) payload.scope = scope
    const res = await fetch(joinUrl(this.httpBase, '/admin/deploy-lock'), {
      method: 'PUT',
      headers: this.adminHeaders({ 'Content-Type': 'application/json' }, { includeDeploy: true }),
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => null)
      const err = new Error(data?.error || `deploy_lock_renew_failed:${res.status}`)
      err.code = data?.error || 'deploy_lock_renew_failed'
      err.lock = data?.lock
      throw err
    }
    return res.json()
  }

  async releaseDeployLock({ token, scope } = {}) {
    const payload = { token }
    if (scope) payload.scope = scope
    const res = await fetch(joinUrl(this.httpBase, '/admin/deploy-lock'), {
      method: 'DELETE',
      headers: this.adminHeaders({ 'Content-Type': 'application/json' }, { includeDeploy: true }),
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => null)
      const err = new Error(data?.error || `deploy_lock_release_failed:${res.status}`)
      err.code = data?.error || 'deploy_lock_release_failed'
      err.lock = data?.lock
      throw err
    }
    return res.json()
  }

  async createDeploySnapshot({ ids, target, note, lockToken, scope } = {}) {
    const payload = { ids, target, note, lockToken }
    if (scope) payload.scope = scope
    const res = await fetch(joinUrl(this.httpBase, '/admin/deploy-snapshots'), {
      method: 'POST',
      headers: this.adminHeaders({ 'Content-Type': 'application/json' }, { includeDeploy: true }),
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => null)
      const err = new Error(data?.error || `snapshot_failed:${res.status}`)
      err.code = data?.error || 'snapshot_failed'
      err.lock = data?.lock
      throw err
    }
    return res.json()
  }

  async rollbackDeploySnapshot({ id, lockToken, scope } = {}) {
    const payload = { id, lockToken }
    if (scope) payload.scope = scope
    const res = await fetch(joinUrl(this.httpBase, '/admin/deploy-snapshots/rollback'), {
      method: 'POST',
      headers: this.adminHeaders({ 'Content-Type': 'application/json' }, { includeDeploy: true }),
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => null)
      const err = new Error(data?.error || `rollback_failed:${res.status}`)
      err.code = data?.error || 'rollback_failed'
      err.lock = data?.lock
      throw err
    }
    return res.json()
  }
}

export class DirectAppServer {
  constructor({ worldUrl, adminCode, deployCode, rootDir = process.cwd() }) {
    this.rootDir = rootDir
    this.worldUrl = normalizeBaseUrl(worldUrl)
    this.adminCode = adminCode || null
    this.deployCode = deployCode || null
    this.appsDir = path.join(this.rootDir, 'apps')
    this.assetsDir = path.join(this.rootDir, 'assets')
    this.sharedDir = path.join(this.rootDir, SHARED_DIR_NAME)
    this.worldFile = path.join(this.rootDir, 'world.json')
    this.manifest = new WorldManifest(this.worldFile)

    this.client = new WorldAdminClient({
      worldUrl: this.worldUrl,
      adminCode: this.adminCode,
      deployCode: this.deployCode,
    })
    this.deployTimers = new Map()
    this.deployQueues = new Map()
    this.removeTimers = new Map()
    this.pendingWrites = new Set()
    this.watchers = new Map()
    this.reconnecting = false
    this.pendingManifestWrite = null

    this.assetsUrl = null
    this.snapshot = null
    this.loggedTarget = false
    this.scriptFormatWarnings = new Set()
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
      await this._bootstrapEmptyProject(snapshot)
    } else if (!hasWorldFile && hasApps) {
      throw new Error(
        'world.json missing; cannot safely apply exact world layout. ' +
          'Run "gamedev world export" to generate it from the world, or create world.json to seed a new world.'
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

  async _bootstrapEmptyProject(snapshot) {
    if (!this._isDefaultWorldSnapshot(snapshot)) {
      const err = new Error(
        'Local project is empty and this world already has content. ' +
          'Script code is not downloaded by default. ' +
          'Run "gamedev world export" to scaffold from the world (use --include-built-scripts for legacy apps).'
      )
      err.code = 'empty_project_requires_export'
      throw err
    }
    const manifest = await this._scaffoldLocalProject()
    await this._deployAllBlueprints()
    await this._applyManifestToWorld(manifest)
  }

  _isDefaultWorldSnapshot(snapshot) {
    const blueprints = Array.isArray(snapshot?.blueprints) ? snapshot.blueprints : []
    for (const blueprint of blueprints) {
      if (!blueprint?.id) continue
      if (!BUILTIN_BLUEPRINT_IDS.has(blueprint.id)) return false
    }
    const entities = Array.isArray(snapshot?.entities) ? snapshot.entities : []
    const appEntities = entities.filter(entity => entity?.type === 'app')
    if (appEntities.length > 1) return false
    if (appEntities.length === 1 && appEntities[0].blueprint !== SCENE_TEMPLATE.fileBase) return false
    return true
  }

  async _scaffoldLocalProject() {
    scaffoldBaseProject({ rootDir: this.rootDir, writeFile: this._writeFileAtomic.bind(this) })
    const { manifest } = scaffoldBuiltins({ rootDir: this.rootDir, writeFile: this._writeFileAtomic.bind(this) })
    this._writeWorldFile(manifest)
    return manifest
  }

  async stop() {
    this.reconnecting = false
    if (this.pendingManifestWrite) {
      clearTimeout(this.pendingManifestWrite)
      this.pendingManifestWrite = null
    }
    for (const timer of this.deployTimers.values()) {
      clearTimeout(timer)
    }
    this.deployTimers.clear()
    const watcherKeys = Array.from(this.watchers.keys())
    for (const key of watcherKeys) {
      this._closeWatcher(key)
    }
    try {
      this.client?.removeAllListeners?.('disconnect')
    } catch {}
    try {
      this.client?.ws?.close()
    } catch {}
  }

  async exportWorldToDisk(
    snapshot = this.snapshot,
    { includeBuiltScripts = false, includeScriptSources = true } = {}
  ) {
    const nextSnapshot = snapshot || (await this.client.getSnapshot())
    this.assetsUrl = nextSnapshot.assetsUrl
    if (!this.snapshot) this._initSnapshot(nextSnapshot)

    const manifest = this.manifest.fromSnapshot(nextSnapshot)
    this._writeWorldFile(manifest)

    const blueprints = Array.isArray(nextSnapshot.blueprints) ? nextSnapshot.blueprints : []
    const syncedScriptRoots = new Set()
    for (const blueprint of blueprints) {
      if (!blueprint?.id) continue
      const scriptRoot = this._resolveRemoteScriptRootBlueprint(blueprint)
      let shouldSyncScriptSources = false
      if (includeScriptSources && scriptRoot?.id && !syncedScriptRoots.has(scriptRoot.id)) {
        shouldSyncScriptSources = true
        syncedScriptRoots.add(scriptRoot.id)
      }
      await this._writeBlueprintToDisk({
        blueprint,
        force: true,
        includeBuiltScripts,
        includeScriptSources: shouldSyncScriptSources,
        pruneScriptSources: shouldSyncScriptSources,
        allowScriptOverwrite: includeBuiltScripts,
        scriptRoot,
      })
    }
  }

  async importWorldFromDisk() {
    const manifest = this.manifest.read()
    if (!manifest) {
      throw new Error('world.json missing. Run "gamedev world export" to generate it first.')
    }
    const errors = this.manifest.validate(manifest)
    if (errors.length) {
      throw new Error(`Invalid world.json:\n- ${errors.join('\n- ')}`)
    }
    await this._deployAllBlueprints()
    await this._applyManifestToWorld(manifest)
  }

  async deployApp(appName, options = {}) {
    await this._deployBlueprintsForApp(appName, null, null, { preview: true, ...options })
  }

  async deployBlueprint(id) {
    await this._deployBlueprintById(id)
  }

  _logTarget() {
    if (this.loggedTarget) return
    const worldId = this.snapshot?.worldId || 'unknown'
    console.log(`Deploy target: ${this.worldUrl} (worldId: ${worldId})`)
    this.loggedTarget = true
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
          try {
            await this._bootstrapEmptyProject(snapshot)
          } catch (err) {
            if (err?.code === 'empty_project_requires_export') {
              console.error(`❌ ${err.message}`)
              this.reconnecting = false
              return
            }
            throw err
          }
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
    const tsPath = path.join(appPath, 'index.js')
    const jsPath = path.join(appPath, 'index.js')
    if (fs.existsSync(tsPath)) return tsPath
    if (fs.existsSync(jsPath)) return jsPath
    return null
  }

  _getScriptFormat(appName) {
    const appPath = path.join(this.appsDir, appName)
    const primaryPath = path.join(appPath, `${appName}.json`)
    const primaryFormat = normalizeScriptFormat(readJson(primaryPath)?.scriptFormat)
    if (primaryFormat) return primaryFormat
    if (!fs.existsSync(appPath)) return null
    const entries = fs.readdirSync(appPath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!entry.name.endsWith('.json') || isBlueprintDenylist(entry.name)) continue
      const cfg = readJson(path.join(appPath, entry.name))
      const format = normalizeScriptFormat(cfg?.scriptFormat)
      if (format) return format
    }
    return null
  }

  _resolveAppScriptMode(appName) {
    const appPath = path.join(this.appsDir, appName)
    const entryPath = this._getScriptPath(appName)
    const scriptFormat = this._getScriptFormat(appName)
    const appFiles = listScriptFiles(appPath)
    const sharedRelPaths = collectSharedDependencies(appFiles, this.sharedDir)
    const sharedFiles = buildSharedFileEntries(sharedRelPaths, this.sharedDir)
    const filesByRelPath = new Map()
    for (const file of appFiles) {
      const relPath = normalizeScriptRelPath(file.relPath)
      filesByRelPath.set(relPath, { ...file, relPath })
    }
    for (const file of sharedFiles) {
      const relPath = normalizeScriptRelPath(file.relPath)
      if (filesByRelPath.has(relPath)) {
        console.warn(`⚠️  Shared script path conflicts with app file: ${appName}/${relPath}`)
        continue
      }
      filesByRelPath.set(relPath, { ...file, relPath })
    }
    return {
      appPath,
      entryPath,
      files: Array.from(filesByRelPath.values()).sort((a, b) => a.relPath.localeCompare(b.relPath)),
      scriptFormat,
      sharedRelPaths,
    }
  }

  _writeWorldFile(manifest) {
    if (isEqual(this.manifest.data, manifest)) return
    this._writeFileAtomic(this.worldFile, JSON.stringify(manifest, null, 2) + '\n')
    this.manifest.data = manifest
  }

  _startWatchers() {
    this._watchAppsDir()
    this._watchAssetsDir()
    this._watchSharedDir()
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
      if (!fs.existsSync(abs)) {
        this._closeWatchersUnderDir(abs)
        this._scheduleRemoveApp(filename, abs)
        return
      }
      if (!fs.statSync(abs).isDirectory()) return
      this._watchAppDir(filename)
    })
    this.watchers.set('appsDir', watcher)
  }

  _watchAppDir(appName) {
    const appPath = path.join(this.appsDir, appName)
    if (!fs.existsSync(appPath)) return
    this._watchAppDirRecursive(appName, appPath, appPath)
  }

  _watchAppDirRecursive(appName, dirPath, rootPath) {
    if (dirPath !== rootPath && SCRIPT_DIR_SKIP.has(path.basename(dirPath))) return
    this._watchAppPath(appName, dirPath, rootPath)
    let entries = []
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (SCRIPT_DIR_SKIP.has(entry.name)) continue
      this._watchAppDirRecursive(appName, path.join(dirPath, entry.name), rootPath)
    }
  }

  _watchAppPath(appName, dirPath, rootPath) {
    if (this.watchers.has(dirPath)) return
    const watcher = fs.watch(dirPath, { recursive: false }, (eventType, filename) => {
      if (!filename) return
      const abs = path.join(dirPath, filename)
      if (this.pendingWrites.has(abs)) return
      if (!fs.existsSync(abs) && eventType === 'change') return

      if (eventType === 'rename') {
        if (fs.existsSync(abs)) {
          let stats = null
          try {
            stats = fs.statSync(abs)
          } catch {}
          if (stats?.isDirectory()) {
            if (SCRIPT_DIR_SKIP.has(path.basename(abs))) return
            this._watchAppDirRecursive(appName, abs, rootPath)
            return
          }
        } else {
          this._closeWatchersUnderDir(abs)
        }
      }

      if (dirPath === rootPath && filename.endsWith('.json') && !isBlueprintDenylist(filename)) {
        const fileBase = path.basename(filename, '.json')
        const id = deriveBlueprintId(appName, fileBase)
        if (!fs.existsSync(abs)) {
          this._scheduleRemoveBlueprint(id, abs)
          return
        }
        this._scheduleDeployBlueprint(id)
        return
      }

      if (isScriptFilename(filename)) {
        this._scheduleDeployApp(appName)
      }
    })
    this.watchers.set(dirPath, watcher)
  }

  _watchSharedDir() {
    if (this.watchers.has(this.sharedDir)) return
    if (!fs.existsSync(this.sharedDir)) {
      if (this.watchers.has('sharedRoot')) return
      if (!fs.existsSync(this.rootDir)) return
      const watcher = fs.watch(this.rootDir, { recursive: false }, (eventType, filename) => {
        if (eventType !== 'rename' || filename !== SHARED_DIR_NAME) return
        const abs = path.join(this.rootDir, filename)
        if (!fs.existsSync(abs)) return
        if (!fs.statSync(abs).isDirectory()) return
        this._closeWatcher('sharedRoot')
        this._watchSharedDir()
      })
      this.watchers.set('sharedRoot', watcher)
      return
    }
    this._watchSharedDirRecursive(this.sharedDir, this.sharedDir)
  }

  _watchSharedDirRecursive(dirPath, rootPath) {
    if (dirPath !== rootPath && SCRIPT_DIR_SKIP.has(path.basename(dirPath))) return
    this._watchSharedPath(dirPath, rootPath)
    let entries = []
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (SCRIPT_DIR_SKIP.has(entry.name)) continue
      this._watchSharedDirRecursive(path.join(dirPath, entry.name), rootPath)
    }
  }

  _watchSharedPath(dirPath, rootPath) {
    if (this.watchers.has(dirPath)) return
    const watcher = fs.watch(dirPath, { recursive: false }, (eventType, filename) => {
      if (!filename) return
      const abs = path.join(dirPath, filename)
      if (this.pendingWrites.has(abs)) return
      if (!fs.existsSync(abs) && eventType === 'change') return

      if (eventType === 'rename') {
        if (fs.existsSync(abs)) {
          let stats = null
          try {
            stats = fs.statSync(abs)
          } catch {}
          if (stats?.isDirectory()) {
            if (SCRIPT_DIR_SKIP.has(path.basename(abs))) return
            this._watchSharedDirRecursive(abs, rootPath)
            return
          }
        } else {
          this._closeWatchersUnderDir(abs)
        }
      }

      if (!isScriptFilename(filename)) return
      const rel = normalizeScriptRelPath(path.relative(rootPath, abs))
      if (!rel) return
      const sharedRelPath = `${SHARED_IMPORT_PREFIX}${rel}`
      this._scheduleDeployAppsForSharedPath(sharedRelPath)
    })
    this.watchers.set(dirPath, watcher)
  }

  _scheduleDeployAppsForSharedPath(sharedRelPath) {
    const canonical = normalizeSharedSpecifier(sharedRelPath)
    if (!canonical) return
    const targets = this._getAppsUsingSharedPath(canonical)
    if (!targets.length) return
    for (const appName of targets) {
      this._scheduleDeployApp(appName)
    }
  }

  _getAppsUsingSharedPath(sharedRelPath) {
    if (!sharedRelPath) return []
    const apps = []
    for (const appName of listSubdirs(this.appsDir)) {
      const modeInfo = this._resolveAppScriptMode(appName)
      if (!modeInfo?.sharedRelPaths?.has(sharedRelPath)) continue
      apps.push(appName)
    }
    return apps
  }

  _closeWatcher(key) {
    const watcher = this.watchers.get(key)
    if (!watcher) return
    try {
      watcher.close()
    } catch {}
    this.watchers.delete(key)
  }

  _closeWatchersUnderDir(dirPath) {
    const prefix = dirPath.endsWith(path.sep) ? dirPath : `${dirPath}${path.sep}`
    for (const key of Array.from(this.watchers.keys())) {
      if (key === dirPath || key.startsWith(prefix)) {
        this._closeWatcher(key)
      }
    }
  }

  _scheduleRemoveApp(appName, appPath) {
    const key = `remove:app:${appName}`
    if (this.removeTimers.has(key)) clearTimeout(this.removeTimers.get(key))
    const timer = setTimeout(() => {
      this.removeTimers.delete(key)
      if (appPath && fs.existsSync(appPath)) return
      this._removeAppFromWorld(appName).catch(err => {
        console.warn(`⚠️  Failed to remove app ${appName} from world:`, err?.message || err)
      })
    }, 100)
    this.removeTimers.set(key, timer)
  }

  _scheduleRemoveBlueprint(id, configPath) {
    const key = `remove:blueprint:${id}`
    if (this.removeTimers.has(key)) clearTimeout(this.removeTimers.get(key))
    const timer = setTimeout(() => {
      this.removeTimers.delete(key)
      if (configPath && fs.existsSync(configPath)) return
      this._removeBlueprintsAndEntities([id]).catch(err => {
        console.warn(`⚠️  Failed to remove blueprint ${id}:`, err?.message || err)
      })
    }, 100)
    this.removeTimers.set(key, timer)
  }

  _getBlueprintIdsForApp(appName) {
    const ids = []
    if (!this.snapshot?.blueprints) return ids
    for (const id of this.snapshot.blueprints.keys()) {
      const parsed = parseBlueprintId(id)
      if (parsed.appName === appName) {
        ids.push(id)
      }
    }
    return ids
  }

  async _removeBlueprintsAndEntities(blueprintIds) {
    if (!Array.isArray(blueprintIds) || blueprintIds.length === 0) return
    const ids = Array.from(new Set(blueprintIds)).filter(Boolean)
    if (!ids.length) return

    const entityIds = []
    if (this.snapshot?.entities) {
      for (const entity of this.snapshot.entities.values()) {
        if (entity?.type !== 'app') continue
        if (ids.includes(entity.blueprint)) {
          entityIds.push(entity.id)
        }
      }
    }

    for (const id of entityIds) {
      try {
        await this.client.request('entity_remove', { id })
      } catch (err) {
        const code = err?.code || err?.message
        if (code === 'not_found') continue
        console.warn(`⚠️  Failed to remove entity ${id}:`, err?.message || err)
      }
    }

    for (const id of ids) {
      try {
        await this.client.removeBlueprint(id)
      } catch (err) {
        const code = err?.code || err?.message
        if (code === 'not_found') continue
        if (code === 'in_use') {
          console.warn(`⚠️  Blueprint ${id} is still in use and was not removed.`)
          continue
        }
        console.warn(`⚠️  Failed to remove blueprint ${id}:`, err?.message || err)
      }
    }
  }

  async _removeAppFromWorld(appName) {
    const ids = this._getBlueprintIdsForApp(appName)
    if (!ids.length) return
    await this._removeBlueprintsAndEntities(ids)
  }

  _watchWorldFile() {
    if (this.watchers.has('worldFile')) return
    if (!fs.existsSync(this.rootDir)) return
    const filename = path.basename(this.worldFile)
    const watcher = fs.watch(this.rootDir, { recursive: false }, (eventType, changed) => {
      if (eventType !== 'change' && eventType !== 'rename') return
      if (!changed || path.basename(changed) !== filename) return
      if (this.pendingWrites.has(this.worldFile)) return
      if (!fs.existsSync(this.worldFile)) return
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
      void this._writeManifestFromSnapshot().catch(err => {
        console.warn('⚠️  Failed to refresh world.json assets:', err?.message || err)
      })
    }, 250)
  }

  async _writeManifestFromSnapshot() {
    if (!this.snapshot) return
    const data = {
      settings: this.snapshot.settings,
      spawn: this.snapshot.spawn,
      entities: Array.from(this.snapshot.entities.values()),
    }
    const manifest = this.manifest.fromSnapshot(data)
    if (this.assetsUrl) {
      manifest.entities = await this._localizeEntityProps(manifest.entities, {
        existingManifest: this.manifest.data,
      })
    }
    this._writeWorldFile(manifest)
  }

  async _localizeEntityProps(entities, { existingManifest } = {}) {
    if (!Array.isArray(entities) || entities.length === 0) return entities
    const existingById = new Map()
    if (Array.isArray(existingManifest?.entities)) {
      for (const entity of existingManifest.entities) {
        if (entity?.id) existingById.set(entity.id, entity)
      }
    }
    const localized = []
    for (const entity of entities) {
      if (!entity || typeof entity !== 'object') {
        localized.push(entity)
        continue
      }
      const props =
        entity.props && typeof entity.props === 'object' && !Array.isArray(entity.props)
          ? entity.props
          : null
      if (!props) {
        localized.push(entity)
        continue
      }
      const existingEntity = existingById.get(entity.id)
      const existingProps =
        existingEntity?.props && typeof existingEntity.props === 'object' && !Array.isArray(existingEntity.props)
          ? existingEntity.props
          : null
      const parsed = parseBlueprintId(entity.blueprint || '')
      const appName = parsed?.appName || 'app'
      const nextProps = {}
      for (const [key, value] of Object.entries(props)) {
        if (value && typeof value === 'object' && typeof value.url === 'string') {
          const ext = path.extname(value.url) || ''
          const suggested = sanitizeFileBaseName(value.name || key) + ext
          const existingUrl =
            existingProps?.[key] && typeof existingProps[key] === 'object' ? existingProps[key].url : null
          const url = await this._maybeDownloadAsset(appName, value.url, suggested, { existingUrl })
          nextProps[key] = { ...value, url }
        } else {
          nextProps[key] = value
        }
      }
      localized.push({ ...entity, props: nextProps })
    }
    return localized
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

  _getDeployLockOwner(appName = null) {
    const target = process.env.HYPERFY_TARGET || 'default'
    const label = appName ? `:${appName}` : ''
    return `app-server${label}:${target}:${process.pid}`
  }

  async _acquireDeployLock({ owner, scope } = {}) {
    const lockOwner = owner || this._getDeployLockOwner()
    const result = await this.client.acquireDeployLock({ owner: lockOwner, scope })
    return { token: result.token, scope }
  }

  async _releaseDeployLock({ token, scope } = {}) {
    if (!token) return
    await this.client.releaseDeployLock({ token, scope })
  }

  async _withDeployLock(fn, { owner, scope } = {}) {
    const lock = await this._acquireDeployLock({ owner, scope })
    try {
      return await fn(lock)
    } finally {
      await this._releaseDeployLock(lock)
    }
  }

  _getDeployTargetName() {
    return process.env.HYPERFY_TARGET || null
  }

  _resolveScriptRootId(appName, infos, index = null) {
    const candidates = index
      ? Array.from(index.values()).filter(item => item.appName === appName)
      : infos
    const root = candidates.find(info => info.id === appName || info.fileBase === appName)
    if (root?.id) return root.id
    return infos[0]?.id || candidates[0]?.id || null
  }

  _buildScriptPayload(info, scriptInfo) {
    const payload = {
      scriptEntry: null,
      scriptFiles: null,
      scriptFormat: null,
      scriptRef: null,
    }
    if (!scriptInfo || scriptInfo.mode !== 'module') return payload
    const rootId = scriptInfo.scriptRootId || info.appName || info.id
    if (info.id === rootId) {
      payload.scriptEntry = scriptInfo.scriptEntry
      payload.scriptFiles = scriptInfo.scriptFiles
      payload.scriptFormat = scriptInfo.scriptFormat
      payload.scriptRef = null
      return payload
    }
    payload.scriptRef = rootId
    return payload
  }

  async _prepareBlueprintPayload(info, scriptInfo, { uploadAssets = true } = {}) {
    const cfg = readJson(info.configPath)
    if (!cfg || typeof cfg !== 'object') {
      throw new Error(`invalid_blueprint_config:${info.configPath}`)
    }
    const payload = {
      id: info.id,
      name: info.fileBase,
      script: scriptInfo.scriptUrl,
      ...this._buildScriptPayload(info, scriptInfo),
      ...pickBlueprintFields(cfg),
    }
    return this._resolveLocalBlueprintToAssetUrls(payload, { upload: uploadAssets })
  }

  async _buildDeployPlan(
    appName,
    infos,
    { uploadAssets = false, uploadScripts = false, index = null } = {}
  ) {
    const scriptInfo = await this._uploadScriptForApp(appName, infos[0].scriptPath, {
      upload: uploadScripts,
    })
    if (scriptInfo?.mode === 'module') {
      scriptInfo.scriptRootId = this._resolveScriptRootId(appName, infos, index)
    }
    const changes = []
    for (const info of infos) {
      const desired = await this._prepareBlueprintPayload(info, scriptInfo, { uploadAssets })
      const current = this.snapshot?.blueprints?.get(info.id) || null
      if (!current) {
        changes.push({ info, desired, current: null, type: 'add', scriptChanged: true, otherChanged: true })
        continue
      }
      const desiredCompare = normalizeBlueprintForCompare(desired)
      const currentCompare = normalizeBlueprintForCompare(current)
      if (isEqual(desiredCompare, currentCompare)) {
        changes.push({ info, desired, current, type: 'unchanged', scriptChanged: false, otherChanged: false })
        continue
      }
      const desiredScript = normalizeBlueprintScriptFields(desired)
      const currentScript = normalizeBlueprintScriptFields(current)
      const scriptChanged = !isEqual(desiredScript, currentScript)
      const desiredNoScript = normalizeBlueprintForCompareWithoutScript(desired)
      const currentNoScript = normalizeBlueprintForCompareWithoutScript(current)
      const otherChanged = !isEqual(desiredNoScript, currentNoScript)
      changes.push({ info, desired, current, type: 'update', scriptChanged, otherChanged })
    }
    return { scriptInfo, changes }
  }

  _summarizeDeployPlan(plan) {
    const adds = plan.changes.filter(item => item.type === 'add')
    const updates = plan.changes.filter(item => item.type === 'update')
    const unchanged = plan.changes.filter(item => item.type === 'unchanged')
    const scriptChanges = updates.filter(item => item.scriptChanged).length
    const configChanges = updates.filter(item => item.otherChanged).length
    return {
      adds,
      updates,
      unchanged,
      scriptChanges,
      configChanges,
      totalChanges: adds.length + updates.length,
    }
  }

  _printDeployPlan(appName, summary) {
    const addNames = summary.adds.map(item => item.info?.fileBase || item.desired?.name || item.info?.id)
    const updateNames = summary.updates.map(item => item.info?.fileBase || item.desired?.name || item.info?.id)
    const unchangedCount = summary.unchanged.length
    console.log(`📦 Deploy plan for ${appName}:`)
    if (!summary.totalChanges) {
      console.log('  • no changes')
      return
    }
    if (summary.adds.length) {
      console.log(`  • add: ${summary.adds.length}${addNames.length ? ` (${formatNameList(addNames)})` : ''}`)
    }
    if (summary.updates.length) {
      const details = []
      if (summary.scriptChanges) details.push(`script: ${summary.scriptChanges}`)
      if (summary.configChanges) details.push(`config: ${summary.configChanges}`)
      const detailText = details.length ? ` [${details.join(', ')}]` : ''
      console.log(`  • update: ${summary.updates.length}${detailText}${updateNames.length ? ` (${formatNameList(updateNames)})` : ''}`)
    }
    if (unchangedCount) {
      console.log(`  • unchanged: ${unchangedCount}`)
    }
  }

  async _createDeploySnapshot(blueprintIds, { note, lockToken, scope } = {}) {
    if (!blueprintIds.length) return null
    const target = this._getDeployTargetName()
    return this.client.createDeploySnapshot({
      ids: blueprintIds,
      target,
      note,
      lockToken,
      scope,
    })
  }

  async _deployAllBlueprints() {
    this._logTarget()
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

  async _deployBlueprintsForApp(appName, infos = null, index = null, options = {}) {
    const prior = this.deployQueues.get(appName) || Promise.resolve()
    const run = prior
      .catch(() => {})
      .then(() => this._deployBlueprintsForAppInternal(appName, infos, index, options))
    let chained = run
    chained = run.finally(() => {
      if (this.deployQueues.get(appName) === chained) {
        this.deployQueues.delete(appName)
      }
    })
    this.deployQueues.set(appName, chained)
    return chained
  }

  async _deployBlueprintsForAppInternal(appName, infos = null, index = null, options = {}) {
    this._logTarget()
    const blueprintIndex = index || this._indexLocalBlueprints()
    const list = infos || Array.from(blueprintIndex.values()).filter(item => item.appName === appName)
    if (!list.length) return

    const preview = !!options.preview || !!options.dryRun
    const note = typeof options.note === 'string' && options.note.trim() ? options.note.trim() : null
    const plan = await this._buildDeployPlan(appName, list, { index: blueprintIndex })
    const summary = this._summarizeDeployPlan(plan)
    if (preview) {
      this._printDeployPlan(appName, summary)
    }
    if (!summary.totalChanges) return
    if (options.dryRun) return

    const snapshotIds = [...summary.adds, ...summary.updates]
      .map(item => item.info?.id)
      .filter(Boolean)
    const snapshotNote = note || process.env.DEPLOY_NOTE || null

    await this._withDeployLock(async lock => {
      await this._createDeploySnapshot(snapshotIds, { note: snapshotNote, lockToken: lock.token, scope: lock.scope })
      const scriptInfo = await this._uploadScriptForApp(appName, list[0].scriptPath)
      if (scriptInfo?.mode === 'module') {
        scriptInfo.scriptRootId = this._resolveScriptRootId(appName, list, blueprintIndex)
      }
      for (const info of list) {
        await this._deployBlueprint(info, scriptInfo, { lockToken: lock.token })
      }
    }, { owner: this._getDeployLockOwner(appName), scope: appName })
  }

  async _uploadScriptForApp(appName, scriptPath = null, { upload = true } = {}) {
    const modeInfo = this._resolveAppScriptMode(appName)
    return this._uploadScriptFilesForApp(appName, modeInfo, { upload })
  }

  async _uploadScriptFilesForApp(appName, modeInfo, { upload = true } = {}) {
    const appPath = modeInfo?.appPath || path.join(this.appsDir, appName)
    const entryPath = modeInfo?.entryPath || this._getScriptPath(appName)
    if (!entryPath || !fs.existsSync(entryPath)) {
      throw new Error(`missing_script_entry:${appName}`)
    }

    const files = Array.isArray(modeInfo?.files) && modeInfo.files.length
      ? modeInfo.files
      : listScriptFiles(appPath)
    if (!files.length) {
      throw new Error(`missing_script_files:${appName}`)
    }
    const sharedRelPaths = modeInfo?.sharedRelPaths
    if (sharedRelPaths && sharedRelPaths.size) {
      const fileRelPaths = new Set(files.map(file => normalizeScriptRelPath(file.relPath)))
      const missing = []
      for (const relPath of sharedRelPaths) {
        if (!fileRelPaths.has(relPath)) {
          missing.push(relPath)
        }
      }
      if (missing.length) {
        throw new Error(`missing_shared_scripts:${formatNameList(missing)}`)
      }
    }

    const scriptEntry = normalizeScriptRelPath(path.relative(appPath, entryPath))
    const scriptFiles = {}
    let entryText = null
    let entryHash = null
    let entryUrl = null

    for (const file of files) {
      const relPath = normalizeScriptRelPath(file.relPath)
      const buffer = fs.readFileSync(file.absPath)
      const hash = sha256(buffer)
      const ext = path.extname(file.absPath) || '.js'
      const filename = `${hash}${ext}`
      if (upload) {
        await this.client.uploadAsset({
          filename,
          buffer,
          mimeType: 'text/javascript',
        })
      }
      const assetUrl = `asset://${filename}`
      scriptFiles[relPath] = assetUrl
      if (relPath === scriptEntry) {
        entryText = buffer.toString('utf8')
        entryHash = hash
        entryUrl = assetUrl
      }
    }

    if (!entryUrl) {
      throw new Error(`missing_script_entry:${appName}`)
    }

    let scriptFormat = normalizeScriptFormat(modeInfo?.scriptFormat)
    if (!scriptFormat) {
      const hasDefaultExport = entryHasDefaultExport(entryText)
      if (hasDefaultExport) {
        scriptFormat = 'module'
      } else {
        scriptFormat = 'legacy-body'
        if (!this.scriptFormatWarnings.has(appName)) {
          this.scriptFormatWarnings.add(appName)
          console.warn(
            `⚠️  Missing scriptFormat for ${appName}; defaulting to legacy-body. ` +
              `Add "scriptFormat": "legacy-body" or update the entry to export default for module mode.`
          )
        }
      }
    }
    return {
      mode: 'module',
      scriptUrl: entryUrl,
      scriptEntry,
      scriptFiles,
      scriptFormat,
      scriptPath: entryPath,
      scriptText: entryText,
      scriptHash: entryHash,
    }
  }

  async _deployBlueprint(info, scriptInfo, { lockToken } = {}) {
    const cfg = readJson(info.configPath)
    if (!cfg || typeof cfg !== 'object') {
      console.error(`❌ Invalid blueprint config: ${info.configPath}`)
      return
    }

    const payload = {
      id: info.id,
      name: info.fileBase,
      script: scriptInfo.scriptUrl,
      ...this._buildScriptPayload(info, scriptInfo),
      ...pickBlueprintFields(cfg),
    }

    const resolved = await this._resolveLocalBlueprintToAssetUrls(payload)

    const current = this.snapshot?.blueprints?.get(info.id) || null
    if (!current) {
      resolved.version = 0
      await this.client.request('blueprint_add', { blueprint: resolved, lockToken })
    } else {
      const nextCompare = normalizeBlueprintForCompare(resolved)
      const currentCompare = normalizeBlueprintForCompare(current)
      if (isEqual(nextCompare, currentCompare)) return
      const attempt = async version => {
        resolved.version = version
        await this.client.request('blueprint_modify', { change: resolved, lockToken })
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

  async _resolveLocalBlueprintToAssetUrls(cfg, { upload = true } = {}) {
    const out = { ...cfg }

    if (typeof out.model === 'string') {
      out.model = await this._resolveLocalAssetToWorldUrl(out.model, { upload })
    }

    if (out.image && typeof out.image === 'object' && typeof out.image.url === 'string') {
      out.image = { ...out.image, url: await this._resolveLocalAssetToWorldUrl(out.image.url, { upload }) }
    }

    if (out.props && typeof out.props === 'object') {
      const nextProps = {}
      for (const [k, v] of Object.entries(out.props)) {
        if (v && typeof v === 'object' && typeof v.url === 'string') {
          nextProps[k] = { ...v, url: await this._resolveLocalAssetToWorldUrl(v.url, { upload }) }
        } else {
          nextProps[k] = v
        }
      }
      out.props = nextProps
    }

    return out
  }

  async _resolveLocalEntityPropsToAssetUrls(props, { upload = true } = {}) {
    if (!props || typeof props !== 'object' || Array.isArray(props)) return {}
    const nextProps = {}
    for (const [key, value] of Object.entries(props)) {
      if (value && typeof value === 'object' && typeof value.url === 'string') {
        nextProps[key] = {
          ...value,
          url: await this._resolveLocalAssetToWorldUrl(value.url, { upload }),
        }
      } else {
        nextProps[key] = value
      }
    }
    return nextProps
  }

  async _resolveLocalAssetToWorldUrl(url, { upload = true } = {}) {
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
    if (upload) {
      await this.client.uploadAsset({ filename, buffer })
    }
    return `asset://${filename}`
  }

  async _applyManifestToWorld(manifest) {
    if (!this.snapshot) return
    this._logTarget()

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
      const desiredProps =
        entity.props && typeof entity.props === 'object' && !Array.isArray(entity.props) ? entity.props : {}
      const resolvedProps = await this._resolveLocalEntityPropsToAssetUrls(desiredProps)
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
          props: resolvedProps,
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
      const existingProps =
        existing.props && typeof existing.props === 'object' && !Array.isArray(existing.props) ? existing.props : {}
      if (!isEqual(existingProps, resolvedProps)) change.props = resolvedProps
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
    await this._writeBlueprintToDisk({
      blueprint,
      force: true,
      includeBuiltScripts: true,
      includeScriptSources: true,
      pruneScriptSources: true,
    })
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
    this._maybeRemoveEmptyAppFolder(parsed.appName)
  }

  _maybeRemoveEmptyAppFolder(appName) {
    const appPath = path.join(this.appsDir, appName)
    if (!fs.existsSync(appPath)) return
    let entries = []
    try {
      entries = fs.readdirSync(appPath, { withFileTypes: true })
    } catch {
      return
    }
    const hasBlueprint = entries.some(entry => {
      if (!entry.isFile()) return false
      if (!entry.name.endsWith('.json')) return false
      return !isBlueprintDenylist(entry.name)
    })
    if (hasBlueprint) return
    this._closeWatchersUnderDir(appPath)
    try {
      fs.rmSync(appPath, { recursive: true, force: true })
    } catch (err) {
      console.warn(`⚠️  Failed to delete app folder: ${appPath}`)
    }
  }

  async _writeBlueprintToDisk({
    blueprint,
    force,
    includeBuiltScripts = false,
    includeScriptSources = true,
    allowScriptOverwrite = false,
    pruneScriptSources = false,
    scriptRoot = null,
  }) {
    const { appName, fileBase } = parseBlueprintId(blueprint.id)
    const appPath = path.join(this.appsDir, appName)
    ensureDir(appPath)

    const blueprintPath = path.join(appPath, `${fileBase}.json`)
    const existingConfig = readJson(blueprintPath)
    const localBlueprint = await this._blueprintToLocalConfig(appName, blueprint, { existingConfig })
    if (force || !fs.existsSync(blueprintPath)) {
      this._writeFileAtomic(blueprintPath, JSON.stringify(localBlueprint, null, 2) + '\n')
    } else {
      if (!isEqual(existingConfig, localBlueprint)) {
        this._writeFileAtomic(blueprintPath, JSON.stringify(localBlueprint, null, 2) + '\n')
      }
    }

    const resolvedScriptRoot = scriptRoot || this._resolveRemoteScriptRootBlueprint(blueprint)
    if (resolvedScriptRoot) {
      if (includeScriptSources) {
        await this._syncScriptSourcesToDisk(appName, resolvedScriptRoot, { pruneMissing: pruneScriptSources })
      }
      return
    }

    const hasRemoteScript = typeof blueprint.script === 'string'
    if (includeBuiltScripts && hasRemoteScript) {
      const existingScriptPath = this._getScriptPath(appName)
      const scriptPath = existingScriptPath || path.join(appPath, 'index.js')
      const shouldWriteScript = allowScriptOverwrite || !existingScriptPath
      if (shouldWriteScript) {
        const script = await this._downloadScript(blueprint.script)
        if (script != null) {
          this._writeFileAtomic(scriptPath, script)
        }
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

  _resolveRemoteScriptRootBlueprint(blueprint) {
    if (!blueprint || typeof blueprint !== 'object') return null
    if (hasScriptFiles(blueprint)) return blueprint
    const scriptRef = typeof blueprint.scriptRef === 'string' ? blueprint.scriptRef.trim() : ''
    if (scriptRef) {
      const root = this.snapshot?.blueprints?.get(scriptRef)
      if (root && hasScriptFiles(root)) return root
    }
    const parsed = parseBlueprintId(blueprint.id || '')
    if (parsed.appName && parsed.appName !== blueprint.id) {
      const base = this.snapshot?.blueprints?.get(parsed.appName)
      if (base && hasScriptFiles(base)) return base
    }
    return null
  }

  async _syncScriptSourcesToDisk(appName, scriptRoot, { pruneMissing = false } = {}) {
    if (!scriptRoot || !hasScriptFiles(scriptRoot)) return false
    const appPath = path.join(this.appsDir, appName)
    ensureDir(appPath)
    const scriptFiles = scriptRoot.scriptFiles
    const keepApp = new Set()
    for (const [relPath, assetUrl] of Object.entries(scriptFiles)) {
      if (!isValidScriptPath(relPath)) {
        console.warn(`⚠️  Invalid script path in ${scriptRoot.id || appName}: ${relPath}`)
        continue
      }
      if (typeof assetUrl !== 'string' || !assetUrl.startsWith('asset://')) {
        console.warn(`⚠️  Invalid script asset in ${scriptRoot.id || appName}: ${relPath}`)
        continue
      }
      const normalized = normalizeScriptRelPath(relPath)
      const sharedRel = getSharedDiskRelativePath(normalized)
      if (!sharedRel) {
        keepApp.add(normalized)
      }
      const script = await this._downloadScript(assetUrl)
      if (script == null) continue
      const absPath = sharedRel ? path.join(this.sharedDir, sharedRel) : path.join(appPath, normalized)
      this._writeFileAtomic(absPath, script)
    }

    if (pruneMissing) {
      const localFiles = listScriptFiles(appPath)
      for (const file of localFiles) {
        const normalized = normalizeScriptRelPath(file.relPath)
        if (keepApp.has(normalized)) continue
        this._deleteFileAtomic(file.absPath)
        this._pruneEmptyDirs(appPath, path.dirname(file.absPath))
      }
    }
    return true
  }

  async _blueprintToLocalConfig(appName, blueprint, { existingConfig } = {}) {
    const output = {}
    const existing =
      existingConfig && typeof existingConfig === 'object' && !Array.isArray(existingConfig)
        ? existingConfig
        : null
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
    const scriptFormat = normalizeScriptFormat(blueprint.scriptFormat)
    if (scriptFormat) output.scriptFormat = scriptFormat

    if (typeof blueprint.model === 'string') {
      const existingModel = typeof existing?.model === 'string' ? existing.model : null
      output.model = await this._maybeDownloadAsset(
        appName,
        blueprint.model,
        `${appName}${path.extname(blueprint.model) || '.glb'}`,
        { existingUrl: existingModel }
      )
    } else if (blueprint.model !== undefined) {
      output.model = blueprint.model
    }

    if (blueprint.image && typeof blueprint.image === 'object') {
      const img = { ...blueprint.image }
      if (typeof img.url === 'string') {
        const existingImageUrl = getExistingAssetUrl(existing?.image)
        const ext = path.extname(img.url) || '.png'
        img.url = await this._maybeDownloadAsset(appName, img.url, `${appName}__image${ext}`, {
          existingUrl: existingImageUrl,
        })
      }
      output.image = img
    } else if (blueprint.image == null) {
      output.image = null
    } else if (blueprint.image !== undefined) {
      output.image = blueprint.image
    }

    if (blueprint.props && typeof blueprint.props === 'object') {
      const props = {}
      const existingProps =
        existing?.props && typeof existing.props === 'object' && !Array.isArray(existing.props)
          ? existing.props
          : null
      for (const [key, value] of Object.entries(blueprint.props)) {
        if (value && typeof value === 'object' && typeof value.url === 'string') {
          const v = { ...value }
          const ext = path.extname(v.url) || ''
          const suggested = sanitizeFileBaseName(v.name || key) + ext
          const existingUrl =
            existingProps?.[key] && typeof existingProps[key] === 'object' ? existingProps[key].url : null
          v.url = await this._maybeDownloadAsset(appName, v.url, suggested, { existingUrl })
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

  async _maybeDownloadAsset(appName, url, suggestedName, { existingUrl } = {}) {
    if (typeof url !== 'string') return url
    if (url.startsWith('assets/')) return url
    if (!url.startsWith('asset://')) return url

    const filename = extractAssetFilename(url)
    if (!filename) return url

    const ext = path.extname(filename).toLowerCase()
    const expectedHash = isHashedAssetFilename(filename) ? filename.slice(0, -ext.length).toLowerCase() : null
    const normalizedExisting = typeof existingUrl === 'string' ? normalizeAssetPath(existingUrl) : null
    if (normalizedExisting && normalizedExisting.startsWith('assets/')) {
      const existingBase = path.basename(normalizedExisting)
      const existingExt = path.extname(existingBase).toLowerCase()
      if (!existingExt || existingExt === ext) {
        suggestedName = existingBase
      }
      if (expectedHash) {
        const absExisting = path.join(this.rootDir, normalizedExisting)
        if (fs.existsSync(absExisting)) {
          const existingHash = sha256(fs.readFileSync(absExisting))
          if (existingHash === expectedHash) return normalizedExisting
        }
      }
    }

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

  _deleteFileAtomic(filePath) {
    this.pendingWrites.add(filePath)
    try {
      fs.rmSync(filePath, { force: true })
    } catch {}
    setTimeout(() => this.pendingWrites.delete(filePath), 500)
  }

  _pruneEmptyDirs(rootDir, startDir) {
    let current = startDir
    while (current && current !== rootDir && current.startsWith(rootDir)) {
      let entries = []
      try {
        entries = fs.readdirSync(current)
      } catch {
        break
      }
      if (entries.length) break
      try {
        fs.rmdirSync(current)
      } catch {
        break
      }
      current = path.dirname(current)
    }
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
  const deployCode = process.env.DEPLOY_CODE
  if (!worldUrl) {
    console.error('Missing env WORLD_URL (e.g. http://localhost:3000)')
    process.exit(1)
  }
  const server = new DirectAppServer({ worldUrl, adminCode, deployCode })
  await server.start()
  const shutdown = async () => {
    await server.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  await new Promise(() => {})
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
