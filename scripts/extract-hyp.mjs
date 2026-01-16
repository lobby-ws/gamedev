import fs from 'fs-extra'
import path from 'node:path'

const args = process.argv.slice(2)
if (args.length === 0) {
  console.log('Usage: node scripts/extract-hyp.mjs <app.hyp> [--project <projectDir>]')
  process.exit(1)
}

let hypPath = args[0]
let projectRoot = 'project'
for (let i = 1; i < args.length; i += 1) {
  const arg = args[i]
  if (arg === '--project') {
    projectRoot = args[i + 1] || projectRoot
    i += 1
  }
}

const mimeToExt = {
  'application/javascript': '.js',
  'text/javascript': '.js',
  'application/json': '.json',
  'application/octet-stream': '',
  'model/gltf-binary': '.glb',
  'model/gltf+json': '.gltf',
  'model/vrm': '.vrm',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'image/ktx2': '.ktx2',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/aac': '.aac',
  'audio/mp4': '.m4a',
  'font/ttf': '.ttf',
  'font/otf': '.otf',
  'font/woff': '.woff',
  'font/woff2': '.woff2',
}

const hypAbs = path.resolve(hypPath)
const projectAbs = path.resolve(projectRoot)
const appsDir = path.join(projectAbs, 'apps')
const assetsDir = path.join(projectAbs, 'assets')

const buffer = await fs.readFile(hypAbs)
const headerSize = buffer.readUInt32LE(0)
const headerText = buffer.slice(4, 4 + headerSize).toString('utf8')
const header = JSON.parse(headerText)
const blueprint = header.blueprint || {}
const assets = header.assets || []

const assetsByUrl = new Map()
let position = 4 + headerSize
for (const asset of assets) {
  const data = buffer.slice(position, position + asset.size)
  assetsByUrl.set(asset.url, { info: asset, data })
  position += asset.size
}

function extFromString(value) {
  if (!value) return ''
  const base = path.basename(value)
  return path.extname(base)
}

function resolveExtension({ url, mime, name }) {
  const urlExt = extFromString(url)
  if (urlExt) return urlExt
  const nameExt = extFromString(name)
  if (nameExt) return nameExt
  return mimeToExt[mime] || ''
}

function sanitizeName(value) {
  if (!value) return 'app'
  return value.replace(/[\\/]/g, '-')
}

function clonePropValue(value) {
  if (value === null || typeof value !== 'object') return value
  return Array.isArray(value) ? value.slice() : { ...value }
}

const defaultName = path.parse(hypAbs).name
const appName = blueprint.scene ? '$scene' : sanitizeName(blueprint.name || defaultName)
const appDir = path.join(appsDir, appName)
await fs.ensureDir(appDir)
await fs.ensureDir(assetsDir)

const written = []

function recordWrite(filePath) {
  written.push(path.relative(projectAbs, filePath))
}

async function writeAsset(url, outputName, nameHint) {
  if (!url) return null
  const asset = assetsByUrl.get(url)
  if (!asset) {
    console.warn(`[extract-hyp] missing asset for url: ${url}`)
    return null
  }
  const ext = resolveExtension({ url, mime: asset.info?.mime, name: nameHint })
  const filename = `${outputName}${ext}`
  const filePath = path.join(assetsDir, filename)
  await fs.writeFile(filePath, asset.data)
  recordWrite(filePath)
  return `assets/${filename}`
}

const scriptUrl = blueprint.script
if (scriptUrl) {
  const scriptAsset = assetsByUrl.get(scriptUrl)
  if (!scriptAsset) {
    console.warn(`[extract-hyp] missing script asset for url: ${scriptUrl}`)
  } else {
    const scriptPath = path.join(appDir, 'index.js')
    await fs.writeFile(scriptPath, scriptAsset.data)
    recordWrite(scriptPath)
  }
}

const modelBase = blueprint.scene ? '-scene' : appName
const modelPath = blueprint.model
  ? await writeAsset(blueprint.model, modelBase)
  : null

const imagePath = blueprint.image?.url
  ? await writeAsset(blueprint.image.url, `${appName}__image`, blueprint.image.name)
  : null

const props = {}
for (const [key, value] of Object.entries(blueprint.props || {})) {
  if (value && typeof value === 'object' && value.url) {
    const nextValue = clonePropValue(value)
    const assetPath = await writeAsset(value.url, key, value.name)
    if (assetPath) {
      nextValue.url = assetPath
    }
    if ('name' in nextValue) {
      delete nextValue.name
    }
    props[key] = nextValue
  } else {
    props[key] = value
  }
}

const appJson = {
  author: blueprint.author ?? null,
  url: blueprint.url ?? null,
  desc: blueprint.desc ?? null,
  preload: blueprint.preload ?? false,
  public: blueprint.public ?? false,
  locked: blueprint.locked ?? false,
  frozen: blueprint.frozen ?? false,
  unique: blueprint.unique ?? false,
  disabled: blueprint.disabled ?? false,
  scene: blueprint.scene ?? false,
  model: modelPath,
  image: imagePath ? { url: imagePath } : null,
  props,
}

const jsonName = `${appName}.json`
const jsonPath = path.join(appDir, jsonName)
await fs.writeFile(jsonPath, `${JSON.stringify(appJson, null, 2)}\n`)
recordWrite(jsonPath)

console.log(`[extract-hyp] extracted ${hypPath}`)
for (const file of written) {
  console.log(`- ${file}`)
}
