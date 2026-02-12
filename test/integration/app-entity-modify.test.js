import assert from 'node:assert/strict'
import { test } from 'node:test'

import { App } from '../../src/core/entities/App.js'

test('app modify rebuilds when mover updates arrive before lerp buffers exist', () => {
  const ctx = {
    data: {
      id: 'entity-1',
      mover: 'remote-user',
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      pinned: false,
      state: {},
      props: {},
    },
    buildCount: 0,
    build() {
      this.buildCount += 1
    },
  }

  assert.doesNotThrow(() => {
    App.prototype.modify.call(ctx, {
      id: 'entity-1',
      position: [1, 2, 3],
      quaternion: [0, 0, 0, 1],
      scale: [2, 2, 2],
    })
  })

  assert.equal(ctx.buildCount, 1)
  assert.deepEqual(ctx.data.position, [1, 2, 3])
  assert.deepEqual(ctx.data.scale, [2, 2, 2])
})

test('app modify uses lerp buffers when mover updates are buffered', () => {
  const pushed = {
    position: null,
    quaternion: null,
    scale: null,
  }
  const ctx = {
    data: {
      id: 'entity-2',
      mover: 'remote-user',
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      pinned: false,
      state: {},
      props: {},
    },
    buildCount: 0,
    build() {
      this.buildCount += 1
    },
    networkPos: {
      pushArray(value) {
        pushed.position = value
      },
    },
    networkQuat: {
      pushArray(value) {
        pushed.quaternion = value
      },
    },
    networkSca: {
      pushArray(value) {
        pushed.scale = value
      },
    },
  }

  App.prototype.modify.call(ctx, {
    id: 'entity-2',
    position: [4, 5, 6],
    quaternion: [0, 0, 0, 1],
    scale: [3, 3, 3],
  })

  assert.equal(ctx.buildCount, 0)
  assert.deepEqual(pushed.position, [4, 5, 6])
  assert.deepEqual(pushed.scale, [3, 3, 3])
})

test('app update tolerates mover entities before lerp buffers initialize', () => {
  const ctx = {
    data: { mover: 'remote-user' },
    world: { network: { id: 'local-user' } },
    script: null,
  }
  assert.doesNotThrow(() => {
    App.prototype.update.call(ctx, 0.016)
  })
})
