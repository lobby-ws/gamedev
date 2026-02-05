import { uuid } from '../core/utils'

const MANAGED_BY_VALUES = new Set(['local', 'runtime', 'shared'])

function normalizeString(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function normalizeScope(value) {
  return normalizeString(value)
}

function normalizeLastOpId(value) {
  if (value == null) return null
  const normalized = normalizeString(value)
  return normalized || null
}

function toIsoString(value, fallback) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed) {
      const parsed = Date.parse(trimmed)
      if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
    }
  }
  if (value instanceof Date) {
    const ts = value.getTime()
    if (Number.isFinite(ts)) return new Date(ts).toISOString()
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString()
  }
  return fallback
}

function createUid() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `${uuid()}-${uuid()}-${uuid()}-${uuid()}`
}

export function deriveScopeFromBlueprintId(id) {
  const normalized = normalizeString(id)
  if (!normalized) return 'global'
  if (normalized === '$scene') return '$scene'
  const idx = normalized.indexOf('__')
  if (idx === -1) return normalized
  const appName = normalized.slice(0, idx).trim()
  return appName || 'global'
}

function deriveScopeFromEntityData(entity, explicitScope) {
  const normalizedScope = normalizeScope(explicitScope)
  if (normalizedScope) return normalizedScope
  const blueprintId = normalizeString(entity?.blueprint)
  if (blueprintId) return deriveScopeFromBlueprintId(blueprintId)
  const entityId = normalizeString(entity?.id)
  if (entityId) return deriveScopeFromBlueprintId(entityId)
  return 'global'
}

function normalizeMetadata(
  target,
  { defaultScope, touch = false, now, updatedBy = 'runtime', updateSource = 'runtime', lastOpId } = {}
) {
  if (!target || typeof target !== 'object') return target

  const nowIso = toIsoString(now, new Date().toISOString())

  const uid = normalizeString(target.uid)
  target.uid = uid || createUid()

  const scope = normalizeScope(target.scope) || normalizeScope(defaultScope) || 'global'
  target.scope = scope

  if (!MANAGED_BY_VALUES.has(target.managedBy)) {
    target.managedBy = 'shared'
  }

  if (touch || !normalizeString(target.updatedAt)) {
    target.updatedAt = nowIso
  } else {
    target.updatedAt = toIsoString(target.updatedAt, nowIso)
  }

  const normalizedUpdatedBy = normalizeString(updatedBy) || 'runtime'
  if (touch || !normalizeString(target.updatedBy)) {
    target.updatedBy = normalizedUpdatedBy
  } else {
    target.updatedBy = normalizeString(target.updatedBy)
  }

  const normalizedUpdateSource = normalizeString(updateSource) || 'runtime'
  if (touch || !normalizeString(target.updateSource)) {
    target.updateSource = normalizedUpdateSource
  } else {
    target.updateSource = normalizeString(target.updateSource)
  }

  if (lastOpId !== undefined) {
    target.lastOpId = normalizeLastOpId(lastOpId)
  } else if (target.lastOpId === undefined) {
    target.lastOpId = null
  } else {
    target.lastOpId = normalizeLastOpId(target.lastOpId)
  }

  return target
}

export function ensureBlueprintSyncMetadata(blueprint, options = {}) {
  if (!blueprint || typeof blueprint !== 'object') return blueprint
  const scope = normalizeScope(options.scope) || deriveScopeFromBlueprintId(blueprint.id)
  return normalizeMetadata(blueprint, { ...options, defaultScope: scope })
}

export function ensureEntitySyncMetadata(entity, options = {}) {
  if (!entity || typeof entity !== 'object') return entity
  const scope = deriveScopeFromEntityData(entity, options.scope || options.blueprintScope)
  return normalizeMetadata(entity, { ...options, defaultScope: scope })
}
