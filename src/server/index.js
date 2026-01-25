import 'ses'
import '../core/lockdown'
import './bootstrap'

import fs from 'fs-extra'
import path from 'path'
import Fastify from 'fastify'
import ws from '@fastify/websocket'
import cors from '@fastify/cors'
import compress from '@fastify/compress'
import statics from '@fastify/static'
import multipart from '@fastify/multipart'

import { createServerWorld } from '../core/createServerWorld'
import { getDB } from './db'
import { Storage } from './Storage'
import { assets } from './assets'
import { cleaner } from './cleaner'
import { admin } from './admin'
import { createRegistryState, getRegistryPublicStatus, registerWithRegistry } from './registry'

const rootDir = path.join(__dirname, '../')
// Resolve world directory relative to the consumer project (cwd), not the package root
const worldDir = path.resolve(process.cwd(), process.env.WORLD)
const port = process.env.PORT

function formatUserName(name) {
  if (!name || name.startsWith('anon_')) return 'Anonymous'
  return name
}

function resolveDocsRoot() {
  const candidates = [
    path.join(process.cwd(), 'docs'),
    path.join(process.cwd(), 'build', 'docs'),
    path.join(process.cwd(), 'public', 'docs'),
    path.join(rootDir, 'docs'),
  ]
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue
      const stats = fs.statSync(candidate)
      if (stats.isDirectory()) return candidate
    } catch (err) {
      // continue searching other paths
    }
  }
  return null
}

function listDocsFiles(dir, baseDir, output) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      listDocsFiles(fullPath, baseDir, output)
      continue
    }
    if (!entry.isFile()) continue
    const ext = path.extname(entry.name).toLowerCase()
    if (ext !== '.md' && ext !== '.mdx') continue
    const relPath = path.relative(baseDir, fullPath).split(path.sep).join('/')
    output.push(`docs/${relPath}`)
  }
}

function getDocsIndex() {
  const root = resolveDocsRoot()
  if (!root) return []
  const files = []
  try {
    listDocsFiles(root, root, files)
  } catch (err) {
    return []
  }
  files.sort((a, b) => a.localeCompare(b))
  return files
}

// check envs
if (!process.env.WORLD) {
  throw new Error('[envs] WORLD not set')
}
if (!process.env.PORT) {
  throw new Error('[envs] PORT not set')
}
if (!process.env.JWT_SECRET) {
  throw new Error('[envs] JWT_SECRET not set')
}
if (!process.env.ADMIN_CODE) {
  console.warn('[envs] ADMIN_CODE not set - all users will have admin permissions!')
}
if (!process.env.SAVE_INTERVAL) {
  throw new Error('[envs] SAVE_INTERVAL not set')
}
if (!process.env.PUBLIC_MAX_UPLOAD_SIZE) {
  throw new Error('[envs] PUBLIC_MAX_UPLOAD_SIZE not set')
}
if (!process.env.PUBLIC_WS_URL) {
  throw new Error('[envs] PUBLIC_WS_URL not set')
}
if (!process.env.PUBLIC_WS_URL.startsWith('ws')) {
  throw new Error('[envs] PUBLIC_WS_URL must start with ws:// or wss://')
}
if (!process.env.PUBLIC_API_URL) {
  throw new Error('[envs] PUBLIC_API_URL must be set')
}
if (!process.env.ASSETS) {
  throw new Error(`[envs] ASSETS must be set to 'local' or 's3'`)
}
if (!process.env.ASSETS_BASE_URL) {
  throw new Error(`[envs] ASSETS_BASE_URL must be set`)
}
if (process.env.ASSETS === 's3' && !process.env.ASSETS_S3_URI) {
  throw new Error(`[envs] ASSETS_S3_URI must be set when using ASSETS=s3`)
}

const fastify = Fastify({ logger: { level: 'error' } })

// create world folder if needed
await fs.ensureDir(worldDir)

// init assets
await assets.init({ rootDir, worldDir })

// init db
const db = await getDB({ worldDir })

// init cleaner
await cleaner.init({ db })

// init storage
const storage = new Storage(path.join(worldDir, '/storage.json'))

// create world
const world = createServerWorld()
await world.init({
  assetsDir: assets.dir,
  assetsUrl: assets.url,
  db,
  assets,
  storage,
})

const registryState = createRegistryState()

