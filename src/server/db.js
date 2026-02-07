import Knex from 'knex'
import moment from 'moment'
import fs from 'fs-extra'
import path from 'path'
import { uuid } from '../core/utils'
import { defaults, isEqual } from 'lodash-es'
import { Ranks } from '../core/extras/ranks'
import { assets } from './assets'
import { ensureBlueprintSyncMetadata, ensureEntitySyncMetadata } from './syncMetadata'

let db

export async function getDB({ worldDir }) {
  if (!db) {
    const isPostgres = process.env.DB_URI?.startsWith('postgres://') || process.env.DB_URI?.startsWith('postgresql://')
    if (isPostgres) {
      const schema = process.env.DB_SCHEMA || 'public'
      db = Knex({
        client: 'pg',
        connection: process.env.DB_URI,
        pool: { min: 2, max: 10 },
        searchPath: [schema],
        useNullAsDefault: true,
      })
      if (schema !== 'public') {
        await db.raw(`CREATE SCHEMA IF NOT EXISTS ??`, [schema])
      }
    } else {
      db = Knex({
        client: 'better-sqlite3',
        connection: {
          filename: path.join(worldDir, '/db.sqlite'),
        },
        useNullAsDefault: true,
      })
    }
    await migrate(db)
  }
  return db
}

async function migrate(db) {
  // ensure we have our config table
  const exists = await db.schema.hasTable('config')
  if (!exists) {
    await db.schema.createTable('config', table => {
      table.string('key').primary()
      table.text('value')
    })
    await db('config').insert({ key: 'version', value: '0' })
  }
  // get current version
  const versionRow = await db('config').where('key', 'version').first()
  let version = parseInt(versionRow.value)
  // run missing migrations
  for (let i = version; i < migrations.length; i++) {
    console.log(`[db] migration #${i + 1}`)
    await migrations[i](db)
    await db('config')
      .where('key', 'version')
      .update('value', (i + 1).toString())
    version = i + 1
  }
}

/**
 * NOTE: always append new migrations and never modify pre-existing ones!
 */
