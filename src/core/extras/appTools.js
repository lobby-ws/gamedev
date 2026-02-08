import { cloneDeep } from 'lodash-es'
import { hashFile } from '../utils-client'
import { buildLegacyBodyModuleSource } from '../legacyBody'

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
  const scriptFiles = blueprint.scriptFiles
  if (scriptFiles && typeof scriptFiles === 'object' && !Array.isArray(scriptFiles)) {
    let changed = false
    const nextFiles = {}
    for (const [relPath, url] of Object.entries(scriptFiles)) {
      const nextUrl = rewrite(url)
      if (nextUrl !== url) changed = true
      nextFiles[relPath] = nextUrl
    }
    if (changed) {
      blueprint.scriptFiles = nextFiles
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

function getScriptFiles(blueprint) {
  if (!blueprint) return null
  if (!blueprint.scriptFiles || typeof blueprint.scriptFiles !== 'object' || Array.isArray(blueprint.scriptFiles)) {
    return null
  }
  return blueprint.scriptFiles
}

function isHashedScriptEntryPath(relPath) {
  if (typeof relPath !== 'string') return false
  const normalized = relPath.replace(/\\/g, '/').trim()
  if (!normalized) return false
  const fileName = normalized.split('/').pop() || ''
  const ext = getExtension(fileName)
  if (ext !== 'js' && ext !== 'ts') return false
  const stem = fileName.slice(0, -(ext.length + 1))
  return /^[a-f0-9]{64}$/i.test(stem)
}

function normalizeSingleHashedScriptEntry(blueprint) {
  const scriptFiles = getScriptFiles(blueprint)
  if (!scriptFiles) return
  const entries = Object.entries(scriptFiles)
  if (entries.length !== 1) return
  const [onlyPath, onlyUrl] = entries[0]
  if (typeof onlyUrl !== 'string' || !onlyUrl) return

  const configuredEntry =
    typeof blueprint.scriptEntry === 'string' && Object.prototype.hasOwnProperty.call(scriptFiles, blueprint.scriptEntry)
      ? blueprint.scriptEntry
      : onlyPath
  if (!isHashedScriptEntryPath(configuredEntry)) return

  blueprint.scriptEntry = 'index.js'
  blueprint.scriptFiles = { 'index.js': onlyUrl }
  blueprint.script = onlyUrl
}

function deriveLegacyEntryPath(scriptUrl) {
  let entryPath = getUrlFilename(scriptUrl) || 'index.js'
  if (!getExtension(entryPath)) {
    entryPath = `${entryPath}.js`
  }
  return entryPath
}

async function buildModuleAssetFromLegacySource({
  sourceText,
  entryPath,
  lastModified,
  type,
}) {
  const moduleSource = buildLegacyBodyModuleSource(sourceText, entryPath)
  const mime = type || 'text/javascript'
  const draft = new File([moduleSource], entryPath, { type: mime, lastModified })
  const hash = await hashFile(draft)
  const ext = getExtension(entryPath) || 'js'
  const filename = `${hash}.${ext}`
  const file =
    draft.name === filename
      ? draft
      : new File([draft], filename, { type: draft.type, lastModified: draft.lastModified })
  return { url: `asset://${filename}`, file }
}

async function convertLegacyScriptBlueprint({
  blueprint,
  headerBlueprint,
  assets,
  rewrittenAssets,
  urlMap,
}) {
  const scriptFiles = getScriptFiles(blueprint)
  const headerScriptFiles = getScriptFiles(headerBlueprint)

  if (!scriptFiles) {
    const originalScriptUrl = typeof headerBlueprint?.script === 'string' ? headerBlueprint.script : null
    if (!originalScriptUrl) return { blueprint, assets: rewrittenAssets }
    const legacyAsset = assets.find(asset => asset?.url === originalScriptUrl)
    if (!legacyAsset?.file) {
      throw new Error(`missing_script_asset:${originalScriptUrl}`)
    }
    const entryPath = deriveLegacyEntryPath(originalScriptUrl)
    const sourceText = await legacyAsset.file.text()
    const moduleAsset = await buildModuleAssetFromLegacySource({
      sourceText,
      entryPath,
      lastModified: legacyAsset.file.lastModified,
      type: legacyAsset.file.type,
    })
    const legacyUrl = urlMap.get(originalScriptUrl)
    const nextAssets = rewrittenAssets.filter(asset => asset.url !== legacyUrl)
    nextAssets.push({ type: null, url: moduleAsset.url, file: moduleAsset.file })
    blueprint.scriptEntry = entryPath
    blueprint.scriptFiles = { [entryPath]: moduleAsset.url }
    blueprint.scriptFormat = 'module'
    blueprint.script = moduleAsset.url
    return { blueprint, assets: nextAssets }
  }

  const currentFormat = blueprint.scriptFormat
  if (currentFormat && currentFormat !== 'legacy-body') {
    return { blueprint, assets: rewrittenAssets }
  }

  const entryPath =
    typeof blueprint.scriptEntry === 'string' && scriptFiles[blueprint.scriptEntry]
      ? blueprint.scriptEntry
      : Object.keys(scriptFiles).sort()[0]
  if (!entryPath) return { blueprint, assets: rewrittenAssets }

  const originalEntryUrl = headerScriptFiles?.[entryPath]
  const entryAsset =
    (originalEntryUrl ? assets.find(asset => asset?.url === originalEntryUrl) : null) ||
    rewrittenAssets.find(asset => asset?.url === scriptFiles[entryPath])
  if (!entryAsset?.file) {
    throw new Error(`missing_script_asset:${entryPath}`)
  }

  const sourceText = await entryAsset.file.text()
  const moduleAsset = await buildModuleAssetFromLegacySource({
    sourceText,
    entryPath,
    lastModified: entryAsset.file.lastModified,
    type: entryAsset.file.type,
  })

  const oldEntryUrl = scriptFiles[entryPath]
  const nextAssets = rewrittenAssets.filter(asset => asset.url !== oldEntryUrl)
  nextAssets.push({ type: null, url: moduleAsset.url, file: moduleAsset.file })

  blueprint.scriptEntry = entryPath
  blueprint.scriptFiles = { ...scriptFiles, [entryPath]: moduleAsset.url }
  blueprint.scriptFormat = 'module'
  blueprint.script = moduleAsset.url
  return { blueprint, assets: nextAssets }
}

export async function exportApp(blueprint, resolveFile, resolveBlueprint) {
  const safeBlueprint = cloneDeep(blueprint || {})
  safeBlueprint.props = normalizeProps(safeBlueprint.props)

  const scriptRefId =
    typeof safeBlueprint.scriptRef === 'string' && safeBlueprint.scriptRef.trim()
      ? safeBlueprint.scriptRef.trim()
      : null
  if (scriptRefId) {
    if (typeof resolveBlueprint !== 'function') {
      throw new Error('script_ref_resolver_required')
    }
    const scriptRoot = await resolveBlueprint(scriptRefId)
    if (!scriptRoot) {
      throw new Error(`script_ref_not_found:${scriptRefId}`)
    }
    const resolvedRoot = cloneDeep(scriptRoot)
    safeBlueprint.scriptFiles = resolvedRoot.scriptFiles
    safeBlueprint.scriptEntry = resolvedRoot.scriptEntry
    safeBlueprint.scriptFormat = resolvedRoot.scriptFormat
    delete safeBlueprint.scriptRef
  }

  const assets = []
  const addedUrls = new Set()
  const addAsset = async ({ type, url }) => {
    if (!url || typeof url !== 'string') return
    if (addedUrls.has(url)) return
    addedUrls.add(url)
    assets.push({
      type,
      url,
      file: await resolveFile(url),
    })
  }

  if (typeof safeBlueprint.model === 'string' && safeBlueprint.model) {
    const inferred = inferAssetType(safeBlueprint.model)
    const type = inferred === 'avatar' ? 'avatar' : 'model'
    await addAsset({ type, url: safeBlueprint.model })
  }
  if (typeof safeBlueprint.script === 'string' && safeBlueprint.script) {
    await addAsset({ type: 'script', url: safeBlueprint.script })
  }
  const imageUrl =
    typeof safeBlueprint.image === 'string' ? safeBlueprint.image : safeBlueprint.image?.url
  if (imageUrl) {
    const explicitType = typeof safeBlueprint.image === 'object' ? safeBlueprint.image?.type : null
    const type = explicitType || inferAssetType(imageUrl) || 'texture'
    await addAsset({ type, url: imageUrl })
  }
  for (const key in safeBlueprint.props) {
    const value = safeBlueprint.props[key]
    if (!value || typeof value !== 'object' || Array.isArray(value) || !value.url) continue
    const type = typeof value.type === 'string' ? value.type : inferAssetType(value.url)
    await addAsset({ type, url: value.url })
  }
  const scriptFiles = safeBlueprint.scriptFiles
  if (scriptFiles && typeof scriptFiles === 'object' && !Array.isArray(scriptFiles)) {
    for (const url of Object.values(scriptFiles)) {
      if (!url || typeof url !== 'string') continue
      await addAsset({ type: 'script', url })
    }
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
  const scriptFileUrls = new Set()
  const headerBlueprint = header?.blueprint
  if (
    headerBlueprint?.scriptFiles &&
    typeof headerBlueprint.scriptFiles === 'object' &&
    !Array.isArray(headerBlueprint.scriptFiles)
  ) {
    for (const url of Object.values(headerBlueprint.scriptFiles)) {
      if (typeof url === 'string') scriptFileUrls.add(url)
    }
  }

  for (const assetInfo of headerAssets) {
    const size = assetInfo?.size || 0
    const data = buffer.slice(position, position + size)
    const filename = getUrlFilename(assetInfo?.url) || 'asset'
    const file = new File([data], filename, {
      type: assetInfo?.mime || 'application/octet-stream',
    })
    const isScriptFile = scriptFileUrls.has(assetInfo?.url)
    const type = isScriptFile
      ? null
      : typeof assetInfo?.type === 'string'
        ? assetInfo.type
        : inferAssetType(assetInfo?.url)
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
  if (safeBlueprint.scriptRef !== undefined) {
    delete safeBlueprint.scriptRef
  }

  const converted = await convertLegacyScriptBlueprint({
    blueprint: safeBlueprint,
    headerBlueprint,
    assets,
    rewrittenAssets,
    urlMap,
  })
  normalizeSingleHashedScriptEntry(converted.blueprint)

  return {
    blueprint: converted.blueprint,
    assets: converted.assets,
  }
}
