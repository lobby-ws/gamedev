import { css } from '@firebolt-dev/css'
import { MenuIcon, MicIcon, MicOffIcon, VRIcon } from './Icons'
import {
  BookTextIcon,
  BoxIcon,
  ChevronDownIcon,
  ChevronsUpDownIcon,
  CirclePlusIcon,
  CodeIcon,
  DownloadIcon,
  EarthIcon,
  UsersIcon,
  InfoIcon,
  LayersIcon,
  ListTreeIcon,
  LoaderPinwheelIcon,
  MessageSquareTextIcon,
  Move3DIcon,
  OctagonXIcon,
  PinIcon,
  RocketIcon,
  RotateCcwIcon,
  SearchIcon,
  SparkleIcon,
  SquareCheckBigIcon,
  SquareIcon,
  SquareMenuIcon,
  TagIcon,
  Trash2Icon,
  UserXIcon,
  ShieldBanIcon,
  Volume2Icon,
  HammerIcon,
  CircleArrowRightIcon,
} from 'lucide-react'
import { cls } from './cls'
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  FieldBtn,
  FieldCurve,
  FieldFile,
  FieldNumber,
  FieldRange,
  FieldSwitch,
  FieldText,
  FieldTextarea,
  FieldToggle,
  FieldVec3,
  FieldColor,
} from './Fields'
import { HintContext, HintProvider } from './Hint'
import { useFullscreen } from './useFullscreen'
import { downloadFile } from '../../core/extras/downloadFile'
import { exportApp } from '../../core/extras/appTools'
import { hashFile } from '../../core/utils-client'
import { areBlueprintsTwinUnique, buildScriptGroups, getScriptGroupMain } from '../../core/extras/blueprintGroups'
import { cloneDeep, isArray, isBoolean, isEqual, merge, sortBy } from 'lodash-es'
import { storage } from '../../core/storage'
import { ScriptEditor } from './ScriptEditor'
import { ScriptFilesEditor } from './ScriptFilesEditor'
import { NodeHierarchy } from './NodeHierarchy'
import { AppsList } from './AppsList'
import { DEG2RAD, RAD2DEG } from '../../core/extras/general'
import * as THREE from '../../core/extras/three'
import { isTouch } from '../utils'
import { uuid } from '../../core/utils'
import { useRank } from './useRank'
import { Ranks } from '../../core/extras/ranks'

const mainSectionPanes = ['prefs']
const worldSectionPanes = ['world', 'docs', 'apps', 'add']
const appSectionPanes = ['app', 'script', 'nodes', 'meta']

const e1 = new THREE.Euler(0, 0, 0, 'YXZ')
const q1 = new THREE.Quaternion()

/**
 * frosted
 * 
background: rgba(11, 10, 21, 0.85); 
border: 0.0625rem solid #2a2b39;
backdrop-filter: blur(5px);
 *
 */

export function Sidebar({ world, ui }) {
  const player = world.entities.player
  const { isAdmin, isBuilder } = useRank(world, player)
  const [livePlayers, setLivePlayers] = useState(() => storage.get('admin-live', false))
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
  useEffect(() => {
    if (!world.isAdminClient || !world.network?.setSubscriptions) return
    world.network.setSubscriptions({ snapshot: true, players: livePlayers, runtime: false })
    storage.set('admin-live', livePlayers)
  }, [livePlayers])
  const activePane = ui.active ? ui.pane : null
  const downloadApp = async () => {
    const app = ui.app
    if (!app?.blueprint) return
    try {
      const file = await exportApp(app.blueprint, world.loader.loadFile, id => world.blueprints.get(id))
      downloadFile(file)
    } catch (err) {
      console.error(err)
      world.emit('toast', 'Export failed')
    }
  }
  return (
    <HintProvider>
      <div
        className='sidebar'
        css={css`
          position: absolute;
          font-size: 1rem;
          top: calc(2rem + env(safe-area-inset-top));
          right: calc(2rem + env(safe-area-inset-right));
          bottom: calc(2rem + env(safe-area-inset-bottom));
          left: calc(2rem + env(safe-area-inset-left));
          display: flex;
          gap: 0.625rem;
          z-index: 1; // above chat etc
          @media all and (max-width: 1200px) {
            top: calc(1rem + env(safe-area-inset-top));
            right: calc(1rem + env(safe-area-inset-right));
            bottom: calc(1rem + env(safe-area-inset-bottom));
            left: calc(1rem + env(safe-area-inset-left));
          }
          .sidebar-sections {
            display: flex;
            flex-direction: column;
            flex-shrink: 0;
            gap: 0.625rem;
          }
        `}
      >
        <div className='sidebar-sections'>
          <Section active={activePane} bottom>
            <Btn
              active={activePane === 'prefs'}
              suspended={ui.pane === 'prefs' && !activePane}
              onClick={() => world.ui.togglePane('prefs')}
            >
              <MenuIcon size='1.25rem' />
            </Btn>
            <Btn
              active={activePane === 'players'}
              suspended={ui.pane === 'players' && !activePane}
              onClick={() => world.ui.togglePane('players')}
            >
              <UsersIcon size='1.25rem' />
            </Btn>
            {isTouch && (
              <Btn
                onClick={() => {
                  world.emit('sidebar-chat-toggle')
                }}
              >
                <MessageSquareTextIcon size='1.25rem' />
              </Btn>
            )}
            {livekit.available && !livekit.connected && (
              <Btn disabled>
                <MicOffIcon size='1.25rem' />
              </Btn>
            )}
            {livekit.available && livekit.connected && (
              <Btn
                muted={livekit.mic && (livekit.level === 'disabled' || livekit.muted)}
                onClick={() => {
                  world.livekit.setMicrophoneEnabled()
                }}
              >
                {livekit.mic && livekit.level !== 'disabled' && !livekit.muted ? (
                  <MicIcon size='1.25rem' />
                ) : (
                  <MicOffIcon size='1.25rem' />
                )}
              </Btn>
            )}
            {world.xr.supportsVR && (
              <Btn
                onClick={() => {
                  world.xr.enter()
                }}
              >
                <VRIcon size='1.25rem' />
              </Btn>
            )}
          </Section>
          {isBuilder && (
            <Section active={activePane} top bottom>
              <Btn
                active={activePane === 'world'}
                suspended={ui.pane === 'world' && !activePane}
                onClick={() => world.ui.togglePane('world')}
              >
                <EarthIcon size='1.25rem' />
              </Btn>
              {/* <Btn
              active={activePane === 'docs'}
              suspended={ui.pane === 'docs' && !activePane}
              onClick={() => world.ui.togglePane('docs')}
            >
              <BookTextIcon size='1.25rem' />
            </Btn> */}
              <Btn
                active={activePane === 'apps'}
                suspended={ui.pane === 'apps' && !activePane}
                onClick={() => world.ui.togglePane('apps')}
              >
                <LayersIcon size='1.25rem' />
              </Btn>
              <Btn
                active={activePane === 'add'}
                suspended={ui.pane === 'add' && !activePane}
                onClick={() => world.ui.togglePane('add')}
              >
                <CirclePlusIcon size='1.25rem' />
              </Btn>
            </Section>
          )}
          {ui.app && (
            <Section active={activePane} top bottom>
              <Btn
                active={activePane === 'app'}
                suspended={ui.pane === 'app' && !activePane}
                onClick={() => world.ui.togglePane('app')}
              >
                <SquareMenuIcon size='1.25rem' />
              </Btn>
              <Btn
                active={activePane === 'script'}
                suspended={ui.pane === 'script' && !activePane}
                onClick={() => world.ui.togglePane('script')}
              >
                <CodeIcon size='1.25rem' />
              </Btn>
              <Btn
                active={activePane === 'nodes'}
                suspended={ui.pane === 'nodes' && !activePane}
                onClick={() => world.ui.togglePane('nodes')}
              >
                <ListTreeIcon size='1.25rem' />
              </Btn>
              <Btn
                active={activePane === 'meta'}
                suspended={ui.pane === 'meta' && !activePane}
                onClick={() => world.ui.togglePane('meta')}
              >
                <TagIcon size='1.25rem' />
              </Btn>
              <Btn onClick={downloadApp}>
                <DownloadIcon size='1.25rem' />
              </Btn>
            </Section>
          )}
        </div>
        {ui.pane === 'prefs' && <Prefs world={world} hidden={!ui.active} />}
        {ui.pane === 'world' && <World world={world} hidden={!ui.active} />}
        {ui.pane === 'apps' && <Apps world={world} hidden={!ui.active} />}
        {ui.pane === 'add' && <Add world={world} hidden={!ui.active} />}
        {ui.pane === 'app' && <App key={ui.app.data.id} world={world} hidden={!ui.active} />}
        {ui.pane === 'script' && <Script key={ui.app.data.id} world={world} hidden={!ui.active} />}
        {ui.pane === 'nodes' && <Nodes key={ui.app.data.id} world={world} hidden={!ui.active} />}
        {ui.pane === 'meta' && <Meta key={ui.app.data.id} world={world} hidden={!ui.active} />}
        {ui.pane === 'players' && (
          <Players world={world} hidden={!ui.active} livePlayers={livePlayers} setLivePlayers={setLivePlayers} />
        )}
      </div>
    </HintProvider>
  )
}

function Section({ active, top, bottom, children }) {
  return (
    <div
      className={cls('sidebar-section', { active, top, bottom })}
      css={css`
        background: rgba(11, 10, 21, 0.2);
        border: 1px solid rgba(255, 255, 255, 0.05);
        border-radius: 2rem;
        padding: 0.6875rem 0;
        pointer-events: auto;
        position: relative;
        &.active {
          background: rgba(11, 10, 21, 0.9);
        }
      `}
    >
      {children}
    </div>
  )
}

function Btn({ disabled, suspended, active, muted, children, ...props }) {
  return (
    <div
      className={cls('sidebar-btn', { disabled, suspended, active, muted })}
      css={css`
        width: 2.75rem;
        height: 1.875rem;
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        position: relative;
        .sidebar-btn-dot {
          display: none;
          position: absolute;
          top: 0.8rem;
          right: 0.2rem;
          width: 0.3rem;
          height: 0.3rem;
          border-radius: 0.15rem;
          background: white;
        }
        &:hover {
          cursor: pointer;
          color: white;
        }
        &.active {
          color: white;
          .sidebar-btn-dot {
            display: block;
          }
        }
        &.suspended {
          .sidebar-btn-dot {
            display: block;
            /* background: rgb(26, 151, 241); */
          }
        }
        &.disabled {
          color: rgba(255, 255, 255, 0.3);
        }
        &.muted {
          color: #ff4b4b;
        }
      `}
      {...props}
    >
      {children}
      <div className='sidebar-btn-dot' />
    </div>
  )
}

function Content({ width = '20rem', hidden, children }) {
  return (
    <div
      className={cls('sidebar-content', { hidden })}
      css={css`
        width: ${width};
        pointer-events: auto;
        .sidebar-content-main {
          background: rgba(11, 10, 21, 0.85);
          border: 0.0625rem solid #2a2b39;
          backdrop-filter: blur(5px);
          border-radius: 1rem;
          display: flex;
          align-items: stretch;
        }
        &.hidden {
          opacity: 0;
          pointer-events: none;
        }
      `}
    >
      <div className='sidebar-content-main'>{children}</div>
      <Hint />
    </div>
  )
}

function Pane({ width = '20rem', hidden, children }) {
  return (
    <div
      className={cls('sidebarpane', { hidden })}
      css={css`
        width: ${width};
        max-width: 100%;
        display: flex;
        flex-direction: column;
        .sidebarpane-content {
          pointer-events: auto;
          max-height: 100%;
          display: flex;
          flex-direction: column;
        }
        &.hidden {
          opacity: 0;
          pointer-events: none;
        }
      `}
    >
      <div className='sidebarpane-content'>{children}</div>
      <Hint />
    </div>
  )
}

function Hint() {
  const { hint } = useContext(HintContext)
  if (!hint) return null
  return (
    <div
      className='hint'
      css={css`
        margin-top: 0.25rem;
        background: rgba(11, 10, 21, 0.85);
        border: 0.0625rem solid #2a2b39;
        backdrop-filter: blur(5px);
        border-radius: 1rem;
        min-width: 0;
        padding: 1rem;
        font-size: 0.9375rem;
      `}
    >
      <span>{hint}</span>
    </div>
  )
}

function Group({ label }) {
  return (
    <>
      <div
        css={css`
          height: 0.0625rem;
          background: rgba(255, 255, 255, 0.05);
          margin: 0.6rem 0;
        `}
      />
      {label && (
        <div
          css={css`
            font-weight: 500;
            line-height: 1;
            padding: 0.75rem 0 0.75rem 1rem;
            margin-top: -0.6rem;
          `}
        >
          {label}
        </div>
      )}
    </>
  )
}

