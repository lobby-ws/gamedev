function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeId(value, label) {
  if (typeof value !== 'string') {
    throw new Error(`${label}_must_be_string`)
  }
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`${label}_missing`)
  }
  return trimmed
}

function normalizeIdList(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label}_must_be_array`)
  }
  const out = []
  const seen = new Set()
  for (let i = 0; i < value.length; i += 1) {
    const id = normalizeId(value[i], `${label}_item`)
    if (seen.has(id)) {
      throw new Error(`duplicate_${label}_id:${id}`)
    }
    seen.add(id)
    out.push(id)
  }
  return out
}

function normalizeRelationMap(value, label) {
  if (value == null) return {}
  if (!isPlainObject(value)) {
    throw new Error(`${label}_must_be_object`)
  }
  const out = {}
  for (const [rawKey, rawList] of Object.entries(value)) {
    const key = normalizeId(rawKey, `${label}_key`)
    out[key] = normalizeIdList(rawList, `${label}_${key}`)
  }
  return out
}

function buildKnownIds(ids) {
  if (!Array.isArray(ids)) {
    throw new Error('known_ids_must_be_array')
  }
  const sorted = []
  const seen = new Set()
  for (let i = 0; i < ids.length; i += 1) {
    const id = normalizeId(ids[i], 'known_id')
    if (seen.has(id)) continue
    seen.add(id)
    sorted.push(id)
  }
  sorted.sort((a, b) => a.localeCompare(b))
  return sorted
}

function assertKnown(id, knownIdsSet) {
  if (!knownIdsSet.has(id)) {
    throw new Error(`unknown_order_id:${id}`)
  }
}

export function normalizeModOrderSpec(orderSpec) {
  if (orderSpec == null) return null

  if (Array.isArray(orderSpec)) {
    return {
      order: normalizeIdList(orderSpec, 'order'),
      before: {},
      after: {},
    }
  }

  if (!isPlainObject(orderSpec)) {
    throw new Error('load_order_invalid_type')
  }

  const order = orderSpec.order == null ? [] : normalizeIdList(orderSpec.order, 'order')
  const before = normalizeRelationMap(orderSpec.before, 'before')
  const after = normalizeRelationMap(orderSpec.after, 'after')

  return { order, before, after }
}

function addEdge(adjacency, from, to) {
  if (from === to) {
    throw new Error(`cyclic_order:self_reference:${from}`)
  }
  adjacency.get(from).add(to)
}

export function resolveModOrder(knownIds, orderSpec, { requireComplete = false } = {}) {
  const ids = buildKnownIds(knownIds)
  if (!ids.length) return []
  const knownIdsSet = new Set(ids)

  const spec = normalizeModOrderSpec(orderSpec)
  if (!spec) return ids

  for (const id of spec.order) {
    assertKnown(id, knownIdsSet)
  }
  for (const [id, list] of Object.entries(spec.before)) {
    assertKnown(id, knownIdsSet)
    for (const target of list) {
      assertKnown(target, knownIdsSet)
    }
  }
  for (const [id, list] of Object.entries(spec.after)) {
    assertKnown(id, knownIdsSet)
    for (const target of list) {
      assertKnown(target, knownIdsSet)
    }
  }

  if (requireComplete) {
    const listed = new Set(spec.order)
    const missing = ids.filter(id => !listed.has(id))
    if (missing.length) {
      throw new Error(`missing_order_entries:${missing.join(',')}`)
    }
  }

  const adjacency = new Map()
  const indegree = new Map()
  for (const id of ids) {
    adjacency.set(id, new Set())
    indegree.set(id, 0)
  }

  for (let i = 1; i < spec.order.length; i += 1) {
    addEdge(adjacency, spec.order[i - 1], spec.order[i])
  }

  for (const [id, list] of Object.entries(spec.before)) {
    for (const target of list) {
      addEdge(adjacency, id, target)
    }
  }

  for (const [id, list] of Object.entries(spec.after)) {
    for (const target of list) {
      addEdge(adjacency, target, id)
    }
  }

  for (const id of ids) {
    for (const nextId of adjacency.get(id)) {
      indegree.set(nextId, indegree.get(nextId) + 1)
    }
  }

  const queue = ids.filter(id => indegree.get(id) === 0)
  queue.sort((a, b) => a.localeCompare(b))
  const resolved = []

  while (queue.length) {
    const id = queue.shift()
    resolved.push(id)
    const nextIds = Array.from(adjacency.get(id))
    nextIds.sort((a, b) => a.localeCompare(b))
    for (const nextId of nextIds) {
      const nextValue = indegree.get(nextId) - 1
      indegree.set(nextId, nextValue)
      if (nextValue === 0) {
        queue.push(nextId)
      }
    }
    queue.sort((a, b) => a.localeCompare(b))
  }

  if (resolved.length !== ids.length) {
    const cyclic = ids.filter(id => indegree.get(id) > 0)
    cyclic.sort((a, b) => a.localeCompare(b))
    throw new Error(`cyclic_order:${cyclic.join(',')}`)
  }

  return resolved
}

export function resolveEffectiveModOrder({ ids, manifestOrder, overrideOrder }) {
  const knownIds = buildKnownIds(Array.isArray(ids) ? ids : [])
  const warnings = []

  if (overrideOrder != null) {
    try {
      const order = resolveModOrder(knownIds, overrideOrder)
      return { order, source: 'override', warnings }
    } catch (err) {
      warnings.push(`mods_load_order_override_ignored:${err.message}`)
    }
  }

  if (manifestOrder != null) {
    const order = resolveModOrder(knownIds, manifestOrder)
    return { order, source: 'manifest', warnings }
  }

  return { order: knownIds, source: 'fallback', warnings }
}
