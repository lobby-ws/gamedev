import { css } from '@firebolt-dev/css'
import { useContext, useEffect, useMemo, useState } from 'react'
import { XIcon, CircleArrowRightIcon, HammerIcon, UserXIcon, Volume2Icon, SettingsIcon, UsersIcon } from 'lucide-react'
import { FieldBtn, FieldRange, FieldSwitch, FieldText, FieldToggle } from './Fields'
import { useFullscreen } from './useFullscreen'
import { useRank } from './useRank'
import { isTouch } from '../utils'
import { Group } from './sidebar/Group'
import { cls } from './cls'
import { theme } from './theme'
import { HintContext, HintProvider } from './Hint'
import { MicIcon, MicOffIcon, VRIcon } from './Icons'
import { sortBy } from 'lodash-es'
import * as THREE from '../../core/extras/three'
import { Ranks } from '../../core/extras/ranks'
import { storage } from '../../core/storage'

const shadowOptions = [
  { label: 'None', value: 'none' },
  { label: 'Low', value: 'low' },
  { label: 'Med', value: 'med' },
  { label: 'High', value: 'high' },
]

export function MainMenu({ world, open, onClose }) {
  const player = world.entities.player
  const { isAdmin, isBuilder } = useRank(world, player)
  const [livekit, setLiveKit] = useState(() => world.livekit.status)
  useEffect(() => {
    const onLiveKitStatus = status => {
      setLiveKit({ ...status })
    }
    world.livekit.on('status', onLiveKitStatus)
    return () => {
      world.livekit.off('status', onLiveKitStatus)
    }
  }, [])
  const [name, setName] = useState(() => player.data.name)
  const [dpr, setDPR] = useState(world.prefs.dpr)
  const [shadows, setShadows] = useState(world.prefs.shadows)
  const [postprocessing, setPostprocessing] = useState(world.prefs.postprocessing)
  const [bloom, setBloom] = useState(world.prefs.bloom)
  const [ao, setAO] = useState(world.prefs.ao)
  const [music, setMusic] = useState(world.prefs.music)
  const [sfx, setSFX] = useState(world.prefs.sfx)
  const [voice, setVoice] = useState(world.prefs.voice)
  const [ui, setUI] = useState(world.prefs.ui)
  const [canFullscreen, isFullscreen, toggleFullscreen] = useFullscreen()
  const [actions, setActions] = useState(world.prefs.actions)
  const [stats, setStats] = useState(world.prefs.stats)
  const [tab, setTab] = useState('settings')
  const changeName = name => {
    if (!name) return setName(player.data.name)
    player.setName(name)
  }
  const dprOptions = useMemo(() => {
    const dpr = window.devicePixelRatio
    const options = []
    const add = (label, dpr) => {
      options.push({ label, value: dpr })
    }
    add('0.5x', 0.5)
    add('1x', 1)
    if (dpr >= 2) add('2x', 2)
    if (dpr >= 3) add('3x', dpr)
    return options
  }, [])
  useEffect(() => {
    const onPrefsChange = changes => {
      if (changes.dpr) setDPR(changes.dpr.value)
      if (changes.shadows) setShadows(changes.shadows.value)
      if (changes.postprocessing) setPostprocessing(changes.postprocessing.value)
      if (changes.bloom) setBloom(changes.bloom.value)
      if (changes.ao) setAO(changes.ao.value)
      if (changes.music) setMusic(changes.music.value)
      if (changes.sfx) setSFX(changes.sfx.value)
      if (changes.voice) setVoice(changes.voice.value)
      if (changes.ui) setUI(changes.ui.value)
      if (changes.actions) setActions(changes.actions.value)
      if (changes.stats) setStats(changes.stats.value)
    }
    world.prefs.on('change', onPrefsChange)
    return () => {
      world.prefs.off('change', onPrefsChange)
    }
  }, [])
  useEffect(() => {
    if (!open) return
    const onKeyDown = e => {
      if (e.code === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])
  if (!open) return null
  return (
    <HintProvider>
      <div
        className='mainmenu'
        css={css`
          position: absolute;
          inset: 0;
          z-index: 100;
          display: flex;
          align-items: center;
          justify-content: flex-start;
          pointer-events: auto;
          .mainmenu-backdrop {
            position: absolute;
            inset: 0;
            background: rgba(0, 0, 0, 0.6);
            backdrop-filter: blur(15px);
          }
          .mainmenu-panel {
            position: absolute;
            left: env(safe-area-inset-left);
            top: 50%;
            transform: translateY(-50%);
            width: 22rem;
            max-width: calc(100% - 2rem);
            max-height: calc(100% - 4rem);
            min-height: 30rem;
            background: ${theme.bgPanel};
            border: 1px solid ${theme.border};
            border-radius: ${theme.radius};
            display: flex;
            flex-direction: column;
            overflow: hidden;
          }
          .mainmenu-head {
            flex-shrink: 0;
            display: flex;
            flex-direction: column;
            border-bottom: 1px solid ${theme.borderLight};
          }
          .mainmenu-head-top {
            height: 3.5rem;
            padding: 0 0.75rem 0 1rem;
            display: flex;
            align-items: center;
            gap: 0.75rem;
          }
          .mainmenu-logo {
            width: 2rem;
            height: 2rem;
            object-fit: contain;
          }
          .mainmenu-head-spacer {
            flex: 1;
          }
          .mainmenu-actions {
            display: flex;
            align-items: center;
            gap: 0.25rem;
          }
          .mainmenu-action {
            width: 2rem;
            height: 2rem;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: ${theme.radiusSmall};
            color: rgba(255, 255, 255, 0.6);
            cursor: pointer;
            &:hover {
              color: white;
              background: ${theme.bgHover};
            }
            &.muted {
              color: #ff4b4b;
            }
          }
          .mainmenu-close {
            width: 2rem;
            height: 2rem;
            display: flex;
            align-items: center;
            justify-content: center;
            color: rgba(255, 255, 255, 0.6);
            cursor: pointer;
            &:hover {
              color: white;
            }
          }
          .mainmenu-tabs {
            display: flex;
            align-items: center;
            gap: 0;
            padding: 0 0.5rem;
          }
          .mainmenu-tab {
            flex: 1;
            height: 2.5rem;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.4rem;
            font-size: 0.875rem;
            color: rgba(255, 255, 255, 0.4);
            cursor: pointer;
            border-bottom: 2px solid transparent;
            &:hover {
              color: rgba(255, 255, 255, 0.8);
            }
            &.active {
              color: white;
              border-bottom-color: white;
              background: ${theme.bgHover};
            }
          }
          .mainmenu-content {
            flex: 1;
            overflow-y: auto;
            padding: 0.6rem 0;
          }
        `}
      >
        <div className='mainmenu-backdrop' onClick={onClose} />
        <div className='mainmenu-panel'>
          <div className='mainmenu-head'>
            <div className='mainmenu-head-top'>
              <img className='mainmenu-logo' src='/logo.png' />
              <div className='mainmenu-head-spacer' />
              <div className='mainmenu-actions'>
                {livekit.enabled && (
                  <div
                    className={cls('mainmenu-action', { muted: livekit.muted })}
                    onClick={() => world.livekit.toggleMuted()}
                  >
                    {livekit.muted ? <MicOffIcon size='1rem' /> : <MicIcon size='1rem' />}
                  </div>
                )}
                {world.xr.isSupported && (
                  <div className='mainmenu-action' onClick={() => world.xr.start()}>
                    <VRIcon size='1.125rem' />
                  </div>
                )}
              </div>
              <div className='mainmenu-close' onClick={onClose}>
                <XIcon size='1.125rem' />
              </div>
            </div>
            <div className='mainmenu-tabs'>
              <div className={cls('mainmenu-tab', { active: tab === 'settings' })} onClick={() => setTab('settings')}>
                <SettingsIcon size='0.875rem' />
                Settings
              </div>
              {isAdmin && (
                <div className={cls('mainmenu-tab', { active: tab === 'players' })} onClick={() => setTab('players')}>
                  <UsersIcon size='0.875rem' />
                  Players
                </div>
              )}
            </div>
          </div>
          <div className='mainmenu-content noscrollbar'>
            {tab === 'settings' && (
              <>
                <FieldText label='Name' hint='Change your name' value={name} onChange={changeName} />
                <Group label='Interface' />
                <FieldRange
                  label='Scale'
                  hint='Change the scale of the user interface'
                  min={0.5}
                  max={1.5}
                  step={0.1}
                  value={ui}
                  onChange={ui => world.prefs.setUI(ui)}
                />
                <FieldToggle
                  label='Fullscreen'
                  hint='Toggle fullscreen. Not supported in some browsers'
                  value={isFullscreen}
                  onChange={value => toggleFullscreen(value)}
                  trueLabel='Enabled'
                  falseLabel='Disabled'
                />
                {isBuilder && (
                  <FieldToggle
                    label='Build Prompts'
                    hint='Show or hide action prompts when in build mode'
                    value={actions}
                    onChange={actions => world.prefs.setActions(actions)}
                    trueLabel='Visible'
                    falseLabel='Hidden'
                  />
                )}
                <FieldToggle
                  label='Stats'
                  hint='Show or hide performance stats'
                  value={world.prefs.stats}
                  onChange={stats => world.prefs.setStats(stats)}
                  trueLabel='Visible'
                  falseLabel='Hidden'
                />
                {!isTouch && (
                  <FieldBtn
                    label='Hide Interface'
                    note='Z'
                    hint='Hide the user interface. Press Z to re-enable.'
                    onClick={() => {
                      world.ui.toggleVisible()
                      onClose()
                    }}
                  />
                )}
                <Group label='Graphics' />
                <FieldSwitch
                  label='Resolution'
                  hint='Change your display resolution'
                  options={dprOptions}
                  value={dpr}
                  onChange={dpr => world.prefs.setDPR(dpr)}
                />
                <FieldSwitch
                  label='Shadows'
                  hint='Change the quality of shadows in the world'
                  options={shadowOptions}
                  value={shadows}
                  onChange={shadows => world.prefs.setShadows(shadows)}
                />
                <FieldToggle
                  label='Post-processing'
                  hint='Enable or disable all postprocessing effects'
                  trueLabel='On'
                  falseLabel='Off'
                  value={postprocessing}
                  onChange={postprocessing => world.prefs.setPostprocessing(postprocessing)}
                />
                <FieldToggle
                  label='Bloom'
                  hint='Enable or disable the bloom effect'
                  trueLabel='On'
                  falseLabel='Off'
                  value={bloom}
                  onChange={bloom => world.prefs.setBloom(bloom)}
                />
                {world.settings.ao && (
                  <FieldToggle
                    label='Ambient Occlusion'
                    hint='Enable or disable the ambient occlusion effect'
                    trueLabel='On'
                    falseLabel='Off'
                    value={ao}
                    onChange={ao => world.prefs.setAO(ao)}
                  />
                )}
                <Group label='Audio' />
                <FieldRange
                  label='Music'
                  hint='Adjust general music volume'
                  min={0}
                  max={2}
                  step={0.05}
                  value={music}
                  onChange={music => world.prefs.setMusic(music)}
                />
                <FieldRange
                  label='SFX'
                  hint='Adjust sound effects volume'
                  min={0}
                  max={2}
                  step={0.05}
                  value={sfx}
                  onChange={sfx => world.prefs.setSFX(sfx)}
                />
                <FieldRange
                  label='Voice'
                  hint='Adjust global voice chat volume'
                  min={0}
                  max={2}
                  step={0.05}
                  value={voice}
                  onChange={voice => world.prefs.setVoice(voice)}
                />
              </>
            )}
            {tab === 'players' && isAdmin && <PlayersSection world={world} />}
          </div>
        </div>
      </div>
    </HintProvider>
  )
}

function getPlayers(world) {
  let players = []
  world.entities.players.forEach(player => {
    players.push(player)
  })
  players = sortBy(players, player => player.enteredAt)
  return players
}

function PlayersSection({ world }) {
  const { setHint } = useContext(HintContext)
  const localPlayer = world.entities.player
  const isAdmin = localPlayer.isAdmin()
  const [players, setPlayers] = useState(() => getPlayers(world))
  const [livePlayers, setLivePlayers] = useState(() => storage.get('admin-live', false))
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
  useEffect(() => {
    if (!world.isAdminClient || !world.network?.setSubscriptions) return
    world.network.setSubscriptions({ snapshot: true, players: livePlayers, runtime: false })
    storage.set('admin-live', livePlayers)
  }, [livePlayers])
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
    <div
      className='mainmenu-players'
      css={css`
        .mainmenu-players-head {
          display: flex;
          align-items: center;
          padding: 0 1rem;
          height: 2rem;
        }
        .mainmenu-players-live {
          height: 1.75rem;
          padding: 0 0.625rem;
          border-radius: ${theme.radiusSmall};
          border: 1px solid rgba(255, 255, 255, 0.15);
          background: transparent;
          color: rgba(255, 255, 255, 0.7);
          font-size: 0.75rem;
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
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
        .mainmenu-players-live-dot {
          width: 0.35rem;
          height: 0.35rem;
          border-radius: ${theme.radiusSmall};
          background: rgba(255, 255, 255, 0.35);
        }
        .mainmenu-players-live.active .mainmenu-players-live-dot {
          background: #4088ff;
        }
        .mainmenu-players-item {
          display: flex;
          align-items: center;
          padding: 0.1rem 0.5rem 0.1rem 1rem;
          height: 2.25rem;
        }
        .mainmenu-players-name {
          flex: 1;
          display: flex;
          align-items: center;
          font-size: 0.9375rem;
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
        .mainmenu-players-btn {
          width: 1.75rem;
          height: 1.75rem;
          display: flex;
          align-items: center;
          justify-content: center;
          color: rgba(255, 255, 255, 0.8);
          &:hover {
            cursor: pointer;
            color: white;
          }
          &.dim {
            color: #556181;
          }
        }
      `}
    >
      {canToggleLive && (
        <div className='mainmenu-players-head'>
          <button
            type='button'
            className={cls('mainmenu-players-live', { active: livePlayers })}
            onClick={() => setLivePlayers(!livePlayers)}
            onPointerEnter={() => setHint('Toggle live player overlays')}
            onPointerLeave={() => setHint(null)}
          >
            <span className='mainmenu-players-live-dot' />
            {livePlayers ? 'Live' : 'Live Off'}
          </button>
        </div>
      )}
      {players.map(player => (
        <div className='mainmenu-players-item' key={player.data.id}>
          <div className='mainmenu-players-name'>
            <span>{player.data.name}</span>
            {player.speaking && <Volume2Icon size='0.875rem' />}
            {player.isMuted() && <MicOffIcon size='0.875rem' />}
          </div>
          {isAdmin && player.isRemote && !player.isAdmin() && world.settings.rank < Ranks.BUILDER && (
            <div
              className={cls('mainmenu-players-btn', { dim: !player.isBuilder() })}
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
              <HammerIcon size='1rem' />
            </div>
          )}
          {player.isRemote && localPlayer.outranks(player) && (
            <div
              className='mainmenu-players-btn'
              onPointerEnter={() => setHint('Teleport to player.')}
              onPointerLeave={() => setHint(null)}
              onClick={() => teleportTo(player)}
            >
              <CircleArrowRightIcon size='1rem' />
            </div>
          )}
          {player.isRemote && localPlayer.outranks(player) && (
            <div
              className='mainmenu-players-btn'
              onPointerEnter={() =>
                setHint(player.isMuted() ? 'Player is muted. Click to unmute.' : 'Player is not muted. Click to mute.')
              }
              onPointerLeave={() => setHint(null)}
              onClick={() => toggleMute(player)}
            >
              {player.isMuted() ? <MicOffIcon size='1rem' /> : <MicIcon size='1rem' />}
            </div>
          )}
          {player.isRemote && localPlayer.outranks(player) && (
            <div
              className='mainmenu-players-btn'
              onPointerEnter={() => setHint('Kick this player.')}
              onPointerLeave={() => setHint(null)}
              onClick={() => kick(player)}
            >
              <UserXIcon size='1rem' />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