const shadowOptions = [
  { label: 'None', value: 'none' },
  { label: 'Low', value: 'low' },
  { label: 'Med', value: 'med' },
  { label: 'High', value: 'high' },
]
function Prefs({ world, hidden }) {
  const player = world.entities.player
  const { isAdmin, isBuilder } = useRank(world, player)
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
  const changeName = name => {
    if (!name) return setName(player.data.name)
    player.setName(name)
  }
  const dprOptions = useMemo(() => {
    const width = world.graphics.width
    const height = world.graphics.height
    const dpr = window.devicePixelRatio
    const options = []
    const add = (label, dpr) => {
      options.push({
        // label: `${Math.round(width * dpr)} x ${Math.round(height * dpr)}`,
        label,
        value: dpr,
      })
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
  return (
    <Pane hidden={hidden}>
      <div
        className='prefs noscrollbar'
        css={css`
          overflow-y: auto;
          background: rgba(11, 10, 21, 0.9);
          border: 1px solid rgba(255, 255, 255, 0.05);
          border-radius: 1.375rem;
          padding: 0.6rem 0;
        `}
      >
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
            onClick={() => world.ui.toggleVisible()}
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
      </div>
    </Pane>
  )
}

const voiceChatOptions = [
  { label: 'Disabled', value: 'disabled' },
  { label: 'Spatial', value: 'spatial' },
  { label: 'Global', value: 'global' },
]
const rankOptions = [
  { label: 'Admins', value: 2 },
  { label: 'Builders', value: 1 },
  { label: 'Visitors', value: 0 },
]
function World({ world, hidden }) {
  const player = world.entities.player
  const { isAdmin } = useRank(world, player)
  const [title, setTitle] = useState(world.settings.title)
  const [desc, setDesc] = useState(world.settings.desc)
  const [image, setImage] = useState(world.settings.image)
  const [avatar, setAvatar] = useState(world.settings.avatar)
  const [customAvatars, setCustomAvatars] = useState(world.settings.customAvatars)
  const [voice, setVoice] = useState(world.settings.voice)
  const [playerLimit, setPlayerLimit] = useState(world.settings.playerLimit)
  const [ao, setAO] = useState(world.settings.ao)
  const [rank, setRank] = useState(world.settings.rank)
  useEffect(() => {
    const onChange = changes => {
      if (changes.title) setTitle(changes.title.value)
      if (changes.desc) setDesc(changes.desc.value)
      if (changes.image) setImage(changes.image.value)
      if (changes.avatar) setAvatar(changes.avatar.value)
      if (changes.customAvatars) setCustomAvatars(changes.customAvatars.value)
      if (changes.voice) setVoice(changes.voice.value)
      if (changes.playerLimit) setPlayerLimit(changes.playerLimit.value)
      if (changes.ao) setAO(changes.ao.value)
      if (changes.rank) setRank(changes.rank.value)
    }
    world.settings.on('change', onChange)
    return () => {
      world.settings.off('change', onChange)
    }
  }, [])
  return (
    <Pane hidden={hidden}>
      <div
        className='world'
        css={css`
          background: rgba(11, 10, 21, 0.9);
          border: 1px solid rgba(255, 255, 255, 0.05);
          border-radius: 1.375rem;
          display: flex;
          flex-direction: column;
          min-height: 12rem;
          .world-head {
            height: 3.125rem;
            padding: 0 1rem;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            display: flex;
            align-items: center;
          }
          .world-title {
            font-weight: 500;
            font-size: 1rem;
            line-height: 1;
          }
          .world-content {
            flex: 1;
            padding: 0.5rem 0;
            overflow-y: auto;
          }
        `}
      >
        <div className='world-head'>
          <div className='world-title'>World</div>
        </div>
        <div className='world-content noscrollbar'>
          <FieldText
            label='Title'
            hint='Change the title of this world. Shown in the browser tab and when sharing links'
            placeholder='World'
            value={title}
            onChange={value => world.settings.set('title', value, true)}
          />
          <FieldText
            label='Description'
            hint='Change the description of this world. Shown in previews when sharing links to this world'
            value={desc}
            onChange={value => world.settings.set('desc', value, true)}
          />
          <FieldFile
            label='Image'
            hint='Change the image of the world. This is shown when loading into or sharing links to this world.'
            kind='image'
            value={image}
            onChange={value => world.settings.set('image', value, true)}
            world={world}
          />
          <FieldFile
            label='Default Avatar'
            hint='Change the default avatar everyone spawns into the world with'
            kind='avatar'
            value={avatar}
            onChange={value => world.settings.set('avatar', value, true)}
            world={world}
          />
          {isAdmin && world.settings.hasAdminCode && (
            <FieldToggle
              label='Custom Avatars'
              hint='Allow visitors to drag and drop custom VRM avatars.'
              trueLabel='On'
              falseLabel='Off'
              value={customAvatars}
              onChange={value => world.settings.set('customAvatars', value, true)}
            />
          )}
          <FieldSwitch
            label='Voice Chat'
            hint='Set the base voice chat mode. Apps are able to modify this using custom rules.'
            options={voiceChatOptions}
            value={voice}
            onChange={voice => world.settings.set('voice', voice, true)}
          />
          <FieldNumber
            label='Player Limit'
            hint='Set a maximum number of players that can be in the world at one time. Zero means unlimited.'
            value={playerLimit}
            onChange={value => world.settings.set('playerLimit', value, true)}
          />
          <FieldToggle
            label='Ambient Occlusion'
            hint={`Improves visuals by approximating darkened corners etc. When enabled, users also have an option to disable this on their device for performance.`}
            trueLabel='On'
            falseLabel='Off'
            value={ao}
            onChange={value => world.settings.set('ao', value, true)}
          />
          {isAdmin && world.settings.hasAdminCode && (
            <FieldToggle
              label='Free Build'
              hint='Allow everyone to build (and destroy) things in the world.'
              trueLabel='On'
              falseLabel='Off'
              value={rank >= Ranks.BUILDER}
              onChange={value => world.settings.set('rank', value ? Ranks.BUILDER : Ranks.VISITOR, true)}
            />
          )}
          {/* <FieldBtn
          label='Set Spawn'
          hint='Sets the location players spawn to the location you are currently standing'
          onClick={() => {
            world.network.send('spawnModified', 'set')
          }}
        /> */}
          {/* <FieldBtn
          label='Clear Spawn'
          hint='Resets the spawn point to origin'
          onClick={() => {
            world.network.send('spawnModified', 'clear')
          }}
        /> */}
        </div>
      </div>
    </Pane>
  )
}

const appsState = {
  query: '',
  perf: false,
  scrollTop: 0,
}
function Apps({ world, hidden }) {
  const contentRef = useRef()
  const [query, setQuery] = useState(appsState.query)
  const [perf, setPerf] = useState(appsState.perf)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    contentRef.current.scrollTop = appsState.scrollTop
  }, [])
  useEffect(() => {
    appsState.query = query
    appsState.perf = perf
  }, [query, perf])
  return (
    <Pane width={perf ? '40rem' : '20rem'} hidden={hidden}>
      <div
        className='apps'
        css={css`
          background: rgba(11, 10, 21, 0.9);
          border: 1px solid rgba(255, 255, 255, 0.05);
          border-radius: 1.375rem;
          flex: 1;
          display: flex;
          flex-direction: column;
          min-height: 17rem;
          position: relative;
          .apps-head {
            height: 3.125rem;
            padding: 0 0.6rem 0 1rem;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            display: flex;
            align-items: center;
          }
          .apps-title {
            flex: 1;
            font-weight: 500;
            font-size: 1rem;
            line-height: 1;
          }
          .apps-search {
            display: flex;
            align-items: center;
            input {
              margin-left: 0.5rem;
              width: 5rem;
              font-size: 0.9375rem;
              &::placeholder {
                color: #5d6077;
              }
              &::selection {
                background-color: white;
                color: rgba(0, 0, 0, 0.8);
              }
            }
          }
          .apps-toggle {
            width: 2rem;
            height: 2rem;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 0 0 1rem;
            color: #5d6077;
            &:hover {
              cursor: pointer;
            }
            &.active {
              color: white;
            }
          }
          .apps-content {
            flex: 1;
            overflow-y: auto;
          }
        `}
      >
        <div className='apps-head'>
          <div className='apps-title'>Apps</div>
          <label className='apps-search'>
            <SearchIcon size='1.125rem' />
            <input type='text' placeholder='Search' value={query} onChange={e => setQuery(e.target.value)} />
          </label>
          <div className={cls('apps-toggle', { active: perf })} onClick={() => setPerf(!perf)}>
            <RocketIcon size='1.125rem' />
          </div>
        </div>
        <div
          ref={contentRef}
          className='apps-content noscrollbar'
          onScroll={e => {
            appsState.scrollTop = contentRef.current.scrollTop
          }}
        >
          <AppsList world={world} query={query} perf={perf} refresh={refresh} setRefresh={setRefresh} />
        </div>
      </div>
    </Pane>
  )
}

function Add({ world, hidden }) {
  const span = 4
  const gap = '0.5rem'
  const [trashMode, setTrashMode] = useState(false)
  const [tab, setTab] = useState('templates')
  const [createOpen, setCreateOpen] = useState(false)
  const [createPrompt, setCreatePrompt] = useState('')
  const [createError, setCreateError] = useState(null)
  const [creating, setCreating] = useState(false)
  const [createAttachments, setCreateAttachments] = useState([])
  const [createDocsIndex, setCreateDocsIndex] = useState([])
  const [createMention, setCreateMention] = useState(null)
  const [createScriptRoot, setCreateScriptRoot] = useState(null)
  const createPromptRef = useRef(null)
  const buildTemplates = () => {
    const items = Array.from(world.blueprints.items.values()).filter(bp => !bp.scene)
    const groups = buildScriptGroups(world.blueprints.items)
    const mainIds = new Set()
    for (const group of groups.groups.values()) {
      if (group?.main?.id) mainIds.add(group.main.id)
    }
    const mainsOnly = items.filter(bp => {
      const scriptKey = typeof bp.script === 'string' ? bp.script.trim() : ''
      if (!scriptKey) return true
      return mainIds.has(bp.id)
    })
    return sortBy(mainsOnly, bp => (bp.name || bp.id || '').toLowerCase())
  }
  const buildOrphans = () => {
    const used = new Set()
    for (const entity of world.entities.items.values()) {
      if (entity?.isApp) {
        used.add(entity.data.blueprint)
      }
    }
    const items = Array.from(world.blueprints.items.values()).filter(
      bp => !bp.scene && !used.has(bp.id) && bp.keep !== true
    )
    return sortBy(items, bp => (bp.name || bp.id || '').toLowerCase())
  }
  const [templates, setTemplates] = useState(() => buildTemplates())
  const [orphans, setOrphans] = useState(() => buildOrphans())
  const [cleaning, setCleaning] = useState(false)

  useEffect(() => {
    const refresh = () => {
      setTemplates(buildTemplates())
      setOrphans(buildOrphans())
    }
    world.blueprints.on('add', refresh)
    world.blueprints.on('modify', refresh)
    world.blueprints.on('remove', refresh)
    world.entities.on('added', refresh)
    world.entities.on('removed', refresh)
    return () => {
      world.blueprints.off('add', refresh)
      world.blueprints.off('modify', refresh)
      world.blueprints.off('remove', refresh)
      world.entities.off('added', refresh)
      world.entities.off('removed', refresh)
    }
  }, [])

  useEffect(() => {
    if (hidden) {
      setCreateOpen(false)
      setCreating(false)
      setCreateError(null)
      setCreatePrompt('')
      setCreateAttachments([])
      setCreateMention(null)
      setCreateScriptRoot(null)
    }
  }, [hidden])

  useEffect(() => {
    if (!createOpen) return
    const handle = setTimeout(() => {
      createPromptRef.current?.focus()
    }, 0)
    return () => clearTimeout(handle)
  }, [createOpen])

  useEffect(() => {
    if (createOpen) return
    setCreateError(null)
    setCreatePrompt('')
    setCreateAttachments([])
    setCreateMention(null)
    setCreateScriptRoot(null)
  }, [createOpen])

  useEffect(() => {
    if (!createOpen) return
    const refresh = () => {
      const app = world.ui?.state?.app
      const blueprint = app?.blueprint || world.blueprints.get(app?.data?.blueprint)
      setCreateScriptRoot(resolveScriptRootBlueprint(blueprint, world))
    }
    refresh()
    world.on('ui', refresh)
    world.blueprints.on('modify', refresh)
    world.blueprints.on('add', refresh)
    world.blueprints.on('remove', refresh)
    return () => {
      world.off('ui', refresh)
      world.blueprints.off('modify', refresh)
      world.blueprints.off('add', refresh)
      world.blueprints.off('remove', refresh)
    }
  }, [createOpen, world])

  useEffect(() => {
    if (!createOpen) return
    let active = true
    const apiUrl = world.network?.apiUrl
    if (!apiUrl) {
      setCreateDocsIndex([])
      return () => {}
    }
    const loadDocs = async () => {
      try {
        const response = await fetch(`${apiUrl}/ai-docs-index`)
        if (!response.ok) throw new Error('docs_index_failed')
        const data = await response.json()
        if (!active) return
        const files = Array.isArray(data?.files) ? data.files.filter(Boolean) : []
        setCreateDocsIndex(files)
      } catch {
        if (!active) return
        setCreateDocsIndex([])
      }
    }
    loadDocs()
    return () => {
      active = false
    }
  }, [createOpen, world.network?.apiUrl])

  const createAttachmentSet = useMemo(() => {
    const set = new Set()
    for (const item of createAttachments) {
      if (!item?.type || !item?.path) continue
      set.add(`${item.type}:${item.path}`)
    }
    return set
  }, [createAttachments])
  const createFileIndex = useMemo(() => {
    const entries = []
    const scripts = createScriptRoot?.scriptFiles ? Object.keys(createScriptRoot.scriptFiles) : []
    for (const scriptPath of scripts) {
      entries.push({ type: 'script', path: scriptPath, id: `script:${scriptPath}` })
    }
    for (const docPath of createDocsIndex) {
      entries.push({ type: 'doc', path: docPath, id: `doc:${docPath}` })
    }
    entries.sort((a, b) => a.path.localeCompare(b.path))
    return entries
  }, [createDocsIndex, createScriptRoot?.scriptFiles])
  const createAttachmentPayload = useMemo(
    () => createAttachments.map(item => ({ type: item.type, path: item.path })),
    [createAttachments]
  )
  const sendCreate = useCallback(async () => {
    const trimmed = createPrompt.trim()
    if (!trimmed) {
      setCreateError('Enter a prompt to create an app.')
      return
    }
    if (!world.ai?.createFromPrompt) {
      setCreateError('AI create is not available in this session.')
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      await world.ai.createFromPrompt({
        prompt: trimmed,
        attachments: createAttachmentPayload,
        scriptRootId: createScriptRoot?.id || null,
      })
      world.emit('toast', 'Creating app...')
      setCreateOpen(false)
      setCreatePrompt('')
      setCreateAttachments([])
      setCreateMention(null)
    } catch (err) {
      const code = err?.code || err?.message
      if (code === 'ai_disabled') {
        setCreateError('AI is not configured on this server.')
      } else if (code === 'builder_required') {
        setCreateError('Builder access required.')
      } else if (code === 'admin_required' || code === 'admin_code_missing' || code === 'deploy_required') {
        setCreateError('Admin code required.')
      } else if (code === 'locked' || code === 'deploy_locked' || code === 'deploy_lock_required') {
        const owner = err?.lock?.owner
        setCreateError(owner ? `Deploy locked by ${owner}.` : 'Deploy locked by another session.')
      } else if (code === 'upload_failed') {
        setCreateError('Upload failed.')
      } else {
        console.error(err)
        setCreateError('Create failed.')
      }
    } finally {
      setCreating(false)
    }
  }, [createAttachmentPayload, createPrompt, createScriptRoot?.id, world])
  const updateCreateMention = useCallback(
    (value, caret) => {
      if (!createFileIndex.length) {
        if (createMention) setCreateMention(null)
        return
      }
      const mention = getMentionState(value, caret)
      if (!mention) {
        if (createMention) setCreateMention(null)
        return
      }
      const items = fuzzyMatchList(mention.query, createFileIndex).slice(0, 8)
      setCreateMention(prev => {
        const nextIndex = prev && prev.query === mention.query ? prev.activeIndex : 0
        const bounded = items.length > 0 ? Math.min(nextIndex, items.length - 1) : 0
        return {
          open: true,
          query: mention.query,
          start: mention.start,
          end: caret,
          items,
          activeIndex: bounded,
        }
      })
    },
    [createFileIndex, createMention]
  )
  const addCreateAttachment = useCallback(
    item => {
      if (!item?.type || !item?.path) return
      const key = `${item.type}:${item.path}`
      if (createAttachmentSet.has(key)) {
        setCreateMention(null)
        return
      }
      setCreateAttachments(current => [...current, { type: item.type, path: item.path }])
      setCreateMention(null)
      setCreatePrompt(current => {
        if (!createMention?.open) return current
        const before = current.slice(0, createMention.start)
        const after = current.slice(createMention.end)
        return `${before}${after}`
      })
      if (createMention?.open && Number.isFinite(createMention.start)) {
        const position = createMention.start
        requestAnimationFrame(() => {
          const input = createPromptRef.current
          if (!input) return
          input.focus()
          input.selectionStart = position
          input.selectionEnd = position
        })
      }
    },
    [createAttachmentSet, createMention]
  )
  const removeCreateAttachment = useCallback(item => {
    if (!item?.type || !item?.path) return
    setCreateAttachments(current =>
      current.filter(entry => entry.type !== item.type || entry.path !== item.path)
    )
  }, [])
  const handleCreatePromptChange = useCallback(
    e => {
      const value = e.target.value
      if (createError) setCreateError(null)
      setCreatePrompt(value)
      updateCreateMention(value, e.target.selectionStart)
    },
    [createError, updateCreateMention]
  )
  const handleCreatePromptKeyDown = useCallback(
    e => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'Enter' || e.code === 'Enter')) {
        e.preventDefault()
        sendCreate()
        return
      }
      if (!createMention?.open) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCreateMention(current => {
          if (!current) return current
          const next = current.activeIndex + 1 >= current.items.length ? 0 : current.activeIndex + 1
          return { ...current, activeIndex: next }
        })
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCreateMention(current => {
          if (!current) return current
          const next =
            current.activeIndex - 1 < 0 ? Math.max(current.items.length - 1, 0) : current.activeIndex - 1
          return { ...current, activeIndex: next }
        })
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const selected = createMention.items[createMention.activeIndex]
        if (selected) {
          addCreateAttachment(selected)
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setCreateMention(null)
      }
    },
    [createMention, addCreateAttachment, sendCreate]
  )
  const handleCreatePromptKeyUp = useCallback(
    e => {
      updateCreateMention(e.currentTarget.value, e.currentTarget.selectionStart)
    },
    [updateCreateMention]
  )

  const add = async blueprint => {
    const transform = world.builder.getSpawnTransform(true)
    world.builder.toggle(true)
    world.builder.control.pointer.lock()
    let spawnBlueprint = blueprint
    if (blueprint.unique) {
      spawnBlueprint = await world.builder.forkTemplateFromBlueprint(blueprint, 'Add')
      if (!spawnBlueprint) return
    }
    setTimeout(() => {
      const data = {
        id: uuid(),
        type: 'app',
        blueprint: spawnBlueprint.id,
        position: transform.position,
        quaternion: transform.quaternion,
        scale: [1, 1, 1],
        mover: world.network.id,
        uploader: null,
        pinned: false,
        props: {},
        state: {},
      }
      const app = world.entities.add(data)
      world.admin.entityAdd(data, { ignoreNetworkId: world.network.id })
      world.builder.select(app)
    }, 100)
  }

  const remove = blueprint => {
    world.ui
      .confirm({
        title: 'Delete blueprint',
        message: `Delete blueprint \"${blueprint.name || blueprint.id}\"? This cannot be undone.`,
        confirmText: 'Delete',
        cancelText: 'Cancel',
      })
      .then(async ok => {
        if (!ok) return
        try {
          await world.admin.blueprintRemove(blueprint.id)
          world.emit('toast', 'Blueprint deleted')
        } catch (err) {
          const code = err?.message || ''
          if (code === 'in_use') {
            world.emit('toast', 'Cannot delete blueprint: there are spawned entities using it.')
          } else {
            world.emit('toast', 'Blueprint delete failed')
          }
        }
      })
  }

  const handleClick = blueprint => {
    if (trashMode) {
      remove(blueprint)
    } else {
      void add(blueprint)
    }
  }

  const toggleKeep = blueprint => {
    const nextKeep = !blueprint.keep
    const version = blueprint.version + 1
    world.blueprints.modify({ id: blueprint.id, version, keep: nextKeep })
    world.admin.blueprintModify({ id: blueprint.id, version, keep: nextKeep }, { ignoreNetworkId: world.network.id })
  }

  const runClean = async () => {
    if (cleaning) return
    if (world.builder?.ensureAdminReady && !world.builder.ensureAdminReady('Clean now')) return
    if (!world.admin?.runClean) {
      world.emit('toast', 'Clean endpoint unavailable')
      return
    }
    setCleaning(true)
    try {
      await world.admin.runClean()
      world.emit('toast', 'Cleanup complete')
    } catch (err) {
      console.error(err)
      world.emit('toast', 'Cleanup failed')
    } finally {
      setCleaning(false)
    }
  }

  const openCreate = () => {
    if (tab !== 'templates') return
    if (createOpen) {
      setCreateOpen(false)
      return
    }
    setCreateError(null)
    setCreatePrompt('')
    setCreateAttachments([])
    setCreateMention(null)
    setCreateOpen(true)
  }

  const switchTab = next => {
    setTab(next)
    if (next !== 'templates') {
      setTrashMode(false)
      setCreateOpen(false)
      setCreateError(null)
      setCreatePrompt('')
      setCreateAttachments([])
      setCreateMention(null)
      setCreateScriptRoot(null)
    }
  }

  return (
    <Pane hidden={hidden}>
      <div
        className='add'
        css={css`
          background: rgba(11, 10, 21, 0.9);
          border: 1px solid rgba(255, 255, 255, 0.05);
          border-radius: 1.375rem;
          display: flex;
          flex-direction: column;
          min-height: 17rem;
          position: relative;
          .add-head {
            height: 3.125rem;
            padding: 0 1rem;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            display: flex;
            align-items: center;
          }
          .add-title {
            flex: 1;
            font-weight: 500;
            font-size: 1rem;
            line-height: 1;
          }
          .add-tabs {
            display: inline-flex;
            gap: 0.35rem;
            margin-right: 0.5rem;
          }
          .add-tab {
            border: 1px solid rgba(255, 255, 255, 0.12);
            background: transparent;
            color: rgba(255, 255, 255, 0.6);
            font-size: 0.75rem;
            padding: 0.25rem 0.65rem;
            border-radius: 999px;
            &:hover {
              cursor: pointer;
              color: white;
              border-color: rgba(255, 255, 255, 0.35);
            }
            &.active {
              color: white;
              border-color: rgba(76, 224, 161, 0.65);
              background: rgba(76, 224, 161, 0.12);
            }
          }
          .add-action,
          .add-toggle {
            width: 2rem;
            height: 2rem;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #5d6077;
            &:hover {
              cursor: pointer;
              color: white;
            }
          }
          .add-action.active {
            color: #4ce0a1;
          }
          .add-toggle {
            &.active {
              color: #ff6b6b;
            }
          }
          .add-content {
            flex: 1;
            overflow-y: auto;
            padding: 1rem;
          }
          .add-items {
            display: flex;
            align-items: stretch;
            flex-wrap: wrap;
            gap: ${gap};
          }
          .add-item {
            flex-basis: calc((100% / ${span}) - (${gap} * (${span} - 1) / ${span}));
            cursor: pointer;
          }
          .add-item.trash .add-item-image {
            border-color: rgba(255, 107, 107, 0.6);
          }
          .add-item-image {
            width: 100%;
            aspect-ratio: 1;
            background-color: #1c1d22;
            background-size: cover;
            border: 1px solid rgba(255, 255, 255, 0.05);
            border-radius: 0.7rem;
            margin: 0 0 0.4rem;
          }
          .add-item-name {
            text-align: center;
            font-size: 0.875rem;
          }
          .add-orphans {
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
          }
          .add-orphans-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 0.75rem;
          }
          .add-orphans-title {
            font-weight: 500;
            font-size: 0.9rem;
          }
          .add-orphans-clean {
            border-radius: 999px;
            border: 1px solid rgba(255, 255, 255, 0.12);
            padding: 0.35rem 0.85rem;
            font-size: 0.75rem;
            background: rgba(255, 255, 255, 0.06);
            color: rgba(255, 255, 255, 0.75);
            &:hover:not(:disabled) {
              cursor: pointer;
              color: white;
              border-color: rgba(255, 255, 255, 0.35);
            }
            &:disabled {
              opacity: 0.5;
              cursor: default;
            }
          }
          .add-orphans-list {
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
          }
          .add-orphan-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 0.75rem;
            padding: 0.5rem 0.75rem;
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 0.65rem;
            background: rgba(255, 255, 255, 0.03);
          }
          .add-orphan-name {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-size: 0.85rem;
          }
          .add-orphan-toggle {
            display: inline-flex;
            align-items: center;
            gap: 0.35rem;
            border: 1px solid rgba(255, 255, 255, 0.12);
            background: transparent;
            color: rgba(255, 255, 255, 0.65);
            padding: 0.25rem 0.5rem;
            border-radius: 999px;
            font-size: 0.75rem;
            &:hover {
              cursor: pointer;
              color: white;
              border-color: rgba(255, 255, 255, 0.35);
            }
            &.active {
              color: white;
              border-color: rgba(76, 224, 161, 0.65);
              background: rgba(76, 224, 161, 0.12);
            }
          }
          .add-orphans-empty {
            font-size: 0.8rem;
            color: rgba(255, 255, 255, 0.5);
            padding: 0.5rem 0.25rem;
          }
          .add-create-overlay {
            position: absolute;
            inset: 0;
            padding: 1rem;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(11, 10, 21, 0.85);
            backdrop-filter: blur(6px);
          }
          .add-create-panel {
            width: 100%;
            border-radius: 0.9rem;
            border: 1px solid rgba(255, 255, 255, 0.08);
            background: rgba(18, 19, 30, 0.95);
            padding: 1rem;
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
          }
          .add-create-title {
            font-weight: 600;
            font-size: 1rem;
          }
          .add-create-input {
            position: relative;
          }
          .add-create-input textarea {
            width: 100%;
            min-height: 7rem;
            resize: vertical;
            border-radius: 0.6rem;
            border: 1px solid rgba(255, 255, 255, 0.08);
            background: rgba(10, 11, 18, 0.9);
            color: white;
            padding: 0.6rem 0.7rem;
            font-size: 0.9rem;
            font-family: inherit;
          }
          .add-create-mentions {
            position: absolute;
            left: 0;
            right: 0;
            top: calc(100% + 0.35rem);
            background: rgba(8, 9, 14, 0.98);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 0.65rem;
            max-height: 12rem;
            overflow-y: auto;
            z-index: 5;
            padding: 0.35rem;
            box-shadow: 0 10px 25px rgba(0, 0, 0, 0.35);
          }
          .add-create-mention-item {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.35rem 0.5rem;
            border-radius: 0.5rem;
            font-size: 0.75rem;
            color: rgba(255, 255, 255, 0.8);
            cursor: pointer;
          }
          .add-create-mention-item.active {
            background: rgba(76, 224, 161, 0.15);
            color: #4ce0a1;
          }
          .add-create-mention-item.disabled {
            opacity: 0.45;
            cursor: default;
          }
          .add-create-mention-icon {
            display: flex;
            align-items: center;
            color: rgba(255, 255, 255, 0.65);
          }
          .add-create-mention-path {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .add-create-mention-tag {
            font-size: 0.65rem;
            border-radius: 999px;
            border: 1px solid rgba(255, 255, 255, 0.15);
            padding: 0.1rem 0.4rem;
            color: rgba(255, 255, 255, 0.6);
            text-transform: uppercase;
            letter-spacing: 0.04em;
          }
          .add-create-mention-empty {
            padding: 0.45rem 0.6rem;
            font-size: 0.75rem;
            color: rgba(255, 255, 255, 0.5);
          }
          .add-create-attachments {
            display: flex;
            flex-direction: column;
            gap: 0.35rem;
          }
          .add-create-attachment {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.3rem 0.5rem;
            border-radius: 0.5rem;
            border: 1px solid rgba(255, 255, 255, 0.08);
            background: rgba(8, 9, 14, 0.5);
            font-size: 0.75rem;
            color: rgba(255, 255, 255, 0.8);
          }
          .add-create-attachment-icon {
            display: flex;
            align-items: center;
            color: rgba(255, 255, 255, 0.6);
          }
          .add-create-attachment-path {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .add-create-attachment-remove {
            border: 0;
            background: transparent;
            color: rgba(255, 255, 255, 0.6);
            font-size: 0.75rem;
            &:hover {
              cursor: pointer;
              color: white;
            }
          }
          .add-create-footer {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 0.75rem;
            flex-wrap: wrap;
          }
          .add-create-hint {
            font-size: 0.7rem;
            color: rgba(255, 255, 255, 0.45);
          }
          .add-create-actions {
            display: flex;
            gap: 0.5rem;
          }
          .add-create-btn {
            border-radius: 999px;
            border: 1px solid rgba(255, 255, 255, 0.12);
            padding: 0.45rem 0.9rem;
            font-size: 0.85rem;
            cursor: pointer;
            background: rgba(255, 255, 255, 0.04);
          }
          .add-create-btn.primary {
            background: rgba(76, 224, 161, 0.2);
            border-color: rgba(76, 224, 161, 0.5);
            color: #bff6df;
          }
          .add-create-btn:disabled {
            opacity: 0.5;
            cursor: default;
          }
          .add-create-error {
            color: #ff8b8b;
            font-size: 0.85rem;
          }
        `}
      >
        <div className='add-head'>
          <div className='add-title'>Add</div>
          <div className='add-tabs'>
            <button
              type='button'
              className={cls('add-tab', { active: tab === 'templates' })}
              onClick={() => switchTab('templates')}
            >
              Templates
            </button>
            <button
              type='button'
              className={cls('add-tab', { active: tab === 'orphans' })}
              onClick={() => switchTab('orphans')}
            >
              Orphans
            </button>
          </div>
          {tab === 'templates' && (
            <>
              <div className={cls('add-action', { active: createOpen })} onClick={openCreate} title='AI Create'>
                <CirclePlusIcon size='1.125rem' />
              </div>
              <div className={cls('add-toggle', { active: trashMode })} onClick={() => setTrashMode(!trashMode)}>
                <Trash2Icon size='1.125rem' />
              </div>
            </>
          )}
        </div>
        <div className='add-content noscrollbar'>
          {tab === 'templates' ? (
            <div className='add-items'>
              {templates.map(blueprint => {
                const imageUrl = blueprint.image?.url || (typeof blueprint.image === 'string' ? blueprint.image : null)
                return (
                  <div
                    className={cls('add-item', { trash: trashMode })}
                    key={blueprint.id}
                    onClick={() => handleClick(blueprint)}
                  >
                    <div
                      className='add-item-image'
                      css={css`
                        ${imageUrl ? `background-image: url(${world.resolveURL(imageUrl)});` : ''}
                      `}
                    ></div>
                    <div className='add-item-name'>{blueprint.name || blueprint.id}</div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className='add-orphans'>
              <div className='add-orphans-head'>
                <div className='add-orphans-title'>Orphans ({orphans.length})</div>
                <button
                  type='button'
                  className='add-orphans-clean'
                  onClick={runClean}
                  disabled={!orphans.length || cleaning}
                >
                  {cleaning ? 'Cleaning...' : 'Clean now'}
                </button>
              </div>
              {orphans.length ? (
                <div className='add-orphans-list'>
                  {orphans.map(blueprint => (
                    <div className='add-orphan-row' key={blueprint.id}>
                      <div className='add-orphan-name'>{blueprint.name || blueprint.id}</div>
                      <button
                        type='button'
                        className={cls('add-orphan-toggle', { active: blueprint.keep })}
                        onClick={() => toggleKeep(blueprint)}
                      >
                        {blueprint.keep ? <SquareCheckBigIcon size='0.85rem' /> : <SquareIcon size='0.85rem' />}
                        <span>Keep</span>
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className='add-orphans-empty'>No orphaned blueprints.</div>
              )}
            </div>
          )}
        </div>
        {createOpen && (
          <div className='add-create-overlay' onMouseDown={e => e.stopPropagation()}>
            <div className='add-create-panel'>
              <div className='add-create-title'>AI Create</div>
              <div className='add-create-input'>
                <textarea
                  ref={createPromptRef}
                  placeholder='Describe what you want to create. Use @ to attach files.'
                  value={createPrompt}
                  disabled={creating}
                  onChange={handleCreatePromptChange}
                  onKeyDown={handleCreatePromptKeyDown}
                  onKeyUp={handleCreatePromptKeyUp}
                  onBlur={() => setCreateMention(null)}
                />
                {createMention?.open && (
                  <div className='add-create-mentions' onMouseDown={e => e.preventDefault()}>
                    {createMention.items.length ? (
                      createMention.items.map((item, index) => {
                        const attached = createAttachmentSet.has(item.id)
                        return (
                          <div
                            key={item.id}
                            className={cls('add-create-mention-item', {
                              active: index === createMention.activeIndex,
                              disabled: attached,
                            })}
                            onMouseDown={e => e.preventDefault()}
                            onClick={() => {
                              if (!attached) addCreateAttachment(item)
                            }}
                          >
                            <span className='add-create-mention-icon'>
                              {item.type === 'doc' ? (
                                <BookTextIcon size='0.85rem' />
                              ) : (
                                <CodeIcon size='0.85rem' />
                              )}
                            </span>
                            <span className='add-create-mention-path'>{item.path}</span>
                            <span className='add-create-mention-tag'>{attached ? 'attached' : item.type}</span>
                          </div>
                        )
                      })
                    ) : (
                      <div className='add-create-mention-empty'>No matches</div>
                    )}
                  </div>
                )}
              </div>
              {createAttachments.length > 0 && (
                <div className='add-create-attachments'>
                  {createAttachments.map(item => (
                    <div key={`${item.type}:${item.path}`} className='add-create-attachment'>
                      <span className='add-create-attachment-icon'>
                        {item.type === 'doc' ? <BookTextIcon size='0.75rem' /> : <CodeIcon size='0.75rem' />}
                      </span>
                      <span className='add-create-attachment-path'>{item.path}</span>
                      <button
                        className='add-create-attachment-remove'
                        type='button'
                        onClick={() => removeCreateAttachment(item)}
                      >
                        x
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {createError && <div className='add-create-error'>{createError}</div>}
              <div className='add-create-footer'>
                <div className='add-create-hint'>Use @ to attach docs or scripts.</div>
                <div className='add-create-actions'>
                  <button
                    type='button'
                    className='add-create-btn'
                    onClick={() => setCreateOpen(false)}
                    disabled={creating}
                  >
                    Cancel
                  </button>
                  <button
                    type='button'
                    className='add-create-btn primary'
                    onClick={sendCreate}
                    disabled={creating || !createPrompt.trim()}
                  >
                    {creating ? 'Creating...' : 'Create'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </Pane>
  )
}

const extToType = {
  glb: 'model',
  vrm: 'avatar',
}
const allowedModels = ['glb', 'vrm']
let showTransforms = false

function App({ world, hidden }) {
  const { setHint } = useContext(HintContext)
  const app = world.ui.state.app
  const [pinned, setPinned] = useState(app.data.pinned)
  const [transforms, setTransforms] = useState(showTransforms)
  const [blueprint, setBlueprint] = useState(app.blueprint)
  const [appTab, setAppTab] = useState('settings')
  const [mergingId, setMergingId] = useState(null)
  useEffect(() => {
    showTransforms = transforms
  }, [transforms])
  useEffect(() => {
    window.app = app
  }, [app])
  useEffect(() => {
    const onModify = bp => {
      if (bp.id === blueprint.id) setBlueprint(bp)
    }

    world.blueprints.on('modify', onModify)
    return () => {
      world.blueprints.off('modify', onModify)
    }
  }, [world, blueprint.id])
  const scriptGroups = buildScriptGroups(world.blueprints.items)
  const scriptGroup = scriptGroups.byId.get(blueprint.id) || null
  const variantMain = scriptGroup?.main || blueprint
  const variants = scriptGroup?.items?.length ? scriptGroup.items : [blueprint]
  const frozen = blueprint.frozen
  const resolveModelUpdateMode = async () => {
    if (blueprint.unique || !world.ui?.confirm) return 'all'
    let count = 0
    for (const entity of world.entities.items.values()) {
      if (entity.isApp && entity.data.blueprint === blueprint.id) count += 1
    }
    const message =
      count > 1
        ? `This model is shared by ${count} instances. Apply to all or fork this app?`
        : 'This model is shared by this template. Apply to all or fork this app?'
    const applyAll = await world.ui.confirm({
      title: 'Apply model change?',
      message,
      confirmText: 'Apply to all',
      cancelText: 'Fork',
    })
    return applyAll ? 'all' : 'fork'
  }
  const changeModel = async file => {
    if (!file) return
    const ext = file.name.split('.').pop().toLowerCase()
    if (!allowedModels.includes(ext)) return
    const updateMode = await resolveModelUpdateMode()
    // immutable hash the file
    const hash = await hashFile(file)
    // use hash as glb filename
    const filename = `${hash}.${ext}`
    // canonical url to this file
    const url = `asset://${filename}`
    // cache file locally so this client can insta-load it
    const type = extToType[ext]
    world.loader.insert(type, url, file)
    // upload model
    await world.admin.upload(file)
    if (updateMode === 'fork') {
      if (!world.builder?.forkTemplateFromBlueprint) {
        world.emit('toast', 'Builder access required.')
        return
      }
      const forked = await world.builder.forkTemplateFromBlueprint(blueprint, 'Model fork', null, { model: url })
      if (!forked) return
      app.modify({ blueprint: forked.id })
      world.admin.entityModify(
        { id: app.data.id, blueprint: forked.id },
        { ignoreNetworkId: world.network.id }
      )
      setBlueprint(forked)
      world.emit('toast', 'Model forked')
      return
    }
    // update blueprint locally (also rebuilds apps)
    const version = blueprint.version + 1
    world.blueprints.modify({ id: blueprint.id, version, model: url })
    // broadcast blueprint change to server + other clients
    world.admin.blueprintModify({ id: blueprint.id, version, model: url }, { ignoreNetworkId: world.network.id })
  }
  const toggleKey = async (key, value) => {
    value = isBoolean(value) ? value : !blueprint[key]
    if (blueprint[key] === value) return
    if (key === 'unique' && value && !blueprint.scene) {
      let count = 0
      for (const entity of world.entities.items.values()) {
        if (entity.isApp && entity.data.blueprint === blueprint.id) count += 1
      }
      if (count > 1) {
        const forked = await world.builder.forkTemplateFromEntity(app, 'Unique', { unique: true })
        if (!forked) return
        app.modify({ blueprint: forked.id, props: {} })
        world.admin.entityModify(
          { id: app.data.id, blueprint: forked.id, props: {} },
          { ignoreNetworkId: world.network.id }
        )
        setBlueprint(forked)
        return
      }
    }
    const version = blueprint.version + 1
    world.blueprints.modify({ id: blueprint.id, version, [key]: value })
    world.admin.blueprintModify({ id: blueprint.id, version, [key]: value }, { ignoreNetworkId: world.network.id })
  }
  const togglePinned = () => {
    const pinned = !app.data.pinned
    app.data.pinned = pinned
    world.admin.entityModify({ id: app.data.id, pinned }, { ignoreNetworkId: world.network.id })
    setPinned(pinned)
  }
  const mergeVariant = async variant => {
    if (!variant || variant.id === variantMain.id) return
    if (!areBlueprintsTwinUnique(variantMain, variant)) return
    const targets = []
    for (const entity of world.entities.items.values()) {
      if (entity?.isApp && entity.data.blueprint === variant.id) {
        targets.push(entity)
      }
    }
    const ok = await world.ui.confirm({
      title: 'Merge duplicate',
      message: `Merge "${variant.name || variant.id}" into "${variantMain.name || variantMain.id}"? ${targets.length} instance(s) will be repointed and the duplicate blueprint deleted.`,
      confirmText: 'Merge',
      cancelText: 'Cancel',
    })
    if (!ok) return
    if (world.builder?.ensureAdminReady && !world.builder.ensureAdminReady('Merge')) return
    setMergingId(variant.id)
    try {
      for (const entity of targets) {
        entity.modify({ blueprint: variantMain.id })
        world.admin.entityModify(
          { id: entity.data.id, blueprint: variantMain.id },
          { ignoreNetworkId: world.network.id }
        )
      }
      await world.admin.blueprintRemove(variant.id)
      world.emit('toast', 'Merged duplicate blueprint')
    } catch (err) {
      console.error(err)
      world.emit('toast', 'Merge failed')
    } finally {
      setMergingId(null)
    }
  }

  return (
    <Pane hidden={hidden}>
      <div
        className='app'
        css={css`
          background: rgba(11, 10, 21, 0.9);
          border: 1px solid rgba(255, 255, 255, 0.05);
          border-radius: 1.375rem;
          display: flex;
          flex-direction: column;
          min-height: 1rem;
          .app-head {
            height: 3.125rem;
            padding: 0 1rem;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            display: flex;
            align-items: center;
          }
          .app-tabs {
            padding: 0.45rem 1rem;
            display: flex;
            gap: 0.5rem;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          }
          .app-tab {
            border: 1px solid rgba(255, 255, 255, 0.12);
            background: transparent;
            color: rgba(255, 255, 255, 0.6);
            font-size: 0.75rem;
            padding: 0.25rem 0.7rem;
            border-radius: 999px;
            &:hover {
              cursor: pointer;
              color: white;
              border-color: rgba(255, 255, 255, 0.35);
            }
            &.active {
              color: white;
              border-color: rgba(76, 224, 161, 0.65);
              background: rgba(76, 224, 161, 0.12);
            }
          }
          .app-title {
            flex: 1;
            font-weight: 500;
            font-size: 1rem;
            line-height: 1;
            white-space: nowrap;
            text-overflow: ellipsis;
            overflow: hidden;
          }
          .app-btn {
            width: 2rem;
            height: 2rem;
            display: flex;
            align-items: center;
            justify-content: center;
            color: rgba(255, 255, 255, 0.8);
            &:hover {
              cursor: pointer;
              color: white;
            }
            &.active {
              color: #4088ff;
            }
            &.loading {
              cursor: not-allowed;
              opacity: 0.5;
            }
          }
          .app-toggles {
            padding: 0.5rem 1.4rem;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            display: flex;
            align-items: center;
            justify-content: space-between;
          }
          .app-toggle {
            width: 2rem;
            height: 2rem;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #6f7289;
            &:hover:not(.disabled) {
              cursor: pointer;
            }
            &.active {
              color: white;
            }
            &.disabled {
              color: #434556;
            }
          }
          .app-transforms {
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          }
          .app-transforms-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0.4rem;
            &:hover {
              cursor: pointer;
            }
          }
          .app-content {
            flex: 1;
            overflow-y: auto;
          }
          .app-variants {
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
            padding: 0.75rem 1rem;
          }
          .app-variant-row {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            padding: 0.45rem 0.6rem;
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 0.6rem;
            background: rgba(255, 255, 255, 0.03);
          }
          .app-variant-name {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-size: 0.85rem;
          }
          .app-variant-main {
            font-size: 0.7rem;
            color: rgba(255, 255, 255, 0.6);
            border: 1px solid rgba(255, 255, 255, 0.2);
            padding: 0.1rem 0.4rem;
            border-radius: 999px;
          }
          .app-variant-merge {
            border: 1px solid rgba(255, 255, 255, 0.12);
            background: transparent;
            color: rgba(255, 255, 255, 0.7);
            font-size: 0.7rem;
            padding: 0.2rem 0.55rem;
            border-radius: 999px;
            &:hover:not(:disabled) {
              cursor: pointer;
              color: white;
              border-color: rgba(255, 255, 255, 0.35);
            }
            &:disabled {
              opacity: 0.45;
              cursor: default;
            }
          }
          .app-variant-empty {
            font-size: 0.8rem;
            color: rgba(255, 255, 255, 0.5);
          }
        `}
      >
        <div className='app-head'>
          <div className='app-title'>{app.blueprint.name}</div>
          {!frozen && (
            <AppModelBtn value={blueprint.model} onChange={changeModel}>
              <div
                className='app-btn'
                onPointerEnter={() => setHint('Change this apps base model')}
                onPointerLeave={() => setHint(null)}
              >
                <BoxIcon size='1.125rem' />
              </div>
            </AppModelBtn>
          )}
          {!blueprint.scene && (
            <div
              className='app-btn'
              onClick={() => {
                world.ui.setApp(null)
                app.destroy(true)
              }}
              onPointerEnter={() => setHint('Delete this app')}
              onPointerLeave={() => setHint(null)}
            >
              <Trash2Icon size='1.125rem' />
            </div>
          )}
        </div>
        <div className='app-tabs'>
          <button
            type='button'
            className={cls('app-tab', { active: appTab === 'settings' })}
            onClick={() => setAppTab('settings')}
          >
            Settings
          </button>
          <button
            type='button'
            className={cls('app-tab', { active: appTab === 'variants' })}
            onClick={() => setAppTab('variants')}
          >
            Variants
          </button>
        </div>
        {appTab === 'settings' && !blueprint.scene && (
          <div className='app-toggles'>
            <div
              className={cls('app-toggle', { active: blueprint.disabled })}
              onClick={() => toggleKey('disabled')}
              onPointerEnter={() => setHint('Disable this app so that it is no longer active in the world.')}
              onPointerLeave={() => setHint(null)}
            >
              <OctagonXIcon size='1.125rem' />
              {/* {blueprint.disabled ? <SquareIcon size='1.125rem' /> : <SquareCheckBigIcon size='1.125rem' />} */}
            </div>
            <div
              className={cls('app-toggle', { active: pinned })}
              onClick={() => togglePinned()}
              onPointerEnter={() => setHint("Pin this app so it can't accidentally be moved.")}
              onPointerLeave={() => setHint(null)}
            >
              <PinIcon size='1.125rem' />
            </div>
            <div
              className={cls('app-toggle', { active: blueprint.preload })}
              onClick={() => toggleKey('preload')}
              onPointerEnter={() => setHint('Preload this app before entering the world.')}
              onPointerLeave={() => setHint(null)}
            >
              <LoaderPinwheelIcon size='1.125rem' />
            </div>
            <div
              className={cls('app-toggle', { active: blueprint.unique })}
              onClick={() => toggleKey('unique')}
              onPointerEnter={() => setHint('When enabled, duplicates fork this template automatically.')}
              onPointerLeave={() => setHint(null)}
            >
              <SparkleIcon size='1.125rem' />
            </div>
          </div>
        )}
        <div className='app-content noscrollbar'>
          {appTab === 'settings' ? (
            <>
              {!blueprint.scene && (
                <div className='app-transforms'>
                  <div className='app-transforms-btn' onClick={() => setTransforms(!transforms)}>
                    <ChevronsUpDownIcon size='1rem' />
                  </div>
                  {transforms && <AppTransformFields app={app} />}
                </div>
              )}
              <AppFields world={world} app={app} blueprint={blueprint} />
            </>
          ) : (
            <div className='app-variants'>
              {variants.length ? (
                variants.map(variant => {
                  const isMain = variant.id === variantMain.id
                  const canMerge = !isMain && areBlueprintsTwinUnique(variantMain, variant)
                  const isMerging = mergingId === variant.id
                  return (
                    <div className='app-variant-row' key={variant.id}>
                      <div className='app-variant-name'>{variant.name || variant.id}</div>
                      {isMain && <div className='app-variant-main'>Main</div>}
                      {!isMain && canMerge && (
                        <button
                          type='button'
                          className='app-variant-merge'
                          onClick={() => mergeVariant(variant)}
                          disabled={mergingId && !isMerging}
                        >
                          {isMerging ? 'Merging...' : 'Merge'}
                        </button>
                      )}
                    </div>
                  )
                })
              ) : (
                <div className='app-variant-empty'>No variants found.</div>
              )}
            </div>
          )}
        </div>
      </div>
    </Pane>
  )
}

function AppTransformFields({ app }) {
  const [position, setPosition] = useState(app.root.position.toArray())
  const [rotation, setRotation] = useState(app.root.rotation.toArray().map(n => n * RAD2DEG))
  const [scale, setScale] = useState(app.root.scale.toArray())
  return (
    <>
      <FieldVec3
        label='Position'
        dp={2}
        smallStep={0.01}
        step={0.1}
        bigStep={1}
        value={position}
        onChange={value => {
          console.log(value)
          setPosition(value)
          app.modify({ position: value })
          app.world.admin.entityModify(
            {
              id: app.data.id,
              position: value,
            },
            { ignoreNetworkId: app.world.network.id }
          )
        }}
      />
      <FieldVec3
        label='Rotation'
        dp={2}
        smallStep={0.1}
        step={1}
        bigStep={5}
        value={rotation}
        onChange={value => {
          setRotation(value)
          value = q1.setFromEuler(e1.fromArray(value.map(n => n * DEG2RAD))).toArray()
          app.modify({ quaternion: value })
          app.world.admin.entityModify(
            {
              id: app.data.id,
              quaternion: value,
            },
            { ignoreNetworkId: app.world.network.id }
          )
        }}
      />
      <FieldVec3
        label='Scale'
        dp={2}
        smallStep={0.01}
        step={0.1}
        bigStep={1}
        value={scale}
        onChange={value => {
          setScale(value)
          app.modify({ scale: value })
          app.world.admin.entityModify(
            {
              id: app.data.id,
              scale: value,
            },
            { ignoreNetworkId: app.world.network.id }
          )
        }}
      />
    </>
  )
}

// todo: blueprint models need migrating to file object format so
// we can replace needing this and instead use MenuItemFile, but
// that will also somehow need to support both model and avatar kinds.
function AppModelBtn({ value, onChange, children }) {
  const [key, setKey] = useState(0)
  const handleDownload = e => {
    if (e.shiftKey) {
      e.preventDefault()
      const file = world.loader.getFile(value)
      if (!file) return
      downloadFile(file)
    }
  }
  const handleChange = e => {
    setKey(n => n + 1)
    onChange(e.target.files[0])
  }
  return (
    <label
      className='appmodelbtn'
      css={css`
        overflow: hidden;
        input {
          position: absolute;
          top: -9999px;
        }
      `}
      onClick={handleDownload}
    >
      <input key={key} type='file' accept='.glb,.vrm' onChange={handleChange} />
      {children}
    </label>
  )
}

function AppFields({ world, app, blueprint }) {
  const [fields, setFields] = useState(() => app.fields)
  const [templateMode, setTemplateMode] = useState(false)
  const templateProps = blueprint.props && typeof blueprint.props === 'object' && !isArray(blueprint.props) ? blueprint.props : {}
  const instanceProps = app.data.props && typeof app.data.props === 'object' && !isArray(app.data.props) ? app.data.props : {}
  const effectiveProps = merge({}, templateProps, instanceProps)
  const activeProps = templateMode ? templateProps : effectiveProps
  useEffect(() => {
    app.onFields = setFields
    return () => {
      app.onFields = null
    }
  }, [])
  const modifyTemplate = (key, value) => {
    const bp = world.blueprints.get(blueprint.id)
    const baseProps = bp.props && typeof bp.props === 'object' && !isArray(bp.props) ? bp.props : {}
    if (isEqual(baseProps[key], value)) return
    const newProps = { ...baseProps, [key]: value }
    // update blueprint locally (also rebuilds apps)
    const id = bp.id
    const version = bp.version + 1
    world.blueprints.modify({ id, version, props: newProps })
    // broadcast blueprint change to server + other clients
    world.admin.blueprintModify({ id, version, props: newProps }, { ignoreNetworkId: world.network.id })
  }
  const modifyInstance = (key, value) => {
    const currentProps =
      app.data.props && typeof app.data.props === 'object' && !isArray(app.data.props) ? app.data.props : {}
    const baseProps = blueprint.props && typeof blueprint.props === 'object' && !isArray(blueprint.props) ? blueprint.props : {}
    const nextProps = { ...currentProps }
    if (isEqual(value, baseProps[key])) {
      delete nextProps[key]
    } else {
      nextProps[key] = value
    }
    if (isEqual(nextProps, currentProps)) return
    app.modify({ props: nextProps })
    world.admin.entityModify({ id: app.data.id, props: nextProps }, { ignoreNetworkId: world.network.id })
  }
  const resetOverride = key => {
    const currentProps =
      app.data.props && typeof app.data.props === 'object' && !isArray(app.data.props) ? app.data.props : {}
    if (!Object.prototype.hasOwnProperty.call(currentProps, key)) return
    const nextProps = { ...currentProps }
    delete nextProps[key]
    if (isEqual(nextProps, currentProps)) return
    app.modify({ props: nextProps })
    world.admin.entityModify({ id: app.data.id, props: nextProps }, { ignoreNetworkId: world.network.id })
  }
  return (
    <>
      {fields.length > 0 && (
        <FieldToggle
          label='Template Defaults'
          hint='Edit defaults shared by all instances of this template'
          trueLabel='Template'
          falseLabel='Instance'
          value={templateMode}
          onChange={value => setTemplateMode(value)}
        />
      )}
      {fields.map(field => {
        const hasOverride = Object.prototype.hasOwnProperty.call(instanceProps, field.key)
        return (
          <AppField
            key={field.key}
            world={world}
            props={activeProps}
            field={field}
            value={activeProps[field.key]}
            modify={templateMode ? modifyTemplate : modifyInstance}
            showReset={!templateMode && hasOverride}
            onReset={() => resetOverride(field.key)}
          />
        )
      })}
    </>
  )
}

function AppField({ world, props, field, value, modify, showReset, onReset }) {
  if (field.hidden) {
    return null
  }
  if (field.when && isArray(field.when)) {
    for (const rule of field.when) {
      if (rule.op === 'eq' && props[rule.key] !== rule.value) {
        return null
      }
    }
  }
  if (field.type === 'section') {
    return <Group label={field.label} />
  }
  const wrap = content => {
    if (!showReset) return content
    return (
      <div
        className='app-field'
        css={css`
          display: flex;
          align-items: stretch;
          .app-field-main {
            flex: 1;
          }
          .app-field-reset {
            width: 2.25rem;
            display: flex;
            align-items: center;
            justify-content: center;
            color: rgba(255, 255, 255, 0.35);
            background: transparent;
            border: 0;
            padding: 0;
            margin: 0;
            &:hover {
              cursor: pointer;
              color: rgba(255, 255, 255, 0.9);
            }
          }
        `}
      >
        <div className='app-field-main'>{content}</div>
        <button
          type='button'
          className='app-field-reset'
          title='Reset override'
          onClick={e => {
            e.preventDefault()
            e.stopPropagation()
            onReset?.()
          }}
        >
          <RotateCcwIcon size='1rem' />
        </button>
      </div>
    )
  }
  if (field.type === 'text') {
    return wrap(
      <FieldText
        label={field.label}
        hint={field.hint}
        placeholder={field.placeholder}
        value={value}
        onChange={value => modify(field.key, value)}
      />
    )
  }
  if (field.type === 'textarea') {
    return wrap(
      <FieldTextarea label={field.label} hint={field.hint} value={value} onChange={value => modify(field.key, value)} />
    )
  }
  if (field.type === 'number') {
    return wrap(
      <FieldNumber
        label={field.label}
        hint={field.hint}
        dp={field.dp}
        min={field.min}
        max={field.max}
        step={field.step}
        bigStep={field.bigStep}
        value={value}
        onChange={value => modify(field.key, value)}
      />
    )
  }
  if (field.type === 'file') {
    return wrap(
      <FieldFile
        label={field.label}
        hint={field.hint}
        kind={field.kind}
        value={value}
        onChange={value => modify(field.key, value)}
        world={world}
      />
    )
  }
  if (field.type === 'switch') {
    return wrap(
      <FieldSwitch
        label={field.label}
        hint={field.hint}
        options={field.options}
        value={value}
        onChange={value => modify(field.key, value)}
      />
    )
  }
  if (field.type === 'dropdown') {
    // deprecated, same as switch
    return wrap(
      <FieldSwitch
        label={field.label}
        hint={field.hint}
        options={field.options}
        value={value}
        onChange={value => modify(field.key, value)}
      />
    )
  }
  if (field.type === 'toggle') {
    return wrap(
      <FieldToggle
        label={field.label}
        hint={field.hint}
        trueLabel={field.trueLabel}
        falseLabel={field.falseLabel}
        value={value}
        onChange={value => modify(field.key, value)}
      />
    )
  }
  if (field.type === 'range') {
    return wrap(
      <FieldRange
        label={field.label}
        hint={field.hint}
        min={field.min}
        max={field.max}
        step={field.step}
        value={value}
        onChange={value => modify(field.key, value)}
      />
    )
  }
  if (field.type === 'curve') {
    return wrap(
      <FieldCurve
        label={field.label}
        hint={field.hint}
        yMin={field.yMin}
        yMax={field.yMax}
        value={value}
        onChange={value => modify(field.key, value)}
      />
    )
  }
  if (field.type === 'button') {
    return <FieldBtn label={field.label} hint={field.hint} onClick={field.onClick} />
  }
  if (field.type === 'color') {
    return wrap(
      <FieldColor label={field.label} hint={field.hint} value={value} onChange={value => modify(field.key, value)} />
    )
  }
  return null
}

function Script({ world, hidden }) {
  const app = world.ui.state.app
  const containerRef = useRef()
  const resizeRef = useRef()
  const [handle, setHandle] = useState(null)
  const [scriptRoot, setScriptRoot] = useState(() =>
    resolveScriptRootBlueprint(world.blueprints.get(app.data.blueprint) || app.blueprint, world)
  )
  const moduleRoot = hasScriptFiles(scriptRoot) ? scriptRoot : null
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiMode, setAiMode] = useState('edit')
  const [aiStatus, setAiStatus] = useState(null)
  const [aiExpanded, setAiExpanded] = useState(true)
  const aiRequestRef = useRef(null)
  const aiPromptRef = useRef(null)
  const [aiAttachments, setAiAttachments] = useState([])
  const [aiDocsIndex, setAiDocsIndex] = useState([])
  const [aiMention, setAiMention] = useState(null)
  const scriptError = app?.scriptError || null
  const errorInfo = useMemo(() => formatScriptError(scriptError), [scriptError])
  const fileCount = moduleRoot?.scriptFiles ? Object.keys(moduleRoot.scriptFiles).length : 0
  const entryPath = moduleRoot?.scriptEntry || ''
  const scriptFormat = moduleRoot?.scriptFormat || 'module'
  const aiHasProposal = !!handle?.ai?.active
  const aiPending = aiStatus?.type === 'pending'
  const canBuild = !!world.builder?.canBuild?.()
  const aiAccessIssue = world.isAdminClient
    ? 'AI requests are not available on admin connections.'
    : !canBuild
      ? 'Builder access required.'
      : null
  const aiCanUse = !!moduleRoot && !aiAccessIssue && !!world.aiScripts?.requestEdit
  const aiCanSendEdit = aiCanUse && !aiPending && !aiHasProposal && !!aiPrompt.trim()
  const aiCanSendFix = aiCanUse && !aiPending && !aiHasProposal && !!scriptError
  const aiCanSend = aiMode === 'fix' ? aiCanSendFix : aiCanSendEdit
  const aiMetaClass = cls('script-ai-meta', {
    ready: aiHasProposal,
    pending: aiPending,
    error: aiStatus?.type === 'error',
  })
  const aiMeta = useMemo(() => {
    if (aiHasProposal) return 'Changes ready to review'
    if (aiPending) return 'Generating changes...'
    if (aiStatus?.type === 'error') return 'Last request failed'
    if (aiMode === 'fix') {
      return scriptError ? 'Fix the latest script error' : 'No script error to fix'
    }
    return 'Ask for edits or fixes'
  }, [aiHasProposal, aiPending, aiStatus?.type, aiMode, scriptError])
  const aiAttachmentSet = useMemo(() => {
    const set = new Set()
    for (const item of aiAttachments) {
      if (!item?.type || !item?.path) continue
      set.add(`${item.type}:${item.path}`)
    }
    return set
  }, [aiAttachments])
  const aiFileIndex = useMemo(() => {
    const entries = []
    const scripts = moduleRoot?.scriptFiles ? Object.keys(moduleRoot.scriptFiles) : []
    for (const scriptPath of scripts) {
      entries.push({
        type: 'script',
        path: scriptPath,
        id: `script:${scriptPath}`,
      })
    }
    for (const docPath of aiDocsIndex) {
      entries.push({
        type: 'doc',
        path: docPath,
        id: `doc:${docPath}`,
      })
    }
    entries.sort((a, b) => a.path.localeCompare(b.path))
    return entries
  }, [aiDocsIndex, moduleRoot?.scriptFiles])
  const aiAttachmentPayload = useMemo(
    () => aiAttachments.map(item => ({ type: item.type, path: item.path })),
    [aiAttachments]
  )
  useEffect(() => {
    const refresh = () => {
      const blueprint = world.blueprints.get(app.data.blueprint) || app.blueprint
      setScriptRoot(resolveScriptRootBlueprint(blueprint, world))
    }
    refresh()
    const onModify = bp => {
      if (!bp?.id) return
      const baseId = getBlueprintAppName(app.data.blueprint)
      if (bp.id === app.data.blueprint || bp.id === baseId || bp.id === scriptRoot?.id) {
        refresh()
      }
    }
    world.blueprints.on('modify', onModify)
    world.blueprints.on('add', onModify)
    world.blueprints.on('remove', onModify)
    return () => {
      world.blueprints.off('modify', onModify)
      world.blueprints.off('add', onModify)
      world.blueprints.off('remove', onModify)
    }
  }, [app.data.blueprint, world, scriptRoot?.id])
  useEffect(() => {
    setAiPrompt('')
    setAiMode('edit')
    setAiStatus(null)
    setAiAttachments([])
    setAiMention(null)
    aiRequestRef.current = null
  }, [moduleRoot?.id])
  useEffect(() => {
    let active = true
    const apiUrl = world.network?.apiUrl
    if (!apiUrl) {
      setAiDocsIndex([])
      return () => {}
    }
    const loadDocs = async () => {
      try {
        const response = await fetch(`${apiUrl}/ai-docs-index`)
        if (!response.ok) {
          throw new Error('docs_index_failed')
        }
        const data = await response.json()
        if (!active) return
        const files = Array.isArray(data?.files) ? data.files.filter(Boolean) : []
        setAiDocsIndex(files)
      } catch (err) {
        if (!active) return
        setAiDocsIndex([])
      }
    }
    loadDocs()
    return () => {
      active = false
    }
  }, [world.network?.apiUrl])
  useEffect(() => {
    if (aiMode === 'fix' && !scriptError) {
      setAiMode('edit')
    }
  }, [aiMode, scriptError])
  useEffect(() => {
    if (aiMode !== 'edit') {
      setAiMention(null)
    }
  }, [aiMode])
  useEffect(() => {
    if (aiPending || aiHasProposal || aiStatus?.type === 'error') {
      setAiExpanded(true)
    }
  }, [aiPending, aiHasProposal, aiStatus?.type])
  useEffect(() => {
    if (!aiHasProposal && aiStatus?.type === 'ready') {
      setAiStatus(null)
    }
  }, [aiHasProposal, aiStatus?.type])
  useEffect(() => {
    const onRequest = payload => {
      if (!payload) return
      const rootId = typeof payload.scriptRootId === 'string' ? payload.scriptRootId : null
      if (moduleRoot?.id && rootId && rootId !== moduleRoot.id) return
      aiRequestRef.current = payload.requestId || null
      const mode = payload.mode === 'fix' ? 'fix' : 'edit'
      setAiMode(mode)
      if (typeof payload.prompt === 'string') {
        setAiPrompt(payload.prompt)
      }
      setAiStatus({
        type: 'pending',
        message: mode === 'fix' ? 'Fixing script error...' : 'Generating changes...',
      })
      setAiExpanded(true)
    }
    const onResponse = payload => {
      if (!payload) return
      const rootId = typeof payload.scriptRootId === 'string' ? payload.scriptRootId : null
      if (moduleRoot?.id && rootId && rootId !== moduleRoot.id) return
      if (aiRequestRef.current && payload.requestId && payload.requestId !== aiRequestRef.current) return
      aiRequestRef.current = null
      if (payload.error) {
        setAiStatus({
          type: 'error',
          message: payload.message || 'AI request failed.',
        })
      } else {
        setAiStatus({
          type: 'ready',
          message: 'AI changes ready to review.',
          summary: payload.summary || '',
          source: payload.source || '',
          fileCount: payload.fileCount || 0,
        })
      }
      setAiExpanded(true)
    }
    world.on('script-ai-request', onRequest)
    world.on('script-ai-response', onResponse)
    return () => {
      world.off('script-ai-request', onRequest)
      world.off('script-ai-response', onResponse)
    }
  }, [world, moduleRoot?.id])
  const updateAiMention = useCallback(
    (value, caret) => {
      if (!aiFileIndex.length) {
        if (aiMention) setAiMention(null)
        return
      }
      const mention = getMentionState(value, caret)
      if (!mention) {
        if (aiMention) setAiMention(null)
        return
      }
      const items = fuzzyMatchList(mention.query, aiFileIndex).slice(0, 8)
      setAiMention(prev => {
        const nextIndex =
          prev && prev.query === mention.query ? prev.activeIndex : 0
        const bounded =
          items.length > 0 ? Math.min(nextIndex, items.length - 1) : 0
        return {
          open: true,
          query: mention.query,
          start: mention.start,
          end: caret,
          items,
          activeIndex: bounded,
        }
      })
    },
    [aiFileIndex, aiMention]
  )
  const addAiAttachment = useCallback(
    item => {
      if (!item?.type || !item?.path) return
      const key = `${item.type}:${item.path}`
      if (aiAttachmentSet.has(key)) {
        setAiMention(null)
        return
      }
      setAiAttachments(current => [...current, { type: item.type, path: item.path }])
      setAiMention(null)
      setAiPrompt(current => {
        if (!aiMention?.open) return current
        const before = current.slice(0, aiMention.start)
        const after = current.slice(aiMention.end)
        return `${before}${after}`
      })
      if (aiMention?.open && Number.isFinite(aiMention.start)) {
        const position = aiMention.start
        requestAnimationFrame(() => {
          const input = aiPromptRef.current
          if (!input) return
          input.focus()
          input.selectionStart = position
          input.selectionEnd = position
        })
      }
    },
    [aiAttachmentSet, aiMention]
  )
  const removeAiAttachment = useCallback(item => {
    if (!item?.type || !item?.path) return
    setAiAttachments(current =>
      current.filter(entry => entry.type !== item.type || entry.path !== item.path)
    )
  }, [])
  const sendAiEdit = useCallback(() => {
    if (aiAccessIssue) {
      setAiStatus({ type: 'error', message: aiAccessIssue })
      return
    }
    if (!world.aiScripts?.requestEdit) {
      setAiStatus({ type: 'error', message: 'AI scripts are not available in this session.' })
      return
    }
    if (aiPending || aiHasProposal) {
      setAiStatus({
        type: 'error',
        message: 'Apply or discard the current AI changes before requesting new ones.',
      })
      return
    }
    const trimmed = aiPrompt.trim()
    if (!trimmed) {
      setAiStatus({ type: 'error', message: 'Enter a prompt to request edits.' })
      return
    }
    const requestId = world.aiScripts.requestEdit({
      prompt: trimmed,
      app,
      attachments: aiAttachmentPayload,
    })
    if (!requestId) return
    aiRequestRef.current = requestId
    setAiStatus({ type: 'pending', message: 'Generating changes...' })
    setAiExpanded(true)
  }, [aiAccessIssue, aiPending, aiHasProposal, aiPrompt, world, app, aiAttachmentPayload])
  const sendAiFix = useCallback(() => {
    if (aiAccessIssue) {
      setAiStatus({ type: 'error', message: aiAccessIssue })
      return
    }
    if (!world.aiScripts?.requestFix) {
      setAiStatus({ type: 'error', message: 'AI scripts are not available in this session.' })
      return
    }
    if (aiPending || aiHasProposal) {
      setAiStatus({
        type: 'error',
        message: 'Apply or discard the current AI changes before requesting new ones.',
      })
      return
    }
    if (!scriptError) {
      setAiStatus({ type: 'error', message: 'No script error detected.' })
      return
    }
    const requestId = world.aiScripts.requestFix({ app, attachments: aiAttachmentPayload })
    if (!requestId) return
    aiRequestRef.current = requestId
    setAiStatus({ type: 'pending', message: 'Fixing script error...' })
    setAiExpanded(true)
  }, [aiAccessIssue, aiPending, aiHasProposal, scriptError, world, app, aiAttachmentPayload])
  const sendAiRequest = useCallback(() => {
    if (aiMode === 'fix') {
      sendAiFix()
    } else {
      sendAiEdit()
    }
  }, [aiMode, sendAiFix, sendAiEdit])
  const handlePromptChange = useCallback(
    e => {
      const value = e.target.value
      if (aiStatus?.type === 'error') setAiStatus(null)
      setAiPrompt(value)
      updateAiMention(value, e.target.selectionStart)
    },
    [aiStatus?.type, updateAiMention]
  )
  const handlePromptKeyDown = useCallback(
    e => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'Enter' || e.code === 'Enter')) {
        e.preventDefault()
        sendAiEdit()
        return
      }
      if (!aiMention?.open) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAiMention(current => {
          if (!current) return current
          const next =
            current.activeIndex + 1 >= current.items.length
              ? 0
              : current.activeIndex + 1
          return { ...current, activeIndex: next }
        })
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAiMention(current => {
          if (!current) return current
          const next =
            current.activeIndex - 1 < 0
              ? Math.max(current.items.length - 1, 0)
              : current.activeIndex - 1
          return { ...current, activeIndex: next }
        })
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const selected = aiMention.items[aiMention.activeIndex]
        if (selected) {
          addAiAttachment(selected)
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setAiMention(null)
      }
    },
    [aiMention, addAiAttachment, sendAiEdit]
  )
  const handlePromptKeyUp = useCallback(
    e => {
      updateAiMention(e.currentTarget.value, e.currentTarget.selectionStart)
    },
    [updateAiMention]
  )
  useEffect(() => {
    const elem = resizeRef.current
    const container = containerRef.current
    container.style.width = `${storage.get('code-editor-width', 500)}px`
    let active
    function onPointerDown(e) {
      active = true
      elem.addEventListener('pointermove', onPointerMove)
      elem.addEventListener('pointerup', onPointerUp)
      e.currentTarget.setPointerCapture(e.pointerId)
    }
    function onPointerMove(e) {
      let newWidth = container.offsetWidth + e.movementX
      if (newWidth < 250) newWidth = 250
      container.style.width = `${newWidth}px`
      storage.set('code-editor-width', newWidth)
    }
    function onPointerUp(e) {
      e.currentTarget.releasePointerCapture(e.pointerId)
      elem.removeEventListener('pointermove', onPointerMove)
      elem.removeEventListener('pointerup', onPointerUp)
    }
    elem.addEventListener('pointerdown', onPointerDown)
    return () => {
      elem.removeEventListener('pointerdown', onPointerDown)
    }
  }, [])
  return (
    <div
      ref={containerRef}
      className={cls('script', { hidden })}
      css={css`
        pointer-events: auto;
        align-self: stretch;
        background: rgba(11, 10, 21, 0.9);
        border: 1px solid rgba(255, 255, 255, 0.05);
        border-radius: 1.375rem;
        display: flex;
        flex-direction: column;
        align-items: stretch;
        min-height: 23.7rem;
        position: relative;
        .script-head {
          height: 3.125rem;
          padding: 0 1rem;
          display: flex;
          align-items: center;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          gap: 0.75rem;
        }
        .script-title {
          flex: 1;
          font-weight: 500;
          font-size: 1rem;
          line-height: 1;
        }
        .script-note {
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.45);
          white-space: nowrap;
        }
        .script-actions {
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }
        .script-action {
          height: 2rem;
          padding: 0 0.75rem;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.15);
          background: transparent;
          color: rgba(255, 255, 255, 0.8);
          font-size: 0.8rem;
          &:hover {
            cursor: pointer;
            border-color: rgba(255, 255, 255, 0.3);
            color: white;
          }
          &:disabled {
            opacity: 0.5;
            cursor: default;
          }
        }
        .script-status {
          font-size: 0.75rem;
          padding: 0.5rem 1rem;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        }
        .script-status.error {
          color: #ff6b6b;
        }
        .script-status.conflict {
          color: #ffb74d;
        }
        .script-status.ai {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
          color: rgba(255, 255, 255, 0.85);
        }
        .script-ai-actions {
          display: flex;
          gap: 0.5rem;
        }
        .script-ai-action {
          height: 1.8rem;
          padding: 0 0.7rem;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.15);
          background: transparent;
          color: rgba(255, 255, 255, 0.8);
          font-size: 0.75rem;
          &:hover {
            cursor: pointer;
            border-color: rgba(255, 255, 255, 0.3);
            color: white;
          }
          &:disabled {
            opacity: 0.5;
            cursor: default;
          }
        }
        .script-ai-panel {
          padding: 0.75rem 1rem;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
        }
        .script-ai-panel-head {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          background: transparent;
          border: 0;
          padding: 0;
          color: inherit;
          text-align: left;
          &:hover {
            cursor: pointer;
          }
        }
        .script-ai-title {
          display: flex;
          align-items: center;
          gap: 0.35rem;
          font-size: 0.85rem;
          font-weight: 600;
          color: rgba(255, 255, 255, 0.85);
        }
        .script-ai-meta {
          margin-left: auto;
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.5);
        }
        .script-ai-meta.ready {
          color: #00a7ff;
        }
        .script-ai-meta.pending {
          color: rgba(255, 255, 255, 0.75);
        }
        .script-ai-meta.error {
          color: #ff6b6b;
        }
        .script-ai-toggle {
          width: 1.4rem;
          height: 1.4rem;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 0.4rem;
          border: 1px solid rgba(255, 255, 255, 0.15);
          color: rgba(255, 255, 255, 0.75);
        }
        .script-ai-toggle.open svg {
          transform: rotate(180deg);
        }
        .script-ai-panel-body {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
        }
        .script-ai-proposal {
          padding: 0.75rem;
          border-radius: 0.75rem;
          border: 1px solid rgba(0, 167, 255, 0.28);
          background: rgba(0, 167, 255, 0.08);
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }
        .script-ai-proposal-title {
          font-size: 0.75rem;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: rgba(255, 255, 255, 0.6);
        }
        .script-ai-proposal-summary {
          font-size: 0.85rem;
          color: rgba(255, 255, 255, 0.9);
        }
        .script-ai-proposal-meta {
          font-size: 0.7rem;
          color: rgba(255, 255, 255, 0.55);
        }
        .script-ai-modes {
          display: flex;
          gap: 0.5rem;
          flex-wrap: wrap;
        }
        .script-ai-mode {
          height: 1.8rem;
          padding: 0 0.75rem;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.15);
          background: transparent;
          color: rgba(255, 255, 255, 0.75);
          font-size: 0.75rem;
          &:hover {
            cursor: pointer;
            border-color: rgba(255, 255, 255, 0.3);
            color: white;
          }
          &:disabled {
            opacity: 0.4;
            cursor: default;
          }
        }
        .script-ai-mode.active {
          border-color: rgba(0, 167, 255, 0.5);
          color: #00a7ff;
          background: rgba(0, 167, 255, 0.12);
        }
        .script-ai-input {
          position: relative;
          border-radius: 0.75rem;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(8, 9, 14, 0.6);
          padding: 0.5rem 0.75rem;
        }
        .script-ai-input textarea {
          min-height: 4.75rem;
          resize: vertical;
          line-height: 1.45;
          font-size: 0.8rem;
          color: rgba(255, 255, 255, 0.9);
        }
        .script-ai-mentions {
          position: absolute;
          left: 0;
          right: 0;
          top: calc(100% + 0.35rem);
          background: rgba(8, 9, 14, 0.98);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 0.65rem;
          max-height: 12rem;
          overflow-y: auto;
          z-index: 5;
          padding: 0.35rem;
          box-shadow: 0 10px 25px rgba(0, 0, 0, 0.35);
        }
        .script-ai-mention-item {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.35rem 0.5rem;
          border-radius: 0.5rem;
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.8);
          cursor: pointer;
        }
        .script-ai-mention-item.active {
          background: rgba(0, 167, 255, 0.15);
          color: #00a7ff;
        }
        .script-ai-mention-item.disabled {
          opacity: 0.45;
          cursor: default;
        }
        .script-ai-mention-icon {
          display: flex;
          align-items: center;
          color: rgba(255, 255, 255, 0.65);
        }
        .script-ai-mention-path {
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .script-ai-mention-tag {
          font-size: 0.65rem;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.15);
          padding: 0.1rem 0.4rem;
          color: rgba(255, 255, 255, 0.6);
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .script-ai-mention-empty {
          padding: 0.45rem 0.6rem;
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.5);
        }
        .script-ai-attachments {
          display: flex;
          flex-direction: column;
          gap: 0.35rem;
        }
        .script-ai-attachment {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.3rem 0.5rem;
          border-radius: 0.5rem;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(8, 9, 14, 0.5);
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.8);
        }
        .script-ai-attachment-icon {
          display: flex;
          align-items: center;
          color: rgba(255, 255, 255, 0.6);
        }
        .script-ai-attachment-path {
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .script-ai-attachment-remove {
          border: 0;
          background: transparent;
          color: rgba(255, 255, 255, 0.6);
          font-size: 0.75rem;
          &:hover {
            cursor: pointer;
            color: white;
          }
        }
        .script-ai-error {
          border-radius: 0.75rem;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(8, 9, 14, 0.6);
          padding: 0.75rem;
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
        }
        .script-ai-error-title {
          font-size: 0.7rem;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: rgba(255, 255, 255, 0.55);
        }
        .script-ai-error-summary {
          font-size: 0.8rem;
          color: rgba(255, 255, 255, 0.85);
        }
        .script-ai-error-text {
          font-size: 0.7rem;
          white-space: pre-wrap;
          color: rgba(255, 255, 255, 0.55);
          max-height: 8rem;
          overflow: auto;
        }
        .script-ai-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.75rem;
          flex-wrap: wrap;
        }
        .script-ai-hint {
          font-size: 0.7rem;
          color: rgba(255, 255, 255, 0.45);
        }
        .script-ai-buttons {
          display: flex;
          gap: 0.5rem;
        }
        .script-ai-btn {
          height: 1.8rem;
          padding: 0 0.75rem;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.15);
          background: transparent;
          color: rgba(255, 255, 255, 0.8);
          font-size: 0.75rem;
          &:hover {
            cursor: pointer;
            border-color: rgba(255, 255, 255, 0.3);
            color: white;
          }
          &:disabled {
            opacity: 0.4;
            cursor: default;
          }
        }
        .script-ai-btn.primary {
          border-color: rgba(0, 167, 255, 0.5);
          color: #00a7ff;
        }
        .script-ai-status {
          font-size: 0.75rem;
          display: flex;
          align-items: center;
          gap: 0.4rem;
          color: rgba(255, 255, 255, 0.65);
        }
        .script-ai-status.pending {
          color: rgba(255, 255, 255, 0.75);
        }
        .script-ai-status.error {
          color: #ff6b6b;
        }
        .script-ai-spinner {
          animation: scriptAiSpin 1.1s linear infinite;
        }
        @keyframes scriptAiSpin {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }
        .script-resizer {
          position: absolute;
          top: 0;
          bottom: 0;
          right: -5px;
          width: 10px;
          cursor: ew-resize;
        }
        &.hidden {
          opacity: 0;
          pointer-events: none;
        }
      `}
    >
      <div className='script-head'>
        <div className='script-title'>Script: {app.blueprint?.name}</div>
        <div className='script-note'>
          {moduleRoot
            ? handle?.dirtyCount
              ? `${handle.dirtyCount} unsaved file${handle.dirtyCount === 1 ? '' : 's'}`
              : 'Module sources'
            : 'Code is managed by dev server'}
        </div>
        <div className='script-actions'>
          {moduleRoot && (
            <>
              <button
                className='script-action'
                type='button'
                disabled={!handle?.dirty || handle?.saving}
                onClick={() => handle?.save?.()}
              >
                {handle?.saving ? 'Saving...' : 'Save'}
              </button>
              <button
                className='script-action'
                type='button'
                disabled={handle?.saving || !handle?.refresh}
                onClick={() => handle?.refresh?.()}
              >
                Refresh
              </button>
              {handle?.conflict && (
                <button
                  className='script-action'
                  type='button'
                  disabled={handle?.saving}
                  onClick={() => handle?.retry?.()}
                >
                  Retry
                </button>
              )}
            </>
          )}
          <button className='script-action' type='button' onClick={() => handle?.copy?.()}>
            Copy
          </button>
        </div>
      </div>
      {moduleRoot && (handle?.error || handle?.conflict) && (
        <div className={cls('script-status', { error: handle?.error, conflict: handle?.conflict })}>
          {handle?.error || handle?.conflict}
        </div>
      )}
      {moduleRoot && (
        <div className='script-ai-panel'>
          <button
            className='script-ai-panel-head'
            type='button'
            onClick={() => setAiExpanded(open => !open)}
          >
            <div className='script-ai-title'>
              <SparkleIcon size='0.9rem' />
              AI Prompts
            </div>
            <div className={aiMetaClass}>{aiMeta}</div>
            <div className={cls('script-ai-toggle', { open: aiExpanded })}>
              <ChevronDownIcon size='1rem' />
            </div>
          </button>
          {aiExpanded && (
            <div className='script-ai-panel-body'>
              {aiHasProposal ? (
                <div className='script-ai-proposal'>
                  <div className='script-ai-proposal-title'>AI proposal ready</div>
                  <div className='script-ai-proposal-summary'>
                    {handle?.ai?.summary ||
                      `${handle?.ai?.fileCount || 0} file${
                        handle?.ai?.fileCount === 1 ? '' : 's'
                      } changed`}
                  </div>
                  <div className='script-ai-proposal-meta'>
                    {handle?.ai?.source ? `Source: ${handle.ai.source}` : 'Review and apply changes'}
                  </div>
                  <div className='script-ai-actions'>
                    <button
                      className='script-ai-action'
                      type='button'
                      onClick={() => handle?.ai?.togglePreview?.()}
                    >
                      {handle?.ai?.previewOpen ? 'Close Review' : 'Review'}
                    </button>
                    <button
                      className='script-ai-action'
                      type='button'
                      disabled={handle?.saving}
                      onClick={() => handle?.ai?.commit?.()}
                    >
                      Apply
                    </button>
                    <button
                      className='script-ai-action'
                      type='button'
                      disabled={handle?.saving}
                      onClick={() => handle?.ai?.discard?.()}
                    >
                      Discard
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className='script-ai-modes'>
                    <button
                      className={cls('script-ai-mode', { active: aiMode === 'edit' })}
                      type='button'
                      onClick={() => {
                        if (aiStatus?.type === 'error') setAiStatus(null)
                        setAiMode('edit')
                      }}
                    >
                      Edit
                    </button>
                    <button
                      className={cls('script-ai-mode', { active: aiMode === 'fix' })}
                      type='button'
                      disabled={!scriptError}
                      title={scriptError ? 'Fix the latest script error' : 'No script error detected'}
                      onClick={() => {
                        if (aiStatus?.type === 'error') setAiStatus(null)
                        setAiMode('fix')
                      }}
                    >
                      Fix Error
                    </button>
                  </div>
                  {aiMode === 'edit' ? (
                    <div className='script-ai-input'>
                      <textarea
                        ref={aiPromptRef}
                        value={aiPrompt}
                        disabled={!aiCanUse || aiPending}
                        placeholder='Describe the change you want the AI to make. Use @ to attach files.'
                        onChange={handlePromptChange}
                        onKeyDown={handlePromptKeyDown}
                        onKeyUp={handlePromptKeyUp}
                        onBlur={() => setAiMention(null)}
                      />
                      {aiMention?.open && (
                        <div className='script-ai-mentions' onMouseDown={e => e.preventDefault()}>
                          {aiMention.items.length ? (
                            aiMention.items.map((item, index) => {
                              const attached = aiAttachmentSet.has(item.id)
                              return (
                                <div
                                  key={item.id}
                                  className={cls('script-ai-mention-item', {
                                    active: index === aiMention.activeIndex,
                                    disabled: attached,
                                  })}
                                  onMouseDown={e => e.preventDefault()}
                                  onClick={() => {
                                    if (!attached) addAiAttachment(item)
                                  }}
                                >
                                  <span className='script-ai-mention-icon'>
                                    {item.type === 'doc' ? (
                                      <BookTextIcon size='0.85rem' />
                                    ) : (
                                      <CodeIcon size='0.85rem' />
                                    )}
                                  </span>
                                  <span className='script-ai-mention-path'>{item.path}</span>
                                  <span className='script-ai-mention-tag'>
                                    {attached ? 'attached' : item.type}
                                  </span>
                                </div>
                              )
                            })
                          ) : (
                            <div className='script-ai-mention-empty'>No matches</div>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className='script-ai-error'>
                      <div className='script-ai-error-title'>Latest script error</div>
                      <div className='script-ai-error-summary'>{errorInfo.title}</div>
                      {errorInfo.detail && (
                        <pre className='script-ai-error-text'>{errorInfo.detail}</pre>
                      )}
                    </div>
                  )}
                  {aiAttachments.length > 0 && (
                    <div className='script-ai-attachments'>
                      {aiAttachments.map(item => (
                        <div key={`${item.type}:${item.path}`} className='script-ai-attachment'>
                          <span className='script-ai-attachment-icon'>
                            {item.type === 'doc' ? (
                              <BookTextIcon size='0.75rem' />
                            ) : (
                              <CodeIcon size='0.75rem' />
                            )}
                          </span>
                          <span className='script-ai-attachment-path'>{item.path}</span>
                          <button
                            className='script-ai-attachment-remove'
                            type='button'
                            onClick={() => removeAiAttachment(item)}
                          >
                            x
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className='script-ai-footer'>
                    <div className='script-ai-hint'>
                      Entry: {entryPath || 'Unknown'} | {fileCount} file{fileCount === 1 ? '' : 's'} |{' '}
                      {scriptFormat}
                    </div>
                    <div className='script-ai-buttons'>
                      <button
                        className='script-ai-btn'
                        type='button'
                        disabled={!aiPrompt || aiPending}
                        onClick={() => {
                          setAiPrompt('')
                          if (aiStatus?.type === 'error') setAiStatus(null)
                          setAiMention(null)
                        }}
                      >
                        Clear
                      </button>
                      <button
                        className='script-ai-btn primary'
                        type='button'
                        disabled={!aiCanSend}
                        onClick={sendAiRequest}
                      >
                        {aiMode === 'fix' ? 'Fix Error' : 'Send Prompt'}
                      </button>
                    </div>
                  </div>
                  {aiAccessIssue && <div className='script-ai-status error'>{aiAccessIssue}</div>}
                  {aiPending && (
                    <div className='script-ai-status pending'>
                      <LoaderPinwheelIcon size='0.9rem' className='script-ai-spinner' />
                      {aiStatus?.message || 'Generating changes...'}
                    </div>
                  )}
                  {aiStatus?.type === 'error' && !aiAccessIssue && (
                    <div className='script-ai-status error'>{aiStatus.message}</div>
                  )}
                  {handle?.dirtyCount ? (
                    <div className='script-ai-status'>
                      You have unsaved edits. AI requests use the last saved code.
                    </div>
                  ) : null}
                </>
              )}
            </div>
          )}
        </div>
      )}
      {moduleRoot ? (
        <ScriptFilesEditor scriptRoot={moduleRoot} world={world} onHandle={setHandle} />
      ) : (
        <ScriptEditor key={app.data.id} app={app} onHandle={setHandle} />
      )}
      <div className='script-resizer' ref={resizeRef} />
    </div>
  )
}

function hasScriptFiles(blueprint) {
  return blueprint?.scriptFiles && typeof blueprint.scriptFiles === 'object' && !isArray(blueprint.scriptFiles)
}

function getBlueprintAppName(id) {
  if (typeof id !== 'string' || !id) return ''
  if (id === '$scene') return '$scene'
  const idx = id.indexOf('__')
  return idx === -1 ? id : id.slice(0, idx)
}

function resolveScriptRootBlueprint(blueprint, world) {
  if (!blueprint) return null
  const scriptRef = typeof blueprint.scriptRef === 'string' ? blueprint.scriptRef.trim() : ''
  if (scriptRef) {
    const scriptRoot = world.blueprints.get(scriptRef)
    if (!scriptRoot) return null
    return scriptRoot
  }
  if (hasScriptFiles(blueprint)) return blueprint
  const appName = getBlueprintAppName(blueprint.id)
  if (appName && appName !== blueprint.id) {
    const baseBlueprint = world.blueprints.get(appName)
    if (hasScriptFiles(baseBlueprint)) return baseBlueprint
  }
  const groupMain = getScriptGroupMain(buildScriptGroups(world.blueprints.items), blueprint)
  if (groupMain && hasScriptFiles(groupMain)) return groupMain
  return null
}

function formatScriptError(error) {
  if (!error) {
    return { title: 'No script error detected.', detail: '' }
  }
  const name = error.name || 'Error'
  const message = error.message || ''
  const title = message ? `${name}: ${message}` : name
  const locationParts = []
  if (error.fileName) {
    locationParts.push(error.fileName)
  }
  if (error.lineNumber) {
    locationParts.push(error.lineNumber)
  }
  if (error.columnNumber) {
    locationParts.push(error.columnNumber)
  }
  const location = locationParts.length ? `at ${locationParts.join(':')}` : ''
  let detail = ''
  if (location) {
    detail = location
  }
  if (error.stack) {
    const lines = String(error.stack).split('\n').slice(0, 6).join('\n')
    detail = detail ? `${detail}\n${lines}` : lines
  }
  return { title, detail }
}

function getMentionState(value, caret) {
  if (typeof value !== 'string' || !Number.isFinite(caret)) return null
  const upto = value.slice(0, caret)
  const at = upto.lastIndexOf('@')
  if (at === -1) return null
  if (at > 0 && !/\s/.test(upto[at - 1])) return null
  const query = upto.slice(at + 1)
  if (/\s/.test(query)) return null
  return { start: at, query }
}

function fuzzyScore(query, text) {
  if (!text) return 0
  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  if (!lowerQuery) return 1
  let score = 0
  let index = 0
  for (let i = 0; i < lowerQuery.length; i += 1) {
    const ch = lowerQuery[i]
    const found = lowerText.indexOf(ch, index)
    if (found === -1) return 0
    score += found === index ? 3 : 1
    index = found + 1
  }
  if (lowerText.startsWith(lowerQuery)) score += 4
  return score + lowerQuery.length / Math.max(lowerText.length, 1)
}

function fuzzyMatchList(query, entries) {
  const scored = []
  for (const entry of entries) {
    const score = fuzzyScore(query, entry.path)
    if (!score) continue
    scored.push({ entry, score })
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.entry.path.localeCompare(b.entry.path)
  })
  return scored.map(item => item.entry)
}

function Nodes({ world, hidden }) {
  const app = world.ui.state.app
  return (
    <Pane hidden={hidden}>
      <div
        className='nodes'
        css={css`
          flex: 1;
          background: rgba(11, 10, 21, 0.9);
          border: 1px solid rgba(255, 255, 255, 0.05);
          border-radius: 1.375rem;
          min-height: 23.7rem;
          display: flex;
          flex-direction: column;
          .nodes-head {
            height: 3.125rem;
            padding: 0 1rem;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            display: flex;
            align-items: center;
          }
          .nodes-title {
            font-weight: 500;
            font-size: 1rem;
            line-height: 1;
          }
        `}
      >
        <div className='nodes-head'>
          <div className='nodes-title'>Nodes</div>
        </div>
        <NodeHierarchy app={app} />
      </div>
    </Pane>
  )
}

function Meta({ world, hidden }) {
  const app = world.ui.state.app
  const [blueprint, setBlueprint] = useState(app.blueprint)
  useEffect(() => {
    window.app = app
    const onModify = bp => {
      if (bp.id === blueprint.id) setBlueprint(bp)
    }
    world.blueprints.on('modify', onModify)
    return () => {
      world.blueprints.off('modify', onModify)
    }
  }, [])
  const set = async (key, value) => {
    const version = blueprint.version + 1
    world.blueprints.modify({ id: blueprint.id, version, [key]: value })
    world.admin.blueprintModify({ id: blueprint.id, version, [key]: value }, { ignoreNetworkId: world.network.id })
  }
  return (
    <Pane hidden={hidden}>
      <div
        className='meta'
        css={css`
          flex: 1;
          background: rgba(11, 10, 21, 0.9);
          border: 1px solid rgba(255, 255, 255, 0.05);
          border-radius: 1.375rem;
          display: flex;
          flex-direction: column;
          min-height: 1rem;
          .meta-head {
            height: 3.125rem;
            padding: 0 1rem;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            display: flex;
            align-items: center;
          }
          .meta-title {
            font-weight: 500;
            font-size: 1rem;
            line-height: 1;
          }
          .meta-content {
            flex: 1;
            overflow-y: auto;
            padding: 0.5rem 0;
          }
        `}
      >
        <div className='meta-head'>
          <div className='meta-title'>Metadata</div>
        </div>
        <div className='meta-content noscrollbar'>
          <FieldText
            label='Name'
            hint='The name of this app'
            value={blueprint.name}
            onChange={value => set('name', value)}
          />
          <FieldFile
            label='Image'
            hint='An image/icon for this app'
            kind='texture'
            value={blueprint.image}
            onChange={value => set('image', value)}
            world={world}
          />
          <FieldText
            label='Author'
            hint='The name of the author that made this app'
            value={blueprint.author}
            onChange={value => set('author', value)}
          />
          <FieldText
            label='URL'
            hint='A url for this app'
            value={blueprint.url}
            onChange={value => set('url', value)}
          />
          <FieldTextarea
            label='Description'
            hint='A description for this app'
            value={blueprint.desc}
            onChange={value => set('desc', value)}
          />
        </div>
      </div>
    </Pane>
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
function Players({ world, hidden, livePlayers, setLivePlayers }) {
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
    // behind player 0.6m (capsule size)
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
