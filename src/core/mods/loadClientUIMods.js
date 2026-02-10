import { getClientUIModEntries, normalizeModManifest } from './manifest.js'
import { resolveEffectiveModOrder } from './order.js'

function joinUrl(base, pathname) {
  const a = (base || '').replace(/\/+$/, '')
  const b = (pathname || '').replace(/^\/+/, '')
  return `${a}/${b}`
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

export async function loadClientUIMods(
  world,
  {
    manifest,
    loadOrderOverride,
    assetsUrl,
    importModule = defaultImportModule,
    logger = console,
  } = {}
) {
  const normalizedManifest = normalizeModManifest(manifest, { allowNull: true })
  if (!normalizedManifest) {
    const empty = { components: [], sidebar: [], order: [], source: 'fallback' }
    world.modUI = empty
    world.emit?.('mods-ui', empty)
    return empty
  }

  const allModuleIds = normalizedManifest.modules.map(module => module.id)
  const effectiveOrder = resolveEffectiveModOrder({
    ids: allModuleIds,
    manifestOrder: normalizedManifest.loadOrder,
    overrideOrder: loadOrderOverride,
  })

  const entries = getClientUIModEntries(normalizedManifest)
  const componentById = new Map(entries.components.map(entry => [entry.id, entry]))
  const sidebarById = new Map(entries.sidebar.map(entry => [entry.id, entry]))

  const components = []
  const sidebar = []
  const order = []

  for (const moduleId of effectiveOrder.order) {
    if (componentById.has(moduleId)) {
      const entry = componentById.get(moduleId)
      const moduleUrl = resolveClientModuleUrl(entry.clientUrl, { assetsUrl })
      const namespace = await importModule(moduleUrl)
      const exported = namespace?.[entry.exportName || 'default']
      if (typeof exported !== 'function') {
        throw new Error(`mod_ui_component_export_missing:${moduleId}`)
      }
      components.push({
        id: moduleId,
        Component: exported,
      })
      order.push(moduleId)
      continue
    }
    if (sidebarById.has(moduleId)) {
      const entry = sidebarById.get(moduleId)
      const moduleUrl = resolveClientModuleUrl(entry.clientUrl, { assetsUrl })
      const namespace = await importModule(moduleUrl)
      const Button = namespace?.[entry.buttonExport]
      const Pane = namespace?.[entry.paneExport]
      if (typeof Button !== 'function' || typeof Pane !== 'function') {
        throw new Error(`mod_ui_sidebar_exports_missing:${moduleId}`)
      }
      sidebar.push({
        id: moduleId,
        Button,
        Pane,
      })
      order.push(moduleId)
    }
  }

  const loaded = {
    components,
    sidebar,
    order,
    source: effectiveOrder.source,
  }
  world.modUI = loaded
  world.emit?.('mods-ui', loaded)

  if (order.length) {
    logger?.log?.(`[mods] client ui order (${effectiveOrder.source}): ${order.join(', ')}`)
  }

  return loaded
}
