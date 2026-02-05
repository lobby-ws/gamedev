import { css } from '@firebolt-dev/css'
import { useContext, useEffect, useState } from 'react'
import {
  CircleArrowRightIcon,
  HammerIcon,
  UserXIcon,
  Volume2Icon,
} from 'lucide-react'
import { MicIcon, MicOffIcon } from '../Icons'
import { cls } from '../cls'
import { HintContext } from '../Hint'
import { sortBy } from 'lodash-es'
import * as THREE from '../../../core/extras/three'
import { Ranks } from '../../../core/extras/ranks'
import { Pane } from './Pane'

function getPlayers(world) {
  let players = []
  world.entities.players.forEach(player => {
    players.push(player)
  })
  players = sortBy(players, player => player.enteredAt)
  return players
}

export function Players({ world, hidden, livePlayers, setLivePlayers }) {
  const { setHint } = useContext(HintContext)
  const localPlayer = world.entities.player
  const isAdmin = localPlayer.isAdmin()
  const [players, setPlayers] = useState(() => getPlayers(world))
  const canToggleLive = !!world.isAdminClient
  useEffect(() => {
    const onChange = () => {
      setPlayers(getPlayers(world))
    }
    world.entities.on('added', onChange)
    world.entities.on('removed', onChange)
    world.livekit.on('speaking', onChange)
    world.livekit.on('muted', onChange)
    world.on('rank', onChange)
    world.on('name', onChange)
    return () => {
      world.entities.off('added', onChange)
      world.entities.off('removed', onChange)
      world.livekit.off('speaking', onChange)
      world.livekit.off('muted', onChange)
      world.off('rank', onChange)
      world.off('name', onChange)
    }
  }, [])
  const toggleBuilder = player => {
    if (player.data.rank === Ranks.BUILDER) {
      world.admin.modifyRank(player.data.id, Ranks.VISITOR)
    } else {
      world.admin.modifyRank(player.data.id, Ranks.BUILDER)
    }
  }
  const toggleMute = player => {
    world.admin.mute(player.data.id, !player.isMuted())
  }
  const kick = player => {
    world.admin.kick(player.data.id)
  }
  const teleportTo = player => {
    const position = new THREE.Vector3(0, 0, 1)
    position.applyQuaternion(player.base.quaternion)
    position.multiplyScalar(0.6).add(player.base.position)
    localPlayer.teleport({
      position,
      rotationY: player.base.rotation.y,
    })
  }
  return (
    <Pane hidden={hidden}>
      <div
        className='players'
        css={css`
          background: rgba(11, 10, 21, 0.9);
          border: 1px solid rgba(255, 255, 255, 0.05);
          border-radius: 1.375rem;
          display: flex;
          flex-direction: column;
          min-height: 1rem;
          .players-head {
            height: 3.125rem;
            padding: 0 1rem;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            display: flex;
            align-items: center;
            gap: 0.75rem;
          }
          .players-title {
            flex: 1;
            font-weight: 500;
            font-size: 1rem;
            line-height: 1;
            white-space: nowrap;
            text-overflow: ellipsis;
            overflow: hidden;
          }
          .players-live {
            height: 2rem;
            padding: 0 0.75rem;
            border-radius: 999px;
            border: 1px solid rgba(255, 255, 255, 0.15);
            background: transparent;
            color: rgba(255, 255, 255, 0.7);
            font-size: 0.8rem;
            display: inline-flex;
            align-items: center;
            gap: 0.4rem;
            white-space: nowrap;
            &:hover {
              cursor: pointer;
              border-color: rgba(255, 255, 255, 0.3);
              color: white;
            }
            &.active {
              border-color: rgba(64, 136, 255, 0.7);
              color: white;
            }
          }
          .players-live-dot {
            width: 0.4rem;
            height: 0.4rem;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.35);
          }
          .players-live.active .players-live-dot {
            background: #4088ff;
          }
          .players-content {
            flex: 1;
            overflow-y: auto;
            padding: 0.5rem 0;
          }
          .players-item {
            display: flex;
            align-items: center;
            padding: 0.1rem 0.5rem 0.1rem 1rem;
            height: 36px;
          }
          .players-name {
            flex: 1;
            display: flex;
            align-items: center;
            span {
              white-space: nowrap;
              text-overflow: ellipsis;
              overflow: hidden;
              margin-right: 0.5rem;
            }
            svg {
              color: rgba(255, 255, 255, 0.6);
            }
          }
          .players-btn {
            width: 2rem;
            height: 2rem;
            display: flex;
            align-items: center;
            justify-content: center;
            color: rgba(255, 255, 255, 0.8);
            &:hover:not(.readonly) {
              cursor: pointer;
              color: white;
            }
            &.dim {
              color: #556181;
            }
          }
        `}
      >
        <div className='players-head'>
          <div className='players-title'>Players</div>
          {canToggleLive && (
            <button
              type='button'
              className={cls('players-live', { active: livePlayers })}
              onClick={() => setLivePlayers(!livePlayers)}
              onPointerEnter={() => setHint('Toggle live player overlays')}
              onPointerLeave={() => setHint(null)}
            >
              <span className='players-live-dot' />
              {livePlayers ? 'Live' : 'Live Off'}
            </button>
          )}
        </div>
        <div className='players-content noscrollbar'>
          {players.map(player => (
            <div className='players-item' key={player.data.id}>
              <div className='players-name'>
                <span>{player.data.name}</span>
                {player.speaking && <Volume2Icon size='1rem' />}
                {player.isMuted() && <MicOffIcon size='1rem' />}
              </div>
              {isAdmin && player.isRemote && !player.isAdmin() && world.settings.rank < Ranks.BUILDER && (
                <div
                  className={cls('players-btn', { dim: !player.isBuilder() })}
                  onPointerEnter={() =>
                    setHint(
                      player.isBuilder()
                        ? 'Player is not a builder. Click to allow building.'
                        : 'Player is a builder. Click to revoke.'
                    )
                  }
                  onPointerLeave={() => setHint(null)}
                  onClick={() => toggleBuilder(player)}
                >
                  <HammerIcon size='1.125rem' />
                </div>
              )}
              {player.isRemote && localPlayer.outranks(player) && (
                <div
                  className='players-btn'
                  onPointerEnter={() => setHint('Teleport to player.')}
                  onPointerLeave={() => setHint(null)}
                  onClick={() => teleportTo(player)}
                >
                  <CircleArrowRightIcon size='1.125rem' />
                </div>
              )}
              {player.isRemote && localPlayer.outranks(player) && (
                <div
                  className='players-btn'
                  onPointerEnter={() =>
                    setHint(
                      player.isMuted() ? 'Player is muted. Click to unmute.' : 'Player is not muted. Click to mute.'
                    )
                  }
                  onPointerLeave={() => setHint(null)}
                  onClick={() => toggleMute(player)}
                >
                  {player.isMuted() ? <MicOffIcon size='1.125rem' /> : <MicIcon size='1.125rem' />}
                </div>
              )}
              {player.isRemote && localPlayer.outranks(player) && (
                <div
                  className='players-btn'
                  onPointerEnter={() => setHint('Kick this player.')}
                  onPointerLeave={() => setHint(null)}
                  onClick={() => kick(player)}
                >
                  <UserXIcon size='1.125rem' />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </Pane>
  )
}
