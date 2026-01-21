import { cloneDeep } from 'lodash-es'
import { hashFile } from '../utils-client'

const imageExts = new Set(['png', 'jpg', 'jpeg', 'webp'])
const typeByExt = {
  hdr: 'hdr',
  mp4: 'video',
  mp3: 'audio',
  js: 'script',
  vrm: 'avatar',
  glb: 'model',
}

function getExtension(value) {
  if (typeof value !== 'string') return ''
  const cleaned = value.split('#')[0].split('?')[0]
  const last = cleaned.split('/').pop() || ''
  const idx = last.lastIndexOf('.')
  if (idx <= 0 || idx === last.length - 1) return ''
  return last.slice(idx + 1).toLowerCase()
}

function inferAssetType(url) {
  const ext = getExtension(url)
  if (!ext) return null
  if (typeByExt[ext]) return typeByExt[ext]
  if (imageExts.has(ext)) return 'texture'
  return null
}

function sanitizeFilename(name) {
  if (typeof name !== 'string') return 'app'
  let safe = name.trim()
  if (!safe) return 'app'
  safe = safe.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
  safe = safe.replace(/\s+/g, ' ').trim()
  safe = safe.replace(/[. ]+$/g, '')
  return safe || 'app'
}

function getUrlFilename(url) {
  if (typeof url !== 'string') return null
  const cleaned = url.split('#')[0].split('?')[0]
  const last = cleaned.split('/').pop()
  return last || null
}

function normalizeProps(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  return {}
}

function rewriteBlueprintUrls(blueprint, urlMap) {
  if (!urlMap || urlMap.size === 0) return blueprint
  const rewrite = url => (typeof url === 'string' && urlMap.has(url) ? urlMap.get(url) : url)

  if (typeof blueprint.model === 'string') {
    blueprint.model = rewrite(blueprint.model)
  }
  if (typeof blueprint.script === 'string') {
    blueprint.script = rewrite(blueprint.script)
  }
  if (typeof blueprint.image === 'string') {
    blueprint.image = rewrite(blueprint.image)
  } else if (blueprint.image && typeof blueprint.image === 'object') {
    const imageUrl = blueprint.image.url
    if (typeof imageUrl === 'string') {
      blueprint.image = { ...blueprint.image, url: rewrite(imageUrl) }
    }
  }
  const props = blueprint.props
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    for (const [key, value] of Object.entries(props)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      if (typeof value.url === 'string') {
        const nextUrl = rewrite(value.url)
        if (nextUrl !== value.url) {
          props[key] = { ...value, url: nextUrl }
        }
      }
    }
  }
  return blueprint
}

export async function exportApp(blueprint, resolveFile) {
  const safeBlueprint = cloneDeep(blueprint || {})
  safeBlueprint.props = normalizeProps(safeBlueprint.props)

  const assets = []
  if (typeof safeBlueprint.model === 'string' && safeBlueprint.model) {
    const inferred = inferAssetType(safeBlueprint.model)
    const type = inferred === 'avatar' ? 'avatar' : 'model'
    assets.push({
      type,
      url: safeBlueprint.model,
      file: await resolveFile(safeBlueprint.model),
    })
  }
  if (typeof safeBlueprint.script === 'string' && safeBlueprint.script) {
    assets.push({
      type: 'script',
      url: safeBlueprint.script,
      file: await resolveFile(safeBlueprint.script),
    })
  }
  const imageUrl =
    typeof safeBlueprint.image === 'string' ? safeBlueprint.image : safeBlueprint.image?.url
  if (imageUrl) {
    const explicitType = typeof safeBlueprint.image === 'object' ? safeBlueprint.image?.type : null
    const type = explicitType || inferAssetType(imageUrl) || 'texture'
    assets.push({
      type,
      url: imageUrl,
      file: await resolveFile(imageUrl),
    })
  }
  for (const key in safeBlueprint.props) {
    const value = safeBlueprint.props[key]
    if (!value || typeof value !== 'object' || Array.isArray(value) || !value.url) continue
    const type = typeof value.type === 'string' ? value.type : inferAssetType(value.url)
    assets.push({
      type,
      url: value.url,
      file: await resolveFile(value.url),
    })
  }

  if (safeBlueprint.locked) {
    safeBlueprint.frozen = true
  }
  if (safeBlueprint.disabled) {
    safeBlueprint.disabled = false
  }

  const baseName = sanitizeFilename(safeBlueprint.name || 'app')
  const filename = baseName.toLowerCase().endsWith('.hyp') ? baseName : `${baseName}.hyp`

  const header = {
    blueprint: safeBlueprint,
    assets: assets.map(asset => {
      return {
        type: asset.type,
        url: asset.url,
        size: asset.file.size,
        mime: asset.file.type,
      }
    }),
  }

  const headerBytes = new TextEncoder().encode(JSON.stringify(header))
  const headerSize = new Uint8Array(4)
  new DataView(headerSize.buffer).setUint32(0, headerBytes.length, true)
  const fileBlobs = await Promise.all(assets.map(asset => asset.file.arrayBuffer()))

  return new File([headerSize, headerBytes, ...fileBlobs], filename, {
    type: 'application/octet-stream',
  })
}

export async function importApp(file) {
  const buffer = await file.arrayBuffer()
  const view = new DataView(buffer)
  const headerSize = view.getUint32(0, true)
  const bytes = new Uint8Array(buffer.slice(4, 4 + headerSize))
  const header = JSON.parse(new TextDecoder().decode(bytes))

  let position = 4 + headerSize
  const assets = []
  const headerAssets = Array.isArray(header.assets) ? header.assets : []

  for (const assetInfo of headerAssets) {
    const size = assetInfo?.size || 0
    const data = buffer.slice(position, position + size)
    const filename = getUrlFilename(assetInfo?.url) || 'asset'
    const file = new File([data], filename, {
      type: assetInfo?.mime || 'application/octet-stream',
    })
    const type = typeof assetInfo?.type === 'string' ? assetInfo.type : inferAssetType(assetInfo?.url)
    assets.push({
      type,
      url: assetInfo?.url,
      file,
    })
    position += size
  }

  const urlMap = new Map()
  const rewrittenAssets = await Promise.all(
    assets.map(async asset => {
      if (!asset?.file) return asset
      const hash = await hashFile(asset.file)
      const ext = getExtension(asset.url) || getExtension(asset.file.name)
      const filename = ext ? `${hash}.${ext}` : hash
      const url = `asset://${filename}`
      if (typeof asset.url === 'string') {
        urlMap.set(asset.url, url)
      }
      const renamedFile =
        asset.file.name === filename
          ? asset.file
          : new File([asset.file], filename, {
              type: asset.file.type,
              lastModified: asset.file.lastModified,
            })
      return {
        ...asset,
        url,
        file: renamedFile,
      }
    })
  )

  const safeBlueprint = cloneDeep(header.blueprint || {})
  safeBlueprint.props = normalizeProps(safeBlueprint.props)
  rewriteBlueprintUrls(safeBlueprint, urlMap)

  return {
    blueprint: safeBlueprint,
    assets: rewrittenAssets,
  }
}
