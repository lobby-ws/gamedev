import fs from 'fs'
import fsPromises from 'fs/promises'
import path from 'path'
import os from 'os'
import net from 'net'
import crypto from 'crypto'
import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import { fileURLToPath } from 'url'

import { readPacket, writePacket } from '../../src/core/packets.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..')
let buildReadyPromise = null
const buildLockDir = path.join(repoRoot, '.build-test-lock')
const buildOutputPath = path.join(repoRoot, 'build', 'index.js')
const buildInputs = [
  path.join(repoRoot, 'scripts', 'build.mjs'),
  path.join(repoRoot, 'package.json'),
  path.join(repoRoot, 'src'),
  path.join(repoRoot, 'app-server'),
]

function normalizeBaseUrl(url) {
  if (!url) return ''
  return url.replace(/\/+$/, '')
}

function toWsUrl(httpUrl) {
  const url = normalizeBaseUrl(httpUrl)
  if (url.startsWith('https://')) return `wss://${url.slice('https://'.length)}`
  if (url.startsWith('http://')) return `ws://${url.slice('http://'.length)}`
  return url
}

export function getRepoRoot() {
  return repoRoot
}

export async function createTempDir(prefix = 'hyperfy-test-') {
  return fsPromises.mkdtemp(path.join(os.tmpdir(), prefix))
}

export async function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

export async function waitFor(fn, { timeoutMs = 5000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const result = await fn()
      if (result) return result
    } catch {}
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new Error('timeout')
}

export async function waitForHealth(worldUrl, { timeoutMs = 20000 } = {}) {
  const healthUrl = `${normalizeBaseUrl(worldUrl)}/health`
  await waitFor(async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    try {
      const res = await fetch(healthUrl, { signal: controller.signal })
      return res.ok
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }, { timeoutMs, intervalMs: 200 })
}

async function ensureBuildReady() {
  if (buildReadyPromise) {
    await buildReadyPromise
    return
  }

  buildReadyPromise = (async () => {
    await withBuildLock(async () => {
      const needsBuild = await shouldRebuild()
      if (!needsBuild) return
      await runBuild()
    })
  })().catch(err => {
    buildReadyPromise = null
    throw err
  })

  await buildReadyPromise
}

async function runBuild() {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/build.mjs'], {
      cwd: repoRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })

    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`build failed (exit ${code})\n${stdout}\n${stderr}`.trim()))
    })
  })
}

async function withBuildLock(fn, { timeoutMs = 180000 } = {}) {
  const startedAt = Date.now()
  while (true) {
    try {
      await fsPromises.mkdir(buildLockDir)
      break
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`timed out waiting for build lock at ${buildLockDir}`)
      }
      await new Promise(resolve => setTimeout(resolve, 120))
    }
  }
  try {
    return await fn()
  } finally {
    await fsPromises.rm(buildLockDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function shouldRebuild() {
  let outputStat
  try {
    outputStat = await fsPromises.stat(buildOutputPath)
  } catch {
    return true
  }

  const latestInputMtime = await getLatestMtime(buildInputs)
  return latestInputMtime > outputStat.mtimeMs
}

async function getLatestMtime(paths) {
  let latest = 0
  for (const entryPath of paths) {
    const next = await getPathLatestMtime(entryPath)
    if (next > latest) latest = next
  }
  return latest
}

async function getPathLatestMtime(entryPath) {
  let stats
  try {
    stats = await fsPromises.stat(entryPath)
  } catch {
    return 0
  }

  let latest = stats.mtimeMs || 0
  if (!stats.isDirectory()) return latest

  let entries
  try {
    entries = await fsPromises.readdir(entryPath, { withFileTypes: true })
  } catch {
    return latest
  }

  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const childPath = path.join(entryPath, entry.name)
    const childLatest = await getPathLatestMtime(childPath)
    if (childLatest > latest) latest = childLatest
  }

  return latest
}

export async function startWorldServer({ adminCode = 'admin' } = {}) {
  await ensureBuildReady()
  const port = await getAvailablePort()
  const worldDir = await createTempDir('hyperfy-world-')
  const worldId = `test-${crypto.randomUUID()}`
  const worldUrl = `http://127.0.0.1:${port}`
  const wsUrl = `${toWsUrl(worldUrl)}/ws`
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    WORLD: worldDir,
    WORLD_ID: worldId,
    ADMIN_CODE: adminCode,
    JWT_SECRET: crypto.randomBytes(24).toString('base64url'),
    PUBLIC_WS_URL: wsUrl,
    PUBLIC_API_URL: `${worldUrl}/api`,
    PUBLIC_ADMIN_URL: `${worldUrl}/admin`,
    PUBLIC_MAX_UPLOAD_SIZE: '12',
    ASSETS: 'local',
    ASSETS_BASE_URL: `${worldUrl}/assets`,
    DB_URI: 'local',
    CLEAN: 'true',
    HOST: '127.0.0.1',
  }

  const serverPath = path.join(repoRoot, 'build', 'index.js')
  const child = spawn(process.execPath, [serverPath], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', chunk => {
    stderr += chunk.toString()
  })

  try {
    await waitForHealth(worldUrl)
  } catch (err) {
    child.kill('SIGTERM')
    throw new Error(`world server failed to start\n${stdout}\n${stderr}`.trim())
  }

  async function stop() {
    if (!child || child.killed) return
    child.kill('SIGTERM')
    await new Promise(resolve => {
      child.once('exit', resolve)
      setTimeout(resolve, 2000)
    })
  }

  return {
    worldUrl,
    wsUrl,
    worldId,
    worldDir,
    adminCode,
    stop,
  }
}

