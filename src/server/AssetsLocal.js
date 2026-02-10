import fs from 'fs-extra'
import path from 'path'
import { hashFile } from '../core/utils-server'

function normalizeAssetFilename(value) {
  if (typeof value !== 'string') return null
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '').trim()
  if (!normalized) return null
  const parts = normalized.split('/')
  for (const part of parts) {
    if (!part || part === '.' || part === '..') {
      return null
    }
  }
  return parts.join('/')
}

function isHashedAssetBasename(basename) {
  if (typeof basename !== 'string' || !basename) return false
  const prefix = basename.split('.')[0]
  return /^[a-f0-9]{64}$/i.test(prefix)
}

function resolveStoredFilename(inputFilename, contentHash) {
  const normalized = normalizeAssetFilename(inputFilename)
  const fallbackExt = path.extname(String(inputFilename || '')).toLowerCase()
  const ext = fallbackExt ? fallbackExt.slice(1) : 'bin'
  const fallback = `${contentHash}.${ext}`
  if (!normalized) return fallback
  const basename = path.posix.basename(normalized)
  if (!isHashedAssetBasename(basename)) return fallback
  const expectedPrefix = basename.split('.')[0].toLowerCase()
  if (expectedPrefix !== contentHash) return fallback
  return normalized
}

function isTrackedAssetFilename(filename) {
  const normalized = normalizeAssetFilename(filename)
  if (!normalized) return false
  const basename = path.posix.basename(normalized)
  return isHashedAssetBasename(basename)
}

export class AssetsLocal {
  constructor() {
    this.url = process.env.ASSETS_BASE_URL
    this.dir = null
  }

  async init({ rootDir, worldDir }) {
    console.log('[assets] initializing')
    this.dir = path.join(worldDir, '/assets')
    // ensure assets directory exists
    await fs.ensureDir(this.dir)
    // copy over built-in assets (from published build)
    const builtInAssetsDir = path.join(rootDir, 'build/world/assets')
    const exists = await fs.pathExists(builtInAssetsDir)
    if (exists) {
      await fs.copy(builtInAssetsDir, this.dir)
    }
  }

  async upload(file) {
    const arrayBuffer = await file.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    const hash = await hashFile(buffer)
    const filename = resolveStoredFilename(file.name, hash)
    const assetPath = path.join(this.dir, filename)
    await fs.ensureDir(path.dirname(assetPath))
    const exists = await fs.exists(assetPath)
    if (exists) return
    await fs.writeFile(assetPath, buffer)
  }

  async exists(filename) {
    const normalized = normalizeAssetFilename(filename)
    if (!normalized) return false
    const filePath = path.join(this.dir, normalized)
    const exists = await fs.exists(filePath)
    return exists
  }

  async list() {
    const assets = new Set()
    const walk = dir => {
      const files = fs.readdirSync(dir, { withFileTypes: true })
      for (const file of files) {
        const filePath = path.join(dir, file.name)
        if (file.isDirectory()) {
          walk(filePath)
          continue
        }
        if (!file.isFile()) continue
        const relPath = path.relative(this.dir, filePath).replace(/\\/g, '/')
        if (!isTrackedAssetFilename(relPath)) continue
        assets.add(relPath)
      }
    }
    walk(this.dir)
    return assets
  }

  async delete(assets) {
    for (const asset of assets) {
      const normalized = normalizeAssetFilename(asset)
      if (!normalized) continue
      const fullPath = path.join(this.dir, normalized)
      fs.removeSync(fullPath)
    }
  }
}
