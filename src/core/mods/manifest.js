import { resolveModOrder, normalizeModOrderSpec } from './order'

const MODS_MANIFEST_VERSION = 1
const MOD_KINDS = new Set(['system', 'component', 'sidebar'])
const SYSTEM_SCOPES = new Set(['server', 'client', 'shared'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeRequiredString(value, label) {
  if (typeof value !== 'string') {
    throw new Error(`${label}_must_be_string`)
  }
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`${label}_missing`)
  }
  return trimmed
}

function normalizeOptionalString(value, label) {
  if (value == null) return null
  if (typeof value !== 'string') {
    throw new Error(`${label}_must_be_string`)
  }
  const trimmed = value.trim()
  return trimmed || null
}

function normalizeAssetUrl(value, label) {
  const trimmed = normalizeRequiredString(value, label)
  if (!trimmed.startsWith('asset://')) {
    throw new Error(`${label}_must_be_asset_url`)
  }
  if (trimmed.length <= 'asset://'.length) {
    throw new Error(`${label}_must_be_asset_url`)
  }
  return trimmed
}

function normalizeVersion(value) {
  if (value == null) return MODS_MANIFEST_VERSION
  const num = Number.parseInt(value, 10)
  if (!Number.isFinite(num)) {
    throw new Error('mods_manifest_version_invalid')
  }
  if (num !== MODS_MANIFEST_VERSION) {
    throw new Error(`mods_manifest_version_unsupported:${num}`)
  }
  return num
}

function resolveSystemUrls(entry, scope) {
  const aliasUrl = typeof entry.url === 'string' ? entry.url : null
  let serverUrl = entry.serverUrl
  let clientUrl = entry.clientUrl

  if (scope === 'server') {
    if (serverUrl == null) serverUrl = aliasUrl
    return {
      serverUrl: normalizeAssetUrl(serverUrl, 'module_server_url'),
      clientUrl: null,
    }
  }

  if (scope === 'client') {
    if (clientUrl == null) clientUrl = aliasUrl
    return {
      serverUrl: null,
      clientUrl: normalizeAssetUrl(clientUrl, 'module_client_url'),
    }
  }

  if (serverUrl == null) serverUrl = aliasUrl
  if (clientUrl == null) clientUrl = aliasUrl
  return {
    serverUrl: normalizeAssetUrl(serverUrl, 'module_server_url'),
    clientUrl: normalizeAssetUrl(clientUrl, 'module_client_url'),
  }
}

function normalizeSystemModule(entry) {
  const scope = normalizeRequiredString(entry.scope, 'module_scope')
  if (!SYSTEM_SCOPES.has(scope)) {
    throw new Error(`module_scope_invalid:${scope}`)
  }
  const urls = resolveSystemUrls(entry, scope)
  const systemKey = normalizeOptionalString(entry.systemKey, 'module_system_key')
  return {
    id: normalizeRequiredString(entry.id, 'module_id'),
    kind: 'system',
    scope,
    systemKey,
    sourcePath: normalizeOptionalString(entry.sourcePath, 'module_source_path'),
    serverUrl: urls.serverUrl,
    clientUrl: urls.clientUrl,
  }
}

function normalizeComponentModule(entry) {
  const url = entry.clientUrl ?? entry.url
  return {
    id: normalizeRequiredString(entry.id, 'module_id'),
    kind: 'component',
    sourcePath: normalizeOptionalString(entry.sourcePath, 'module_source_path'),
    exportName: normalizeOptionalString(entry.exportName, 'module_export_name') || 'default',
    clientUrl: normalizeAssetUrl(url, 'module_client_url'),
  }
}

function normalizeSidebarModule(entry) {
  const url = entry.clientUrl ?? entry.url
  return {
    id: normalizeRequiredString(entry.id, 'module_id'),
    kind: 'sidebar',
    sourcePath: normalizeOptionalString(entry.sourcePath, 'module_source_path'),
    buttonExport: normalizeOptionalString(entry.buttonExport, 'module_button_export') || 'Button',
    paneExport: normalizeOptionalString(entry.paneExport, 'module_pane_export') || 'Pane',
    clientUrl: normalizeAssetUrl(url, 'module_client_url'),
  }
}

function normalizeModuleEntry(entry, index) {
  if (!isPlainObject(entry)) {
    throw new Error(`module_invalid:${index}`)
  }
  const kind = normalizeRequiredString(entry.kind, 'module_kind')
  if (!MOD_KINDS.has(kind)) {
    throw new Error(`module_kind_invalid:${kind}`)
  }
  if (kind === 'system') return normalizeSystemModule(entry)
  if (kind === 'component') return normalizeComponentModule(entry)
  return normalizeSidebarModule(entry)
}

function normalizeModules(modules) {
  if (!Array.isArray(modules)) {
    throw new Error('mods_manifest_modules_must_be_array')
  }
  const out = []
  const ids = new Set()
  for (let i = 0; i < modules.length; i += 1) {
    const module = normalizeModuleEntry(modules[i], i)
    if (ids.has(module.id)) {
      throw new Error(`duplicate_mod_id:${module.id}`)
    }
    ids.add(module.id)
    out.push(module)
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}

function normalizeRoot(value, { allowNull = false } = {}) {
  if (value == null) {
    if (allowNull) return null
    throw new Error('mods_manifest_missing')
  }
  if (!isPlainObject(value)) {
    throw new Error('mods_manifest_invalid')
  }

  const version = normalizeVersion(value.version)
  const modules = normalizeModules(Array.isArray(value.modules) ? value.modules : [])
  const loadOrder = value.loadOrder == null ? null : normalizeModOrderSpec(value.loadOrder)

  if (loadOrder) {
    resolveModOrder(
      modules.map(module => module.id),
      loadOrder
    )
  }

  return {
    version,
    deployedAt: normalizeOptionalString(value.deployedAt, 'mods_manifest_deployed_at'),
    deployNote: normalizeOptionalString(value.deployNote, 'mods_manifest_deploy_note'),
    modules,
    loadOrder,
  }
}

export function validateModManifest(value, options = {}) {
  try {
    normalizeRoot(value, options)
    return { ok: true, error: null }
  } catch (err) {
    return { ok: false, error: err?.message || 'mods_manifest_invalid' }
  }
}

export function normalizeModManifest(value, options = {}) {
  return normalizeRoot(value, options)
}

export function createEmptyModManifest() {
  return {
    version: MODS_MANIFEST_VERSION,
    deployedAt: null,
    deployNote: null,
    modules: [],
    loadOrder: null,
  }
}

export function getModModuleIds(manifest) {
  const normalized = normalizeModManifest(manifest)
  return normalized.modules.map(module => module.id)
}

export function getSystemModEntries(manifest, { target } = {}) {
  const normalized = normalizeModManifest(manifest)
  const wantsServer = target === 'server'
  const wantsClient = target === 'client'
  return normalized.modules.filter(module => {
    if (module.kind !== 'system') return false
    if (!wantsServer && !wantsClient) return true
    if (wantsServer) return module.scope === 'server' || module.scope === 'shared'
    return module.scope === 'client' || module.scope === 'shared'
  })
}

export function getClientUIModEntries(manifest) {
  const normalized = normalizeModManifest(manifest)
  const components = []
  const sidebar = []
  for (const module of normalized.modules) {
    if (module.kind === 'component') {
      components.push(module)
      continue
    }
    if (module.kind === 'sidebar') {
      sidebar.push(module)
    }
  }
  return { components, sidebar }
}

export { MODS_MANIFEST_VERSION }
