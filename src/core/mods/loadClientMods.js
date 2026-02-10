import { getSystemModEntries, normalizeModManifest } from './manifest'
import { normalizeModOrderSpec, resolveEffectiveModOrder } from './order'

function joinUrl(base, pathname) {
  const a = (base || '').replace(/\/+$/, '')
  const b = (pathname || '').replace(/^\/+/, '')
  return `${a}/${b}`
}

function buildFallbackSystemKey(moduleId) {
  let key = `mod_${String(moduleId || '').replace(/[^a-zA-Z0-9_$]+/g, '_')}`
  if (!/^[A-Za-z_$]/.test(key)) {
    key = `_${key}`
  }
  return key
}

function resolveClientModuleUrl(url, { assetsUrl }) {
  if (typeof url !== 'string' || !url) {
    throw new Error('mod_url_missing')
  }
  if (url.startsWith('asset://')) {
    const filename = url.slice('asset://'.length)
    if (!assetsUrl) {
      throw new Error(`mod_assets_url_missing:${filename}`)
    }
    return joinUrl(assetsUrl, filename)
  }
  return url
}

function defaultImportModule(specifier) {
  return import(specifier)
}

async function fetchModsPayload({ manifestUrl = '/mods/manifest', fetcher = fetch } = {}) {
  const response = await fetcher(manifestUrl)
  if (!response.ok) {
    if (response.status === 404) {
      return { manifest: null, loadOrderOverride: null, assetsUrl: null, warnings: [] }
    }
    throw new Error(`mods_manifest_fetch_failed:${response.status}`)
  }
  const payload = await response.json()
  return {
    manifest: payload?.manifest ?? null,
    loadOrderOverride: payload?.loadOrderOverride ?? null,
    assetsUrl: typeof payload?.assetsUrl === 'string' ? payload.assetsUrl : null,
    warnings: Array.isArray(payload?.warnings) ? payload.warnings : [],
  }
}

export async function loadClientMods(
  world,
  {
    manifest = undefined,
    loadOrderOverride = undefined,
    assetsUrl = undefined,
    warnings: initialWarnings = undefined,
    manifestUrl = '/mods/manifest',
    fetcher = fetch,
    importModule = defaultImportModule,
    logger = console,
  } = {}
) {
  let stateWarnings = Array.isArray(initialWarnings) ? initialWarnings.slice() : []
  if (manifest === undefined) {
    const payload = await fetchModsPayload({ manifestUrl, fetcher })
    manifest = payload.manifest
    loadOrderOverride = payload.loadOrderOverride
    assetsUrl = payload.assetsUrl
    stateWarnings = stateWarnings.concat(payload.warnings)
  }

  const normalizedManifest = normalizeModManifest(manifest, { allowNull: true })
  if (!normalizedManifest) {
    return {
      loaded: [],
      order: [],
      source: 'fallback',
      warnings: stateWarnings,
      assetsUrl,
      manifest: null,
      loadOrderOverride: normalizeModOrderSpec(loadOrderOverride),
    }
  }

  const allModuleIds = normalizedManifest.modules.map(module => module.id)
  const effectiveOrder = resolveEffectiveModOrder({
    ids: allModuleIds,
    manifestOrder: normalizedManifest.loadOrder,
    overrideOrder: loadOrderOverride,
  })
  const warnings = stateWarnings.concat(effectiveOrder.warnings)
  for (const warning of warnings) {
    logger?.warn?.(`[mods] ${warning}`)
  }

  const clientEntries = getSystemModEntries(normalizedManifest, { target: 'client' })
  const byId = new Map(clientEntries.map(entry => [entry.id, entry]))
  const orderedIds = effectiveOrder.order.filter(id => byId.has(id))

  const loaded = []
  for (const moduleId of orderedIds) {
    const entry = byId.get(moduleId)
    const moduleUrl = resolveClientModuleUrl(entry.clientUrl, { assetsUrl })
    const namespace = await importModule(moduleUrl)
    const System = namespace?.default
    if (typeof System !== 'function') {
      throw new Error(`mod_client_system_default_export_missing:${moduleId}`)
    }
    world.register(entry.systemKey || buildFallbackSystemKey(moduleId), System)
    loaded.push(moduleId)
  }

  logger?.log?.(`[mods] client order (${effectiveOrder.source}): ${loaded.length ? loaded.join(', ') : 'none'}`)

  return {
    loaded,
    order: orderedIds,
    source: effectiveOrder.source,
    warnings,
    assetsUrl,
    manifest: normalizedManifest,
    loadOrderOverride: normalizeModOrderSpec(loadOrderOverride),
  }
}
