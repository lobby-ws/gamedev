import { normalizeModManifest } from '../core/mods/manifest.js'
import { normalizeModOrderSpec } from '../core/mods/order.js'

export const MODS_MANIFEST_CONFIG_KEY = 'mods_manifest'
export const MODS_LOAD_ORDER_OVERRIDE_CONFIG_KEY = 'mods_load_order_override'

function parseConfigJson(value, key) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    return JSON.parse(value)
  } catch (err) {
    throw new Error(`${key}_invalid_json`)
  }
}

async function upsertConfig(db, { key, value }) {
  await db('config')
    .insert({ key, value })
    .onConflict('key')
    .merge({ value })
}

export async function readModsState({ db, strict = false } = {}) {
  if (!db) {
    return {
      manifest: null,
      loadOrderOverride: null,
      warnings: ['mods_db_unavailable'],
    }
  }

  const warnings = []
  const [manifestRow, overrideRow] = await Promise.all([
    db('config').where('key', MODS_MANIFEST_CONFIG_KEY).first(),
    db('config').where('key', MODS_LOAD_ORDER_OVERRIDE_CONFIG_KEY).first(),
  ])

  let manifest = null
  let loadOrderOverride = null

  try {
    const manifestRaw = parseConfigJson(manifestRow?.value, MODS_MANIFEST_CONFIG_KEY)
    if (manifestRaw != null) {
      manifest = normalizeModManifest(manifestRaw, { allowNull: true })
    }
  } catch (err) {
    const message = `mods_manifest_invalid:${err.message}`
    if (strict) throw new Error(message)
    warnings.push(message)
  }

  try {
    const overrideRaw = parseConfigJson(overrideRow?.value, MODS_LOAD_ORDER_OVERRIDE_CONFIG_KEY)
    if (overrideRaw != null) {
      loadOrderOverride = normalizeModOrderSpec(overrideRaw)
    }
  } catch (err) {
    const message = `mods_load_order_override_invalid:${err.message}`
    if (strict) throw new Error(message)
    warnings.push(message)
  }

  return { manifest, loadOrderOverride, warnings }
}

export async function writeModsManifest({ db, manifest }) {
  const normalized = normalizeModManifest(manifest, { allowNull: true })
  const value = JSON.stringify(normalized)
  await upsertConfig(db, {
    key: MODS_MANIFEST_CONFIG_KEY,
    value,
  })
  return normalized
}

export async function writeModsLoadOrderOverride({ db, loadOrderOverride }) {
  const normalized = normalizeModOrderSpec(loadOrderOverride)
  const value = JSON.stringify(normalized)
  await upsertConfig(db, {
    key: MODS_LOAD_ORDER_OVERRIDE_CONFIG_KEY,
    value,
  })
  return normalized
}

export async function clearModsLoadOrderOverride({ db }) {
  await upsertConfig(db, {
    key: MODS_LOAD_ORDER_OVERRIDE_CONFIG_KEY,
    value: 'null',
  })
}
