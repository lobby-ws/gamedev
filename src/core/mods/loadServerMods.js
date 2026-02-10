import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'

import { getSystemModEntries, normalizeModManifest } from './manifest'
import { resolveEffectiveModOrder } from './order'

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

async function importServerModuleFromHttp(url) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`mod_fetch_failed:${response.status}`)
  }
  const sourceText = await response.text()
  const base64 = Buffer.from(sourceText, 'utf8').toString('base64')
  const dataUrl = `data:text/javascript;base64,${base64}`
  return import(dataUrl)
}

async function importServerModule(url, { assetsDir, assetsUrl } = {}) {
  if (typeof url !== 'string' || !url) {
    throw new Error('mod_url_missing')
  }
  if (url.startsWith('asset://')) {
    const filename = url.slice('asset://'.length)
    if (assetsDir) {
      const absPath = path.join(assetsDir, filename)
      if (fs.existsSync(absPath)) {
        const fileUrl = `${pathToFileURL(absPath).href}?mod=${encodeURIComponent(filename)}`
        return import(fileUrl)
      }
    }
    if (!assetsUrl) {
      throw new Error(`mod_asset_unresolved:${filename}`)
    }
    return importServerModuleFromHttp(joinUrl(assetsUrl, filename))
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return importServerModuleFromHttp(url)
  }
  if (url.startsWith('file://')) {
    return import(url)
  }
  if (path.isAbsolute(url)) {
    return import(pathToFileURL(url).href)
  }
  throw new Error(`mod_url_unsupported:${url}`)
}

export async function loadServerMods({ manifest, loadOrderOverride, assetsDir, assetsUrl } = {}) {
  const normalizedManifest = normalizeModManifest(manifest, { allowNull: true })
  if (!normalizedManifest) {
    return {
      systems: [],
      order: [],
      source: 'fallback',
      warnings: [],
    }
  }

  const allModuleIds = normalizedManifest.modules.map(module => module.id)
  const effectiveOrder = resolveEffectiveModOrder({
    ids: allModuleIds,
    manifestOrder: normalizedManifest.loadOrder,
    overrideOrder: loadOrderOverride,
  })

  const serverEntries = getSystemModEntries(normalizedManifest, { target: 'server' })
  const byId = new Map(serverEntries.map(entry => [entry.id, entry]))
  const orderedIds = effectiveOrder.order.filter(id => byId.has(id))

  const systems = []
  for (const moduleId of orderedIds) {
    const entry = byId.get(moduleId)
    const namespace = await importServerModule(entry.serverUrl, { assetsDir, assetsUrl })
    const System = namespace?.default
    if (typeof System !== 'function') {
      throw new Error(`mod_system_default_export_missing:${moduleId}`)
    }
    systems.push({
      id: moduleId,
      key: entry.systemKey || buildFallbackSystemKey(moduleId),
      scope: entry.scope,
      url: entry.serverUrl,
      System,
    })
  }

  return {
    systems,
    order: orderedIds,
    source: effectiveOrder.source,
    warnings: effectiveOrder.warnings,
  }
}
