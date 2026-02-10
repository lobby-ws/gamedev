import assert from 'node:assert/strict'
import path from 'path'
import { test } from 'node:test'
import Knex from 'knex'

import { cleaner } from '../../src/server/cleaner.js'
import { createTempDir } from './helpers.js'

async function createCleanerDb(prefix) {
  const dir = await createTempDir(prefix)
  const db = Knex({
    client: 'better-sqlite3',
    connection: {
      filename: path.join(dir, 'db.sqlite'),
    },
    useNullAsDefault: true,
  })
  await db.schema.createTable('blueprints', table => {
    table.string('id').primary()
    table.text('data').notNullable()
  })
  await db.schema.createTable('entities', table => {
    table.string('id').primary()
    table.text('data').notNullable()
  })
  await db.schema.createTable('users', table => {
    table.string('id').primary()
    table.string('avatar')
  })
  await db.schema.createTable('config', table => {
    table.string('key').primary()
    table.text('value')
  })
  return db
}

test('cleaner keeps mod assets referenced by persisted manifest', async () => {
  const keepHash = `${'a'.repeat(64)}.js`
  const staleHash = `${'b'.repeat(64)}.js`
  const otherHash = `${'c'.repeat(64)}.png`

  const db = await createCleanerDb('hyperfy-cleaner-mods-')
  try {
    const manifest = {
      version: 1,
      modules: [
        {
          id: 'core.server.echo',
          kind: 'system',
          scope: 'server',
          serverUrl: `asset://mods/${keepHash}`,
        },
      ],
      loadOrder: null,
    }
    await db('config').insert([
      { key: 'settings', value: '{}' },
      { key: 'mods_manifest', value: JSON.stringify(manifest) },
      { key: 'mods_load_order_override', value: 'null' },
    ])

    const deleted = []
    const assetsApi = {
      async list() {
        return new Set([`mods/${keepHash}`, `mods/${staleHash}`, otherHash])
      },
      async delete(assets) {
        deleted.push(...Array.from(assets))
      },
    }

    const result = await cleaner.run({
      db,
      dryrun: false,
      assetsApi,
    })

    const deletedSet = new Set(deleted)
    assert.equal(result.deletedAssets, 2)
    assert.equal(deletedSet.has(`mods/${keepHash}`), false)
    assert.equal(deletedSet.has(`mods/${staleHash}`), true)
    assert.equal(deletedSet.has(otherHash), true)
  } finally {
    await db.destroy()
  }
})

