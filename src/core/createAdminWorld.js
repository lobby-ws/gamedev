import { World } from './World'

import { Client } from './systems/Client'
import { ClientPointer } from './systems/ClientPointer'
import { ClientPrefs } from './systems/ClientPrefs'
import { ClientControls } from './systems/ClientControls'
import { AdminNetwork } from './systems/AdminNetwork'
import { AdminClient } from './systems/AdminClient'
import { ClientLoader } from './systems/ClientLoader'
import { ClientGraphics } from './systems/ClientGraphics'
import { ClientEnvironment } from './systems/ClientEnvironment'
import { ClientAudio } from './systems/ClientAudio'
import { ClientStats } from './systems/ClientStats'
import { AdminBuilder } from './systems/AdminBuilder'
import { ClientActions } from './systems/ClientActions'
import { ClientTarget } from './systems/ClientTarget'
import { ClientUI } from './systems/ClientUI'
import { LODs } from './systems/LODs'
import { Nametags } from './systems/Nametags'
import { Particles } from './systems/Particles'
import { Snaps } from './systems/Snaps'
import { Wind } from './systems/Wind'
import { AdminXR } from './systems/AdminXR'
import { AdminLiveKit } from './systems/AdminLiveKit'

import { FreeCam } from './entities/FreeCam'
import { AdminLocalPlayer } from './entities/AdminLocalPlayer'

export function createAdminWorld() {
  const world = new World()
  world.isAdminClient = true

  world.register('client', Client)
  world.register('livekit', AdminLiveKit)
  world.register('pointer', ClientPointer)
  world.register('prefs', ClientPrefs)
  world.register('controls', ClientControls)
  world.register('network', AdminNetwork)
  world.register('admin', AdminClient)
  world.register('loader', ClientLoader)
  world.register('graphics', ClientGraphics)
  world.register('environment', ClientEnvironment)
  world.register('audio', ClientAudio)
  world.register('stats', ClientStats)
  world.register('builder', AdminBuilder)
  world.register('actions', ClientActions)
  world.register('target', ClientTarget)
  world.register('ui', ClientUI)
  world.register('lods', LODs)
  world.register('nametags', Nametags)
  world.register('particles', Particles)
  world.register('snaps', Snaps)
  world.register('wind', Wind)
  world.register('xr', AdminXR)

  world.adminNetwork = world.network

  const adminPlayer = new AdminLocalPlayer(world, { id: world.network.id })
  world.entities.player = adminPlayer
  world.adminPlayer = adminPlayer
  world.emit('player', adminPlayer)

  const baseInit = world.init.bind(world)
  world.init = async options => {
    await baseInit(options)
    if (!world.freeCam) {
      world.freeCam = new FreeCam(world)
    }
  }

  return world
}
