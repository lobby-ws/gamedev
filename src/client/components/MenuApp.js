import { useEffect, useMemo, useState } from 'react'
import {
  Menu,
  MenuItemBack,
  MenuItemBtn,
  MenuItemCurve,
  MenuItemFile,
  MenuItemFileBtn,
  MenuItemNumber,
  MenuItemRange,
  MenuItemSwitch,
  MenuItemText,
  MenuItemTextarea,
  MenuItemToggle,
  MenuLine,
  MenuSection,
} from './Menu'
import { hashFile } from '../../core/utils-client'
import { isArray, isBoolean, isEqual, merge } from 'lodash-es'
import { css } from '@firebolt-dev/css'
import { RotateCcwIcon } from 'lucide-react'
import { buildScriptGroups, getScriptGroupMain } from '../../core/extras/blueprintGroups'

export function MenuApp({ world, app, blur }) {
  const [pages, setPages] = useState(() => ['index'])
  const [blueprint, setBlueprint] = useState(app.blueprint)
  const groupMain = getScriptGroupMain(buildScriptGroups(world.blueprints.items), blueprint)
  const menuTitle = blueprint.name || groupMain?.name || blueprint.id
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
  const pop = () => {
    const next = pages.slice()
    next.pop()
    setPages(next)
  }
  const push = page => {
    const next = pages.slice()
    next.push(page)
    setPages(next)
  }
  const page = pages[pages.length - 1]
  let Page
  if (page === 'index') Page = MenuAppIndex
  if (page === 'flags') Page = MenuAppFlags
  if (page === 'metadata') Page = MenuAppMetadata
  return (
    <Menu title={menuTitle} blur={blur}>
      <Page world={world} app={app} blueprint={blueprint} setBlueprint={setBlueprint} pop={pop} push={push} />
    </Menu>
  )
}

const extToType = {
  glb: 'model',
  vrm: 'avatar',
}
const allowedModels = ['glb', 'vrm']

function MenuAppIndex({ world, app, blueprint, setBlueprint, pop, push }) {
  const player = world.entities.player
  const frozen = blueprint.frozen // TODO: disable code editor, model change, metadata editing, flag editing etc
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
      if (setBlueprint) setBlueprint(forked)
      world.emit('toast', 'Model forked')
      return
    }
    // update blueprint locally (also rebuilds apps)
    const version = blueprint.version + 1
    world.blueprints.modify({ id: blueprint.id, version, model: url })
    // broadcast blueprint change to server + other clients
    world.admin.blueprintModify({ id: blueprint.id, version, model: url }, { ignoreNetworkId: world.network.id })
  }
  return (
    <>
      <MenuItemFields world={world} app={app} blueprint={blueprint} />
      {app.fields?.length > 0 && <MenuLine />}
      {!frozen && (
        <MenuItemFileBtn
          label='Model'
          hint='Change the model for this app'
          accept='.glb,.vrm'
          value={blueprint.model}
          onChange={changeModel}
        />
      )}
      {!frozen && <MenuItemBtn label='Code' hint='View code for this app' onClick={world.ui.toggleCode} />}
      {!frozen && <MenuItemBtn label='Flags' hint='View/edit flags for this app' onClick={() => push('flags')} nav />}
      <MenuItemBtn label='Metadata' hint='View/edit metadata for this app' onClick={() => push('metadata')} nav />
      <MenuItemBtn
        label='Delete'
        hint='Delete this app instance'
        onClick={() => {
          world.ui.setMenu(null)
          app.destroy(true)
        }}
      />
    </>
  )
}

function MenuItemFields({ world, app, blueprint }) {
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
        <MenuItemToggle
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
          <MenuItemField
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

function MenuItemField({ world, props, field, value, modify, showReset, onReset }) {
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
    return <MenuSection label={field.label} />
  }
  const wrap = content => {
    if (!showReset) return content
    return (
      <div
        className='menuitemfield'
        css={css`
          display: flex;
          align-items: stretch;
          .menuitemfield-main {
            flex: 1;
          }
          .menuitemfield-reset {
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
        <div className='menuitemfield-main'>{content}</div>
        <button
          type='button'
          className='menuitemfield-reset'
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
      <MenuItemText
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
      <MenuItemTextarea
        label={field.label}
        hint={field.hint}
        value={value}
        onChange={value => modify(field.key, value)}
      />
    )
  }
  if (field.type === 'number') {
    return wrap(
      <MenuItemNumber
        label={field.label}
        hint={field.hint}
        dp={field.dp}
        min={field.min}
        max={field.max}
        step={field.step}
        value={value}
        onChange={value => modify(field.key, value)}
      />
    )
  }
  if (field.type === 'file') {
    return wrap(
      <MenuItemFile
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
      <MenuItemSwitch
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
      <MenuItemSwitch
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
      <MenuItemToggle
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
      <MenuItemRange
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
      <MenuItemCurve
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
    return <MenuItemBtn label={field.label} hint={field.hint} onClick={field.onClick} />
  }
  return null
}

function MenuAppFlags({ world, app, blueprint, setBlueprint, pop, push }) {
  const player = world.entities.player
  const toggle = async (key, value) => {
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
        if (setBlueprint) setBlueprint(forked)
        return
      }
    }
    const version = blueprint.version + 1
    world.blueprints.modify({ id: blueprint.id, version, [key]: value })
    world.admin.blueprintModify({ id: blueprint.id, version, [key]: value }, { ignoreNetworkId: world.network.id })
  }
  return (
    <>
      <MenuItemBack hint='Go back to the main app details' onClick={pop} />
      <MenuItemToggle
        label='Preload'
        hint='Preload this app before players enter the world'
        value={blueprint.preload}
        onChange={value => toggle('preload', value)}
      />
      <MenuItemToggle
        label='Lock'
        hint='Lock the app so that after downloading it the model, script and metadata can no longer be edited'
        value={blueprint.locked}
        onChange={value => toggle('locked', value)}
      />
      <MenuItemToggle
        label='Unique'
        hint='When enabled, duplicates fork this template automatically.'
        value={blueprint.unique}
        onChange={value => toggle('unique', value)}
      />
    </>
  )
}

function MenuAppMetadata({ world, app, blueprint, pop, push }) {
  const player = world.entities.player
  const set = async (key, value) => {
    const version = blueprint.version + 1
    world.blueprints.modify({ id: blueprint.id, version, [key]: value })
    world.admin.blueprintModify({ id: blueprint.id, version, [key]: value }, { ignoreNetworkId: world.network.id })
  }
  return (
    <>
      <MenuItemBack hint='Go back to the main app details' onClick={pop} />
      <MenuItemText
        label='Name'
        hint='The name of this app'
        value={blueprint.name}
        onChange={value => set('name', value)}
      />
      <MenuItemFile
        label='Image'
        hint='An image/icon for this app'
        kind='texture'
        value={blueprint.image}
        onChange={value => set('image', value)}
        world={world}
      />
      <MenuItemText
        label='Author'
        hint='The name of the author that made this app'
        value={blueprint.author}
        onChange={value => set('author', value)}
      />
      <MenuItemText label='URL' hint='A url for this app' value={blueprint.url} onChange={value => set('url', value)} />
      <MenuItemTextarea
        label='Description'
        hint='A description for this app'
        value={blueprint.desc}
        onChange={value => set('desc', value)}
      />
    </>
  )
}
