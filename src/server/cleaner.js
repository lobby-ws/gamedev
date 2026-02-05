import { assets } from './assets'

function collectAssetUrls(value, out) {
  if (!out) out = new Set()
  if (typeof value === 'string') {
    if (value.startsWith('asset://')) {
      out.add(value.replace('asset://', ''))
    }
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectAssetUrls(item, out)
    }
    return out
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      collectAssetUrls(item, out)
    }
  }
  return out
}

class Cleaner {
  constructor() {
    // ...
  }

  async run({ db, dryrun = false } = {}) {
    if (!db) throw new Error('db_required')
    console.log(dryrun ? '[clean] dry run' : '[clean] running')
    // get all assets
    const allAssets = await assets.list() // hash-only assets
    // get all blueprints
    const blueprints = []
    const blueprintRows = await db('blueprints')
    for (const row of blueprintRows) {
      const blueprint = JSON.parse(row.data)
      blueprints.push(blueprint)
    }
    // get all entities
    const entities = []
    const entityRows = await db('entities')
    for (const row of entityRows) {
      const entity = JSON.parse(row.data)
      entities.push(entity)
    }
    // find orphan blueprints (no entities, not scene, not keep)
    const usedBlueprintIds = new Set()
    for (const entity of entities) {
      if (entity?.type === 'app' && entity.blueprint) {
        usedBlueprintIds.add(entity.blueprint)
      }
    }
    const orphanIds = []
    const keptBlueprints = []
    for (const blueprint of blueprints) {
      const isScene = blueprint?.scene === true
      const isKept = blueprint?.keep === true
      const isUsed = blueprint?.id && usedBlueprintIds.has(blueprint.id)
      if (!isScene && !isKept && !isUsed) {
        if (blueprint?.id) orphanIds.push(blueprint.id)
        continue
      }
      keptBlueprints.push(blueprint)
    }
    if (orphanIds.length) {
      console.log(`[clean] ${orphanIds.length} orphan blueprints can be deleted`)
      if (!dryrun) {
        await db('blueprints').whereIn('id', orphanIds).delete()
        console.log(`[clean] ${orphanIds.length} orphan blueprints deleted`)
      }
    }
    // track a list of assets to keep
    const assetsToKeep = new Set()
    // keep all user equipped vrms
    const userRows = await db('users').select('avatar')
    for (const user of userRows) {
      if (user.avatar) assetsToKeep.add(user.avatar.replace('asset://', ''))
    }
    // keep world image & world avatar assets
    const settingsRow = await db('config').where('key', 'settings').first()
    const settings = JSON.parse(settingsRow.value)
    if (settings.image) assetsToKeep.add(settings.image.url.replace('asset://', ''))
    if (settings.avatar) assetsToKeep.add(settings.avatar.url.replace('asset://', ''))
    // keep all assets associated with all blueprints (spawned or unspawned)
    for (const blueprint of keptBlueprints) {
      // blueprint model
      if (blueprint.model && blueprint.model.startsWith('asset://')) {
        assetsToKeep.add(blueprint.model.replace('asset://', ''))
      }
      // blueprint script
      if (blueprint.script && blueprint.script.startsWith('asset://')) {
        assetsToKeep.add(blueprint.script.replace('asset://', ''))
      }
      if (blueprint.scriptFiles && typeof blueprint.scriptFiles === 'object') {
        for (const url of Object.values(blueprint.scriptFiles)) {
          if (typeof url === 'string' && url.startsWith('asset://')) {
            assetsToKeep.add(url.replace('asset://', ''))
          }
        }
      }
      // blueprint image (metadata)
      if (blueprint.image?.url && blueprint.image.url.startsWith('asset://')) {
        assetsToKeep.add(blueprint.image.url.replace('asset://', ''))
      }
      // assets from file props
      if (blueprint.props && typeof blueprint.props === 'object') {
        for (const key in blueprint.props) {
          const url = blueprint.props[key]?.url
          if (!url) continue
          assetsToKeep.add(url.replace('asset://', ''))
        }
      }
    }
    // keep assets referenced by entity instance props
    for (const entity of entities) {
      collectAssetUrls(entity?.props, assetsToKeep)
    }
    // get a list of assets to delete
    const assetsToDelete = new Set()
    for (const asset of allAssets) {
      if (!assetsToKeep.has(asset)) {
        assetsToDelete.add(asset)
      }
    }
    if (assetsToDelete.size) {
      console.log(`[clean] ${assetsToDelete.size} assets can be deleted`)
      if (!dryrun) {
        console.log(`[clean] ${assetsToDelete.size} assets deleted`)
        await assets.delete(assetsToDelete)
      }
    }
    console.log('[clean] complete')
    return {
      ok: true,
      dryrun,
      orphanBlueprints: orphanIds.length,
      deletedBlueprints: dryrun ? 0 : orphanIds.length,
      assetsToDelete: assetsToDelete.size,
      deletedAssets: dryrun ? 0 : assetsToDelete.size,
    }
  }

  async init({ db }) {
    const clean = process.env.CLEAN === 'true' || process.env.CLEAN === 'dryrun'
    if (!clean) return console.log('[clean] skipped')
    const dryrun = process.env.CLEAN === 'dryrun'
    await this.run({ db, dryrun })
  }
}

export const cleaner = new Cleaner()