const migrations = [
  // add users table
  async db => {
    await db.schema.createTable('users', table => {
      table.string('id').primary()
      table.string('name').notNullable()
      table.string('roles').notNullable()
      table.timestamp('createdAt').notNullable()
    })
  },
  // add blueprints & entities tables
  async db => {
    await db.schema.createTable('blueprints', table => {
      table.string('id').primary()
      table.text('data').notNullable()
      table.timestamp('createdAt').notNullable()
      table.timestamp('updatedAt').notNullable()
    })
    await db.schema.createTable('entities', table => {
      table.string('id').primary()
      table.text('data').notNullable()
      table.timestamp('createdAt').notNullable()
      table.timestamp('updatedAt').notNullable()
    })
  },
  // add blueprint.version field
  async db => {
    const now = moment().toISOString()
    const blueprints = await db('blueprints')
    for (const blueprint of blueprints) {
      const data = JSON.parse(blueprint.data)
      if (data.version === undefined) {
        data.version = 0
        await db('blueprints')
          .where('id', blueprint.id)
          .update({
            data: JSON.stringify(data),
            updatedAt: now,
          })
      }
    }
  },
  // add user.vrm field
  async db => {
    await db.schema.alterTable('users', table => {
      table.string('vrm').nullable()
    })
  },
  // add blueprint.config field
  async db => {
    const blueprints = await db('blueprints')
    for (const blueprint of blueprints) {
      const data = JSON.parse(blueprint.data)
      if (data.config === undefined) {
        data.config = {}
        await db('blueprints')
          .where('id', blueprint.id)
          .update({
            data: JSON.stringify(data),
          })
      }
    }
  },
  // rename user.vrm -> user.avatar
  async db => {
    await db.schema.alterTable('users', table => {
      table.renameColumn('vrm', 'avatar')
    })
  },
  // add blueprint.preload field
  async db => {
    const blueprints = await db('blueprints')
    for (const blueprint of blueprints) {
      const data = JSON.parse(blueprint.data)
      if (data.preload === undefined) {
        data.preload = false
        await db('blueprints')
          .where('id', blueprint.id)
          .update({
            data: JSON.stringify(data),
          })
      }
    }
  },
  // blueprint.config -> blueprint.props
  async db => {
    const blueprints = await db('blueprints')
    for (const blueprint of blueprints) {
      const data = JSON.parse(blueprint.data)
      data.props = data.config
      delete data.config
      await db('blueprints')
        .where('id', blueprint.id)
        .update({
          data: JSON.stringify(data),
        })
    }
  },
  // add blueprint.public and blueprint.locked fields
  async db => {
    const blueprints = await db('blueprints')
    for (const blueprint of blueprints) {
      const data = JSON.parse(blueprint.data)
      let changed
      if (data.public === undefined) {
        data.public = false
        changed = true
      }
      if (data.locked === undefined) {
        data.locked = false
        changed = true
      }
      if (changed) {
        await db('blueprints')
          .where('id', blueprint.id)
          .update({
            data: JSON.stringify(data),
          })
      }
    }
  },
  // add blueprint.unique field
  async db => {
    const blueprints = await db('blueprints')
    for (const blueprint of blueprints) {
      const data = JSON.parse(blueprint.data)
      let changed
      if (data.unique === undefined) {
        data.unique = false
        changed = true
      }
      if (changed) {
        await db('blueprints')
          .where('id', blueprint.id)
          .update({
            data: JSON.stringify(data),
          })
      }
    }
  },
  // rename config key to settings
  async db => {
    let config = await db('config').where('key', 'config').first()
    if (config) {
      const settings = config.value
      await db('config').insert({ key: 'settings', value: settings })
      await db('config').where('key', 'config').delete()
    }
  },
  // add blueprint.disabled field
  async db => {
    const blueprints = await db('blueprints')
    for (const blueprint of blueprints) {
      const data = JSON.parse(blueprint.data)
      if (data.disabled === undefined) {
        data.disabled = false
        await db('blueprints')
          .where('id', blueprint.id)
          .update({
            data: JSON.stringify(data),
          })
      }
    }
  },
  // add entity.scale field
  async db => {
    const entities = await db('entities')
    for (const entity of entities) {
      const data = JSON.parse(entity.data)
      if (!data.scale) {
        data.scale = [1, 1, 1]
        await db('entities')
          .where('id', entity.id)
          .update({
            data: JSON.stringify(data),
          })
      }
    }
  },
  // add blueprint.scene field
  async db => {
    const blueprints = await db('blueprints')
    for (const blueprint of blueprints) {
      const data = JSON.parse(blueprint.data)
      let changed
      if (data.scene === undefined) {
        data.scene = false
        changed = true
      }
      if (changed) {
        await db('blueprints')
          .where('id', blueprint.id)
          .update({
            data: JSON.stringify(data),
          })
      }
    }
  },
  // migrate or generate scene app
  async db => {
    const now = moment().toISOString()
    const record = await db('config').where('key', 'settings').first()
    const settings = JSON.parse(record?.value || '{}')
    // if using a settings model, we'll convert this to scene app
    if (settings.model) {
      // create blueprint and entity
      const blueprintId = '$scene' // singleton
      const blueprint = {
        id: blueprintId,
        data: JSON.stringify({
          id: blueprintId,
          version: 0,
          name: 'Scene',
          image: null,
          author: null,
          url: null,
          desc: null,
          model: settings.model.url,
          script: null,
          props: null,
          preload: true,
          public: false,
          locked: false,
          frozen: false,
          unique: true,
          scene: true,
          disabled: false,
          keep: true,
        }),
        createdAt: now,
        updatedAt: now,
      }
      await db('blueprints').insert(blueprint)
      const entityId = uuid()
      const entity = {
        id: entityId,
        data: JSON.stringify({
          id: entityId,
          type: 'app',
          blueprint: blueprint.id,
          position: [0, 0, 0],
          quaternion: [0, 0, 0, 1],
          scale: [1, 1, 1],
          mover: null,
          uploader: null,
          pinned: false,
          props: {},
          state: {},
        }),
        createdAt: now,
        updatedAt: now,
      }
      await db('entities').insert(entity)
      // clear settings.model
      delete settings.model
      await db('config')
        .where('key', 'settings')
        .update({ value: JSON.stringify(settings) })
    }
    // otherwise create the default scene from built-in assets
    else {
      const blueprintId = '$scene'
      const blueprint = {
        id: blueprintId,
        data: JSON.stringify({
          id: blueprintId,
          version: 0,
          name: 'Scene',
          image: null,
          author: null,
          url: null,
          desc: null,
          model: 'asset://Model.glb',
          script: 'asset://scene.js',
          scriptEntry: 'scene.js',
          scriptFiles: {
            'scene.js': 'asset://scene.js',
          },
          scriptFormat: 'module',
          props: {
            hour: 4,
            period: 'pm',
            intensity: 1,
            sky: {
              url: 'asset://sky.jpg',
            },
            hdr: {
              url: 'asset://sky.hdr',
            },
            verticalRotation: 40,
            horizontalRotation: 230,
            rotationY: 0,
            fogNear: 450,
            fogFar: 1000,
            fogColor: '#97b4d3',
          },
          preload: true,
          public: false,
          locked: false,
          frozen: false,
          unique: true,
          scene: true,
          disabled: false,
          keep: true,
        }),
        createdAt: now,
        updatedAt: now,
      }
      await db('blueprints').insert(blueprint)
      const entityId = uuid()
      const entity = {
        id: entityId,
        data: JSON.stringify({
          id: entityId,
          type: 'app',
          blueprint: blueprint.id,
          position: [0, 0, 0],
          quaternion: [0, 0, 0, 1],
          scale: [1, 1, 1],
          mover: null,
          uploader: null,
          pinned: false,
          props: {},
          state: {},
        }),
        createdAt: now,
        updatedAt: now,
      }
      await db('entities').insert(entity)
    }
  },
  // ensure settings exists with defaults AND default new voice setting to spatial
  async db => {
    const row = await db('config').where('key', 'settings').first()
    const settings = row ? JSON.parse(row.value) : {}
    defaults(settings, {
      title: null,
      desc: null,
      image: null,
      avatar: null,
      voice: 'spatial',
      public: false,
      playerLimit: 0,
      ao: true,
    })
    const value = JSON.stringify(settings)
    if (row) {
      await db('config').where('key', 'settings').update({ value })
    } else {
      await db('config').insert({ key: 'settings', value })
    }
  },
  // migrate roles to rank
  async db => {
    // default rank setting
    const row = await db('config').where('key', 'settings').first()
    const settings = JSON.parse(row.value)
    settings.rank = settings.public ? Ranks.BUILDER : Ranks.VISITOR
    delete settings.public
    const value = JSON.stringify(settings)
    await db('config').where('key', 'settings').update({ value })
    // player ranks
    await db.schema.alterTable('users', table => {
      table.integer('rank').notNullable().defaultTo(0)
    })
    const users = await db('users')
    for (const user of users) {
      const roles = user.roles.split(',')
      const rank = roles.includes('admin') ? Ranks.ADMIN : roles.includes('builder') ? Ranks.BUILDER : Ranks.VISITOR
      await db('users').where('id', user.id).update({ rank })
    }
    await db.schema.alterTable('users', table => {
      table.dropColumn('roles')
    })
  },
  // add new settings.customAvatars (defaults to false)
  async db => {
    const row = await db('config').where('key', 'settings').first()
    const settings = JSON.parse(row.value)
    settings.customAvatars = false
    const value = JSON.stringify(settings)
    await db('config').where('key', 'settings').update({ value })
  },
  // change config table 'value' column from string(255) to text
  async db => {
    await db.transaction(async trx => {
      // make replacement table
      await trx.schema.createTable('_config_new', table => {
        table.string('key').primary()
        table.text('value') // in older versions this was string(255) but we want text
      })
      // copy everything over
      await trx.raw('INSERT INTO _config_new (key, value) SELECT key, value FROM config')
      // swap and destroy old
      await trx.schema.dropTable('config')
      await trx.schema.renameTable('_config_new', 'config')
    })
  },
  // persist worldId in config
  async db => {
    const existing = await db('config').where('key', 'worldId').first()
    const envWorldId = process.env.WORLD_ID
    if (existing) {
      if (envWorldId && existing.value !== envWorldId) {
        throw new Error(`[db] WORLD_ID mismatch: env=${envWorldId} db=${existing.value}`)
      }
      return
    }
    const worldId = envWorldId || uuid()
    await db('config')
      .insert({ key: 'worldId', value: worldId })
      .onConflict('key')
      .merge({ value: worldId })
  },
  // seed default template blueprints (Model/Image/Video/Text) if only scene exists
  async db => {
    const blueprintRows = await db('blueprints')
    let hasNonScene = false
    const existingIds = new Set()
    for (const row of blueprintRows) {
      const data = JSON.parse(row.data)
      existingIds.add(row.id)
      if (!data.scene) {
        hasNonScene = true
      }
    }
    if (hasNonScene) return

    const now = moment().toISOString()
    const templates = [
      {
        id: 'Model',
        name: 'Model',
        image: { url: 'asset://Model.png' },
        model: 'asset://Model.glb',
        script: 'asset://Model.js',
        scriptEntry: 'Model.js',
        scriptFiles: {
          'Model.js': 'asset://Model.js',
        },
        scriptFormat: 'module',
        props: { collision: true },
      },
      {
        id: 'Image',
        name: 'Image',
        image: { url: 'asset://Image.png' },
        model: 'asset://Image.glb',
        script: 'asset://Image.js',
        scriptEntry: 'Image.js',
        scriptFiles: {
          'Image.js': 'asset://Image.js',
        },
        scriptFormat: 'module',
        props: {
          width: 0,
          height: 2,
          fit: 'cover',
          image: null,
          transparent: false,
          lit: false,
          shadows: true,
          placeholder: {
            type: 'image',
            url: 'asset://Image.png',
          },
        },
      },
      {
        id: 'Video',
        name: 'Video',
        image: { url: 'asset://Video.png' },
        model: 'asset://Video.glb',
        script: 'asset://Video.js',
        scriptEntry: 'Video.js',
        scriptFiles: {
          'Video.js': 'asset://Video.js',
        },
        scriptFormat: 'module',
        props: {
          width: 0,
          height: 2,
          fit: 'cover',
          url: null,
          loop: true,
          autoplay: true,
          transparent: false,
          lit: false,
          shadows: true,
          placeholder: {
            type: 'video',
            url: 'asset://Video.mp4',
          },
        },
      },
      {
        id: 'Text',
        name: 'Text',
        image: { url: 'asset://Text.png' },
        model: 'asset://Text.glb',
        script: 'asset://Text.js',
        scriptEntry: 'Text.js',
        scriptFiles: {
          'Text.js': 'asset://Text.js',
        },
        scriptFormat: 'module',
        props: {
          width: 200,
          height: 200,
          text: 'Enter text...',
          fontSize: 20,
          fontWeight: 'bold',
          color: '#ffffff',
          transparent: false,
          lit: false,
          shadows: true,
        },
      },
    ]

    for (const template of templates) {
      if (existingIds.has(template.id)) continue
      const blueprint = {
        id: template.id,
        data: JSON.stringify({
          id: template.id,
          version: 0,
          name: template.name,
          image: template.image,
          author: null,
          url: null,
          desc: null,
          model: template.model,
          script: template.script,
          scriptEntry: template.scriptEntry,
          scriptFiles: template.scriptFiles,
          scriptFormat: template.scriptFormat,
          props: template.props,
          preload: false,
          public: false,
          locked: false,
          frozen: false,
          unique: true,
          scene: false,
          disabled: false,
          keep: true,
        }),
        createdAt: now,
        updatedAt: now,
      }
      await db('blueprints').insert(blueprint)
    }
  },
  // add deploy snapshots table
  async db => {
    await db.schema.createTable('deploy_snapshots', table => {
      table.string('id').primary()
      table.text('data').notNullable()
      table.text('meta')
      table.timestamp('createdAt').notNullable()
    })
  },
  // set built-in templates to unique=true
  async db => {
    const builtins = ['Model', 'Image', 'Video', 'Text']
    const rows = await db('blueprints').whereIn('id', builtins)
    for (const row of rows) {
      const data = JSON.parse(row.data)
      if (data?.unique === true) continue
      data.unique = true
      await db('blueprints')
        .where('id', row.id)
        .update({ data: JSON.stringify(data) })
    }
  },
  // add blueprint.createdAt + blueprint.keep fields to blueprint JSON
  async db => {
    const rows = await db('blueprints')
    for (const row of rows) {
      const data = JSON.parse(row.data)
      let changed = false
      if (!data.createdAt && row.createdAt) {
        data.createdAt = row.createdAt
        changed = true
      }
      if (data.keep === undefined) {
        data.keep = false
        changed = true
      }
      if (changed) {
        await db('blueprints')
          .where('id', row.id)
          .update({ data: JSON.stringify(data) })
      }
    }
  },
  // add bidirectional sync metadata to blueprint/entity JSON records
  async db => {
    const now = moment().toISOString()
    const blueprintScopes = new Map()

    const blueprintRows = await db('blueprints')
    for (const row of blueprintRows) {
      const data = JSON.parse(row.data)
      const rowNow = row.updatedAt || now
      const previous = JSON.stringify(data)
      ensureBlueprintSyncMetadata(data, {
        now: rowNow,
        touch: false,
        updatedBy: 'system:migration',
        updateSource: 'migration',
      })
      blueprintScopes.set(row.id, data.scope)
      const next = JSON.stringify(data)
      if (next !== previous) {
        await db('blueprints')
          .where('id', row.id)
          .update({
            data: next,
            updatedAt: data.updatedAt || rowNow,
          })
      }
    }

    const entityRows = await db('entities')
    for (const row of entityRows) {
      const data = JSON.parse(row.data)
      const rowNow = row.updatedAt || now
      const previous = JSON.stringify(data)
      const blueprintScope = typeof data.blueprint === 'string' ? blueprintScopes.get(data.blueprint) : null
      ensureEntitySyncMetadata(data, {
        now: rowNow,
        touch: false,
        scope: blueprintScope || undefined,
        updatedBy: 'system:migration',
        updateSource: 'migration',
      })
      const next = JSON.stringify(data)
      if (next !== previous) {
        await db('entities')
          .where('id', row.id)
          .update({
            data: next,
            updatedAt: data.updatedAt || rowNow,
          })
      }
    }
  },
  // add durable sync changefeed table
  async db => {
    const exists = await db.schema.hasTable('sync_changes')
    if (exists) return
    await db.schema.createTable('sync_changes', table => {
      table.bigIncrements('cursor').primary()
      table.string('opId').notNullable().unique()
      table.timestamp('ts').notNullable()
      table.string('actor').notNullable()
      table.string('source').notNullable()
      table.string('kind').notNullable()
      table.string('objectUid').notNullable()
      table.text('patch')
      table.text('snapshot')
      table.timestamp('createdAt').notNullable()
    })
    await db.schema.alterTable('sync_changes', table => {
      table.index(['ts'])
      table.index(['kind'])
      table.index(['objectUid'])
    })
  },
  // remove legacy built-in template blueprints (defaults now live client-side)
  async db => {
    const builtinTemplates = new Map([
      [
        'Model',
        {
          id: 'Model',
          name: 'Model',
          image: { url: 'asset://Model.png' },
          model: 'asset://Model.glb',
          script: 'asset://Model.js',
          scriptEntry: 'Model.js',
          scriptFiles: { 'Model.js': 'asset://Model.js' },
          scriptFormat: 'module',
          props: { collision: true },
        },
      ],
      [
        'Image',
        {
          id: 'Image',
          name: 'Image',
          image: { url: 'asset://Image.png' },
          model: 'asset://Image.glb',
          script: 'asset://Image.js',
          scriptEntry: 'Image.js',
          scriptFiles: { 'Image.js': 'asset://Image.js' },
          scriptFormat: 'module',
          props: {
            width: 0,
            height: 2,
            fit: 'cover',
            image: null,
            transparent: false,
            lit: false,
            shadows: true,
            placeholder: {
              type: 'image',
              url: 'asset://Image.png',
            },
          },
        },
      ],
      [
        'Video',
        {
          id: 'Video',
          name: 'Video',
          image: { url: 'asset://Video.png' },
          model: 'asset://Video.glb',
          script: 'asset://Video.js',
          scriptEntry: 'Video.js',
          scriptFiles: { 'Video.js': 'asset://Video.js' },
          scriptFormat: 'module',
          props: {
            width: 0,
            height: 2,
            fit: 'cover',
            url: null,
            loop: true,
            autoplay: true,
            transparent: false,
            lit: false,
            shadows: true,
            placeholder: {
              type: 'video',
              url: 'asset://Video.mp4',
            },
          },
        },
      ],
      [
        'Text',
        {
          id: 'Text',
          name: 'Text',
          image: { url: 'asset://Text.png' },
          model: 'asset://Text.glb',
          script: 'asset://Text.js',
          scriptEntry: 'Text.js',
          scriptFiles: { 'Text.js': 'asset://Text.js' },
          scriptFormat: 'module',
          props: {
            width: 200,
            height: 200,
            text: 'Enter text...',
            fontSize: 20,
            fontWeight: 'bold',
            color: '#ffffff',
            transparent: false,
            lit: false,
            shadows: true,
          },
        },
      ],
    ])
    const builtinIds = Array.from(builtinTemplates.keys())

    const normalizeScriptRef = value => {
      if (typeof value !== 'string') return null
      const trimmed = value.trim()
      return trimmed || null
    }

    const extractComparable = data => ({
      id: data?.id || null,
      name: data?.name || null,
      image: data?.image ?? null,
      model: data?.model ?? null,
      script: data?.script ?? null,
      scriptEntry: data?.scriptEntry ?? null,
      scriptFiles: data?.scriptFiles ?? null,
      scriptFormat: data?.scriptFormat ?? null,
      scriptRef: data?.scriptRef ?? null,
      props: data?.props ?? {},
      preload: !!data?.preload,
      public: !!data?.public,
      locked: !!data?.locked,
      frozen: !!data?.frozen,
      unique: !!data?.unique,
      scene: !!data?.scene,
      disabled: !!data?.disabled,
      keep: data?.keep === undefined ? false : !!data.keep,
      author: data?.author ?? null,
      url: data?.url ?? null,
      desc: data?.desc ?? null,
    })

    const isCanonicalBuiltin = (data, template) => {
      const expected = {
        id: template.id,
        name: template.name,
        image: template.image,
        model: template.model,
        script: template.script,
        scriptEntry: template.scriptEntry,
        scriptFiles: template.scriptFiles,
        scriptFormat: template.scriptFormat,
        scriptRef: null,
        props: template.props,
        preload: false,
        public: false,
        locked: false,
        frozen: false,
        unique: true,
        scene: false,
        disabled: false,
        keep: true,
        author: null,
        url: null,
        desc: null,
      }
      return isEqual(extractComparable(data), expected)
    }

    const builtinRows = await db('blueprints').whereIn('id', builtinIds)
    if (!builtinRows.length) return
    const builtinById = new Map()
    for (const row of builtinRows) {
      const template = builtinTemplates.get(row.id)
      if (!template) continue
      try {
        const data = JSON.parse(row.data)
        builtinById.set(row.id, { row, data, template })
      } catch {}
    }
    if (!builtinById.size) return

    // Inline script roots for legacy variants that still point at built-in scriptRef ids.
    const allBlueprintRows = await db('blueprints')
    for (const row of allBlueprintRows) {
      if (builtinById.has(row.id)) continue
      let data
      try {
        data = JSON.parse(row.data)
      } catch {
        continue
      }
      const scriptRef = normalizeScriptRef(data?.scriptRef)
      if (!scriptRef || !builtinById.has(scriptRef)) continue
      const builtin = builtinById.get(scriptRef)
      if (!builtin?.template) continue

      const next = { ...data, scriptRef: null }
      if (typeof next.script !== 'string' || !next.script.trim()) {
        next.script = builtin.template.script
      }
      if (typeof next.scriptEntry !== 'string' || !next.scriptEntry.trim()) {
        next.scriptEntry = builtin.template.scriptEntry
      }
      if (!next.scriptFiles || typeof next.scriptFiles !== 'object' || Array.isArray(next.scriptFiles)) {
        next.scriptFiles = builtin.template.scriptFiles
      }
      if (typeof next.scriptFormat !== 'string' || !next.scriptFormat.trim()) {
        next.scriptFormat = builtin.template.scriptFormat
      }

      if (!isEqual(data, next)) {
        await db('blueprints')
          .where('id', row.id)
          .update({
            data: JSON.stringify(next),
            updatedAt: row.updatedAt || moment().toISOString(),
          })
      }
    }

    const entityRows = await db('entities')
    const builtinInUseByEntity = new Set()
    for (const row of entityRows) {
      try {
        const data = JSON.parse(row.data)
        if (typeof data?.blueprint === 'string' && builtinById.has(data.blueprint)) {
          builtinInUseByEntity.add(data.blueprint)
        }
      } catch {}
    }

    const postRows = await db('blueprints')
    const builtinInUseByScriptRef = new Set()
    for (const row of postRows) {
      try {
        const data = JSON.parse(row.data)
        const scriptRef = normalizeScriptRef(data?.scriptRef)
        if (scriptRef && builtinById.has(scriptRef)) {
          builtinInUseByScriptRef.add(scriptRef)
        }
      } catch {}
    }

    for (const [id, entry] of builtinById.entries()) {
      if (builtinInUseByEntity.has(id)) continue
      if (builtinInUseByScriptRef.has(id)) continue
      if (!isCanonicalBuiltin(entry.data, entry.template)) continue
      await db('blueprints').where('id', id).delete()
    }
  },
]
