import { css } from '@firebolt-dev/css'
import { useContext, useEffect, useMemo, useState } from 'react'
import {
  BoxIcon,
  ChevronsUpDownIcon,
  LoaderPinwheelIcon,
  OctagonXIcon,
  PinIcon,
  RotateCcwIcon,
  SparkleIcon,
  Trash2Icon,
} from 'lucide-react'
import { cls } from '../cls'
import { theme } from '../theme'
import { isArray, isBoolean, isEqual, merge } from 'lodash-es'
import { HintContext } from '../Hint'
import {
  FieldBtn,
  FieldColor,
  FieldCurve,
  FieldFile,
  FieldNumber,
  FieldRange,
  FieldSwitch,
  FieldText,
  FieldTextarea,
  FieldToggle,
  FieldVec3,
} from '../Fields'
import { hashFile } from '../../../core/utils-client'
import { downloadFile } from '../../../core/extras/downloadFile'
import { areBlueprintsTwinUnique, buildScriptGroups } from '../../../core/extras/blueprintGroups'
import { DEG2RAD, RAD2DEG } from '../../../core/extras/general'
import * as THREE from '../../../core/extras/three'
import { uuid } from '../../../core/utils'
import { Pane } from './Pane'
import { Group } from './Group'

const extToType = {
  glb: 'model',
  vrm: 'avatar',
}
const allowedModels = ['glb', 'vrm']
let showTransforms = false

const e1 = new THREE.Euler(0, 0, 0, 'YXZ')
const q1 = new THREE.Quaternion()

export function App({ world, hidden }) {
  const { setHint } = useContext(HintContext)
  const app = world.ui.state.app
  const [pinned, setPinned] = useState(app.data.pinned)
  const [transforms, setTransforms] = useState(showTransforms)
  const [blueprint, setBlueprint] = useState(app.blueprint)
  const [appTab, setAppTab] = useState('settings')
  const [mergingId, setMergingId] = useState(null)
  const [addingId, setAddingId] = useState(null)
  const [entityTick, setEntityTick] = useState(0)
  const [variantTick, setVariantTick] = useState(0)
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
  useEffect(() => {
    const refresh = () => setVariantTick(tick => tick + 1)
    world.blueprints.on('add', refresh)
    world.blueprints.on('modify', refresh)
    world.blueprints.on('remove', refresh)
    return () => {
      world.blueprints.off('add', refresh)
      world.blueprints.off('modify', refresh)
      world.blueprints.off('remove', refresh)
    }
  }, [world])
  useEffect(() => {
    const refresh = () => setEntityTick(tick => tick + 1)
    world.entities.on('added', refresh)
    world.entities.on('removed', refresh)
    return () => {
      world.entities.off('added', refresh)
      world.entities.off('removed', refresh)
    }
  }, [world])
  const usedBlueprintIds = useMemo(() => {
    const used = new Set()
    for (const entity of world.entities.items.values()) {
      if (entity?.isApp) {
        used.add(entity.data.blueprint)
      }
    }
    return used
  }, [world, entityTick])
  const scriptGroups = useMemo(() => buildScriptGroups(world.blueprints.items), [world, variantTick])
  const scriptGroup = scriptGroups.byId.get(blueprint.id) || null
  const variantMain = scriptGroup?.main || blueprint
  const variants = scriptGroup?.items?.length ? scriptGroup.items : [blueprint]
  const isVariantOrphan = variant =>
    !variant?.scene && !usedBlueprintIds.has(variant.id) && variant.keep !== true
  const visibleVariants = variants.filter(variant => !isVariantOrphan(variant))
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
    const hash = await hashFile(file)
    const filename = `${hash}.${ext}`
    const url = `asset://${filename}`
    const type = extToType[ext]
    world.loader.insert(type, url, file)
    await world.admin.upload(file)
    if (updateMode === 'fork') {
      if (!world.builder?.forkTemplateFromBlueprint) {
        world.emit('toast', 'Builder access required.')
        return
      }
      const forked = await world.builder.forkTemplateFromBlueprint(blueprint, 'Model fork', null, { model: url, skipNamePrompt: true })
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
    const version = blueprint.version + 1
    world.blueprints.modify({ id: blueprint.id, version, model: url })
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
  const addVariant = async variant => {
    if (!variant) return
    setAddingId(variant.id)
    const transform = world.builder.getSpawnTransform(true)
    world.builder.toggle(true)
    world.builder.control.pointer.lock()
    let spawnBlueprint = variant
    if (variant.unique) {
      spawnBlueprint = await world.builder.forkTemplateFromBlueprint(variant, 'Add', null, {})
      if (!spawnBlueprint) {
        setAddingId(null)
        return
      }
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
      const nextApp = world.entities.add(data)
      world.admin.entityAdd(data, { ignoreNetworkId: world.network.id })
      world.builder.select(nextApp)
      setAddingId(null)
    }, 100)
  }

  return (
    <Pane hidden={hidden}>
      <div
        className='app'
        css={css`
          background: ${theme.bgSection};
          border: 1px solid ${theme.borderLight};
          border-radius: ${theme.radius};
          display: flex;
          flex-direction: column;
          min-height: 1rem;
          .app-head {
            height: 3.125rem;
            padding: 0 1rem;
            border-bottom: 1px solid ${theme.borderLight};
            display: flex;
            align-items: center;
          }
          .app-tabs {
            padding: 0.45rem 1rem;
            display: flex;
            gap: 0.5rem;
            border-bottom: 1px solid ${theme.borderLight};
          }
          .app-tab {
            border: 1px solid rgba(255, 255, 255, 0.12);
            background: transparent;
            color: rgba(255, 255, 255, 0.6);
            font-size: 0.75rem;
            padding: 0.25rem 0.7rem;
            border-radius: ${theme.radiusSmall};
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
            border-bottom: 1px solid ${theme.borderLight};
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
            border-bottom: 1px solid ${theme.borderLight};
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
            border-radius: ${theme.radiusSmall};
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
            border-radius: ${theme.radiusSmall};
          }
          .app-variant-merge {
            border: 1px solid rgba(255, 255, 255, 0.12);
            background: transparent;
            color: rgba(255, 255, 255, 0.7);
            font-size: 0.7rem;
            padding: 0.2rem 0.55rem;
            border-radius: ${theme.radiusSmall};
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
          .app-variant-add {
            border: 1px solid rgba(76, 224, 161, 0.45);
            background: rgba(76, 224, 161, 0.1);
            color: rgba(255, 255, 255, 0.85);
            font-size: 0.7rem;
            padding: 0.2rem 0.55rem;
            border-radius: ${theme.radiusSmall};
            &:hover:not(:disabled) {
              cursor: pointer;
              color: white;
              border-color: rgba(76, 224, 161, 0.75);
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
              {visibleVariants.length ? (
                visibleVariants.map(variant => {
                  const isMain = variant.id === variantMain.id
                  const canMerge = !isMain && areBlueprintsTwinUnique(variantMain, variant)
                  const isMerging = mergingId === variant.id
                  return (
                    <div className='app-variant-row' key={variant.id}>
                      <div className='app-variant-name'>{variant.name || variant.id}</div>
                      {isMain && <div className='app-variant-main'>Main</div>}
                      <button
                        type='button'
                        className='app-variant-add'
                        onClick={() => addVariant(variant)}
                        disabled={addingId && addingId !== variant.id}
                      >
                        {addingId === variant.id ? 'Adding...' : 'Add'}
                      </button>
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
    const id = bp.id
    const version = bp.version + 1
    world.blueprints.modify({ id, version, props: newProps })
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
