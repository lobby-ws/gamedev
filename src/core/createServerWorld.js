import { World } from './World'

import { Server } from './systems/Server'
import { ServerLiveKit } from './systems/ServerLiveKit'
import { ServerNetwork } from './systems/ServerNetwork'
import { ServerLoader } from './systems/ServerLoader'
import { ServerEnvironment } from './systems/ServerEnvironment'
import { ServerMonitor } from './systems/ServerMonitor'
import { ServerAIScripts } from './systems/ServerAIScripts'
import { ServerAI } from './systems/ServerAI'

function registerPostCoreSystems(world, postCoreSystems = []) {
  if (!Array.isArray(postCoreSystems)) return
  for (const entry of postCoreSystems) {
    const key = typeof entry?.key === 'string' && entry.key.trim() ? entry.key.trim() : null
    const System = typeof entry?.System === 'function' ? entry.System : null
    if (!key || !System) {
      throw new Error('invalid_post_core_system')
    }
    world.register(key, System)
  }
}

export function createServerWorld({ postCoreSystems = [] } = {}) {
  const world = new World()
  world.register('server', Server)
  world.register('livekit', ServerLiveKit)
  world.register('network', ServerNetwork)
  world.register('loader', ServerLoader)
  world.register('ai', ServerAI)
  world.register('aiScripts', ServerAIScripts)
  world.register('environment', ServerEnvironment)
  world.register('monitor', ServerMonitor)
  registerPostCoreSystems(world, postCoreSystems)
  return world
}