export class AdminWsClient {
  constructor({ worldUrl, adminCode, subscriptions } = {}) {
    this.worldUrl = normalizeBaseUrl(worldUrl)
    this.adminCode = adminCode || null
    this.subscriptions = subscriptions || { snapshot: true, players: false, runtime: false }
    this.ws = null
    this.pending = new Map()
    this.events = new EventEmitter()
  }

  async connect() {
    const wsUrl = `${toWsUrl(this.worldUrl)}/admin`
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl)
      ws.binaryType = 'arraybuffer'
      this.ws = ws

      const cleanup = () => {
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('message', onMessage)
        ws.removeEventListener('error', onError)
        ws.removeEventListener('close', onClose)
      }

      const onOpen = () => {
        ws.send(
          writePacket('adminAuth', {
            code: this.adminCode,
            subscriptions: this.subscriptions,
          })
        )
      }

      const onMessage = event => {
        const [method, data] = readPacket(event.data)
        if (!method) return
        if (method === 'onAdminAuthOk') {
          cleanup()
          this._attachHandlers(ws)
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

      ws.addEventListener('open', onOpen)
      ws.addEventListener('message', onMessage)
      ws.addEventListener('error', onError)
      ws.addEventListener('close', onClose)
    })
  }

  _attachHandlers(ws) {
    ws.addEventListener('message', event => {
      const [method, data] = readPacket(event.data)
      if (!method) return

      if (method === 'onAdminResult') {
        const requestId = data?.requestId
        const pending = requestId ? this.pending.get(requestId) : null
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
      if (!type) return
      const name = type.charAt(0).toLowerCase() + type.slice(1)
      this.events.emit(name, data)
    })
  }

  request(type, payload = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('not_connected'))
    }
    const requestId = crypto.randomUUID()
    const message = { type, requestId, ...payload }
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject })
      this.ws.send(writePacket('adminCommand', message))
    })
  }

  waitForEvent(name, { timeoutMs = 2000 } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.events.removeListener(name, onEvent)
        reject(new Error('timeout'))
      }, timeoutMs)
      const onEvent = data => {
        clearTimeout(timer)
        resolve(data)
      }
      this.events.once(name, onEvent)
    })
  }

  close() {
    try {
      this.ws?.close()
    } catch {}
  }
}

export async function stopAppServer(server) {
  if (!server) return
  if (typeof server.stop === 'function') {
    await server.stop()
    return
  }
  server.reconnecting = false
  if (server.pendingManifestWrite) {
    clearTimeout(server.pendingManifestWrite)
    server.pendingManifestWrite = null
  }
  for (const timer of server.deployTimers?.values() || []) {
    clearTimeout(timer)
  }
  if (server.watchers) {
    for (const watcher of server.watchers.values()) {
      try {
        watcher.close()
      } catch {}
    }
    server.watchers.clear()
  }
  if (server.appWatchers?.size) {
    const entries = Array.from(server.appWatchers.values())
    server.appWatchers.clear()
    for (const entry of entries) {
      entry.disposed = true
      try {
        await entry.ready
        if (entry.dispose) {
          await entry.dispose()
        }
      } catch {}
    }
  }
  try {
    server.client?.removeAllListeners?.('disconnect')
  } catch {}
  try {
    server.client?.ws?.close()
  } catch {}
}

export async function fetchJson(url, { adminCode, method = 'GET', body } = {}) {
  const headers = {}
  if (adminCode) headers['X-Admin-Code'] = adminCode
  if (body) headers['Content-Type'] = 'application/json'
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => null)
  return { res, data }
}

export function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null
  const raw = fs.readFileSync(filePath, 'utf8')
  return JSON.parse(raw)
}
