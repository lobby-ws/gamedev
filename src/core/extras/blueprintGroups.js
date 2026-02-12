import { isEqual } from 'lodash-es'

function normalizeBlueprintList(blueprints) {
  if (!blueprints) return []
  if (Array.isArray(blueprints)) return blueprints
  if (typeof blueprints.values === 'function') {
    return Array.from(blueprints.values())
  }
  return []
}

function getScriptKey(blueprint) {
  if (!blueprint) return null
  const script = typeof blueprint.script === 'string' ? blueprint.script.trim() : ''
  return script || null
}

function toCreatedAtMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string') {
    const ts = Date.parse(value)
    if (Number.isFinite(ts)) return ts
  }
  return null
}

function compareBlueprintsByCreatedAt(a, b) {
  const aTime = toCreatedAtMs(a?.createdAt)
  const bTime = toCreatedAtMs(b?.createdAt)
  if (aTime !== null && bTime !== null && aTime !== bTime) {
    return aTime - bTime
  }
  if (aTime !== null && bTime === null) return -1
  if (aTime === null && bTime !== null) return 1
  const aName = (a?.name || a?.id || '').toLowerCase()
  const bName = (b?.name || b?.id || '').toLowerCase()
  if (aName < bName) return -1
  if (aName > bName) return 1
  return 0
}

export function buildScriptGroups(blueprints) {
  const groups = new Map()
  const items = normalizeBlueprintList(blueprints)
  for (const blueprint of items) {
    const script = getScriptKey(blueprint)
    if (!script) continue
    let group = groups.get(script)
    if (!group) {
      group = { script, items: [], main: null }
      groups.set(script, group)
    }
    group.items.push(blueprint)
  }
  for (const group of groups.values()) {
    group.items.sort(compareBlueprintsByCreatedAt)
    group.main = group.items[0] || null
  }
  const byId = new Map()
  for (const group of groups.values()) {
    for (const item of group.items) {
      if (!item?.id) continue
      byId.set(item.id, group)
    }
  }
  return { groups, byId }
}

export function getScriptGroupForBlueprint(groupState, blueprint) {
  if (!groupState) return null
  const id = typeof blueprint === 'string' ? blueprint : blueprint?.id
  if (!id) return null
  const byId = groupState.byId || groupState
  if (!byId || typeof byId.get !== 'function') return null
  return byId.get(id) || null
}

export function getScriptGroupMain(groupState, blueprint) {
  const group = getScriptGroupForBlueprint(groupState, blueprint)
  return group?.main || null
}

function normalizeFilePropValue(value) {
  if (Array.isArray(value)) {
    return value.map(item => normalizeFilePropValue(item))
  }
  if (value && typeof value === 'object') {
    const hasUrl = typeof value.url === 'string'
    const out = {}
    for (const [key, val] of Object.entries(value)) {
      if (hasUrl && key === 'name') continue
      out[key] = normalizeFilePropValue(val)
    }
    if (hasUrl && out.url === undefined) {
      out.url = value.url
    }
    return out
  }
  return value
}

function normalizePropsForCompare(props) {
  if (!props || typeof props !== 'object' || Array.isArray(props)) return {}
  const out = {}
  for (const [key, val] of Object.entries(props)) {
    out[key] = normalizeFilePropValue(val)
  }
  return out
}

function normalizeImageForCompare(image) {
  if (image && typeof image === 'object' && !Array.isArray(image)) {
    return { ...image }
  }
  return image ?? null
}

export function normalizeBlueprintForTwinCompare(blueprint) {
  if (!blueprint) return null
  return {
    name: blueprint.name ?? null,
    image: normalizeImageForCompare(blueprint.image),
    author: blueprint.author ?? null,
    url: blueprint.url ?? null,
    desc: blueprint.desc ?? null,
    model: blueprint.model ?? null,
    script: blueprint.script ?? null,
    scriptEntry: blueprint.scriptEntry ?? null,
    scriptFiles: blueprint.scriptFiles ?? null,
    scriptFormat: blueprint.scriptFormat ?? null,
    scriptRef: blueprint.scriptRef ?? null,
    props: normalizePropsForCompare(blueprint.props),
    preload: !!blueprint.preload,
    public: !!blueprint.public,
    locked: !!blueprint.locked,
    frozen: !!blueprint.frozen,
    unique: !!blueprint.unique,
    scene: !!blueprint.scene,
    disabled: !!blueprint.disabled,
  }
}

export function areBlueprintsTwinUnique(a, b) {
  if (!a || !b) return false
  if (!a.unique || !b.unique) return false
  const aNorm = normalizeBlueprintForTwinCompare(a)
  const bNorm = normalizeBlueprintForTwinCompare(b)
  return isEqual(aNorm, bNorm)
}