fastify.register(cors)
fastify.register(compress)
fastify.get('/', async (req, reply) => {
  const title = world.settings.title || 'World'
  const desc = world.settings.desc || ''
  const image = world.resolveURL(world.settings.image?.url) || ''
  const url = process.env.ASSETS_BASE_URL
  const filePath = path.join(__dirname, 'public', 'index.html')
  let html = fs.readFileSync(filePath, 'utf-8')
  html = html.replaceAll('{url}', url)
  html = html.replaceAll('{title}', title)
  html = html.replaceAll('{desc}', desc)
  html = html.replaceAll('{image}', image)
  reply.type('text/html').send(html)
})
fastify.get('/api/ai-docs-index', async (req, reply) => {
  reply.send({ files: getDocsIndex() })
})
fastify.register(statics, {
  root: path.join(__dirname, 'public'),
  prefix: '/',
  decorateReply: false,
  setHeaders: res => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
  },
})
if (world.assetsDir) {
  fastify.register(statics, {
    root: world.assetsDir,
    prefix: '/assets/',
    decorateReply: false,
    setHeaders: res => {
      // all assets are hashed & immutable so we can use aggressive caching
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable') // 1 year
      res.setHeader('Expires', new Date(Date.now() + 31536000000).toUTCString()) // older browsers
    },
  })
}
fastify.register(multipart, {
  limits: {
    fileSize: 200 * 1024 * 1024, // 200MB
  },
})
fastify.register(ws)
fastify.register(worldNetwork)
const adminHtmlPath = path.join(__dirname, 'public', 'admin.html')
fastify.register(admin, { world, assets, adminHtmlPath })

const publicEnvs = {}
for (const key in process.env) {
  if (key.startsWith('PUBLIC_')) {
    const value = process.env[key]
    publicEnvs[key] = value
  }
}
const envsCode = `
  if (!globalThis.env) globalThis.env = {}
  globalThis.env = ${JSON.stringify(publicEnvs)}
`
fastify.get('/env.js', async (req, reply) => {
  reply.type('application/javascript').send(envsCode)
})

fastify.post('/api/upload', async (req, reply) => {
  return reply.code(403).send({ error: 'admin_required', message: 'Use /admin/upload' })
})

fastify.get('/api/upload-check', async (req, reply) => {
  return reply.code(403).send({ error: 'admin_required', message: 'Use /admin/upload-check' })
})

fastify.get('/health', async (request, reply) => {
  try {
    // Basic health check
    const health = {
      ok: true,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    }

    return reply.code(200).send(health)
  } catch (error) {
    console.error('Health check failed:', error)
    return reply.code(503).send({
      ok: false,
      timestamp: new Date().toISOString(),
    })
  }
})

fastify.get('/status', async (request, reply) => {
  try {
    const status = {
      ok: true,
      worldId: world?.network?.worldId || null,
      title: world.settings.title || 'World',
      description: world.settings.desc || '',
      imageUrl: world.resolveURL(world.settings.image?.url) || null,
      playerCount: world?.network?.sockets?.size || 0,
      playerLimit: world.settings.playerLimit ?? null,
      commitHash: process.env.COMMIT_HASH || null,
      listable: registryState.listable,
      updatedAt: new Date().toISOString(),
    }

    const registry = getRegistryPublicStatus(registryState)
    if (registry) status.registry = registry

    reply.header('Cache-Control', 'no-store')
    return reply.code(200).send(status)
  } catch (error) {
    console.error('Status failed:', error)
    return reply.code(503).send({
      ok: false,
      timestamp: new Date().toISOString(),
    })
  }
})

fastify.setErrorHandler((err, req, reply) => {
  console.error(err)
  reply.status(500).send()
})

const host = process.env.HOST || process.env.BIND_HOST || '0.0.0.0'

try {
  await fastify.listen({ port, host })
} catch (err) {
  console.error(err)
  console.error(`failed to launch on port ${port}`)
  process.exit(1)
}

void registerWithRegistry(registryState, {
  worldId: world?.network?.worldId || null,
  commitHash: process.env.COMMIT_HASH || null,
})

async function worldNetwork(fastify) {
  fastify.get('/ws', { websocket: true }, (ws, req) => {
    world.network.onConnection(ws, req.query)
  })
}

console.log(`server listening on port ${port}`)

// Graceful shutdown
process.on('SIGINT', async () => {
  await fastify.close()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await fastify.close()
  process.exit(0)
})
