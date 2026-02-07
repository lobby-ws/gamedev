import { css } from '@firebolt-dev/css'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BoxIcon,
  BrickWall,
  BrickWallIcon,
  CrosshairIcon,
  EyeIcon,
  EyeOffIcon,
  FileCode2Icon,
  HardDriveIcon,
  HashIcon,
  LayoutGridIcon,
  PencilIcon,
  RotateCcwIcon,
  SearchIcon,
  SettingsIcon,
  TargetIcon,
  TriangleIcon,
  XIcon,
  ZapIcon,
} from 'lucide-react'

import { usePane } from './usePane'
import { cls } from './cls'
import { orderBy } from 'lodash-es'
import { formatBytes } from '../../core/extras/formatBytes'
import { areBlueprintsTwinUnique, buildScriptGroups } from '../../core/extras/blueprintGroups'

export function AppsPane({ world, close }) {
  const paneRef = useRef()
  const headRef = useRef()
  usePane('apps', paneRef, headRef)
  const [tab, setTab] = useState('instances')
  const [query, setQuery] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const onChange = () => setRefresh(n => n + 1)
    world.blueprints.on('add', onChange)
    world.blueprints.on('modify', onChange)
    world.blueprints.on('remove', onChange)
    return () => {
      world.blueprints.off('add', onChange)
      world.blueprints.off('modify', onChange)
      world.blueprints.off('remove', onChange)
    }
  }, [])
  return (
    <div
      ref={paneRef}
      className='apane'
      css={css`
        position: absolute;
        top: 20px;
        left: 20px;
        width: 38rem;
        background-color: rgba(15, 16, 24, 0.8);
        pointer-events: auto;
        display: flex;
        flex-direction: column;
        font-size: 1rem;
        .apane-head {
          height: 3.125rem;
          background: black;
          display: flex;
          align-items: center;
          padding: 0 0.8125rem 0 1.25rem;
          &-title {
            font-size: 1.2rem;
            font-weight: 500;
            flex: 1;
          }
          &-search {
            width: 9.375rem;
            display: flex;
            align-items: center;
            svg {
              margin-right: 0.3125rem;
            }
            input {
              flex: 1;
              font-size: 1rem;
            }
          }
          &-btn {
            width: 1.875rem;
            height: 2.5rem;
            display: flex;
            align-items: center;
            justify-content: center;
            color: rgba(255, 255, 255, 0.5);
            &:hover {
              cursor: pointer;
              color: white;
            }
          }
        }
        .apane-tabs {
          display: flex;
          gap: 0.5rem;
          padding: 0.5rem 1.25rem;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }
        .apane-tab {
          border: 1px solid rgba(255, 255, 255, 0.15);
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
      `}
    >
      <div className='apane-head' ref={headRef}>
        <div className='apane-head-title'>Objects</div>
        <div className='apane-head-search'>
          <SearchIcon size={16} />
          <input type='text' placeholder='Search' value={query} onChange={e => setQuery(e.target.value)} />
        </div>
        <div className='apane-head-btn' onClick={() => setRefresh(n => n + 1)}>
          <RotateCcwIcon size={16} />
        </div>
        <div className='apane-head-btn' onClick={close}>
          <XIcon size={20} />
        </div>
      </div>
      <div className='apane-tabs'>
        <button
          type='button'
          className={cls('apane-tab', { active: tab === 'instances' })}
          onClick={() => setTab('instances')}
        >
          Instances
        </button>
        <button
          type='button'
          className={cls('apane-tab', { active: tab === 'variants' })}
          onClick={() => setTab('variants')}
        >
          Variants
        </button>
      </div>
      {tab === 'instances' ? (
        <AppsPaneContent world={world} query={query} refresh={refresh} setRefresh={setRefresh} />
      ) : (
        <AppsPaneVariants world={world} query={query} refresh={refresh} />
      )}
    </div>
  )
}

function AppsPaneContent({ world, query, refresh, setRefresh }) {
  const [sort, setSort] = useState('count')
  const [asc, setAsc] = useState(false)
  const [target, setTarget] = useState(null)
  let items = useMemo(() => {
    const itemMap = new Map() // id -> { blueprint, count }
    let items = []
    for (const [_, entity] of world.entities.items) {
      if (!entity.isApp) continue
      const blueprint = entity.blueprint
      if (!blueprint) continue // still loading?
      let item = itemMap.get(blueprint.id)
      if (!item) {
        let count = 0
        const type = blueprint.model.endsWith('.vrm') ? 'avatar' : 'model'
        const model = world.loader.get(type, blueprint.model)
        if (!model) continue
        const stats = model.getStats()
        const name = blueprint.name || '-'
        item = {
          blueprint,
          keywords: name.toLowerCase(),
          name,
          count,
          geometries: stats.geometries.size,
          triangles: stats.triangles,
          textureBytes: stats.textureBytes,
          textureSize: formatBytes(stats.textureBytes),
          code: blueprint.script ? 1 : 0,
          fileBytes: stats.fileBytes,
          fileSize: formatBytes(stats.fileBytes),
        }
        itemMap.set(blueprint.id, item)
      }
      item.count++
    }
    for (const [_, item] of itemMap) {
      items.push(item)
    }
    return items
  }, [refresh])
  items = useMemo(() => {
    let newItems = items
    if (query) {
      query = query.toLowerCase()
      newItems = newItems.filter(item => item.keywords.includes(query))
    }
    newItems = orderBy(newItems, sort, asc ? 'asc' : 'desc')
    return newItems
  }, [items, sort, asc, query])
  const reorder = key => {
    if (sort === key) {
      setAsc(!asc)
    } else {
      setSort(key)
      setAsc(false)
    }
  }
  useEffect(() => {
    return () => world.target.hide()
  }, [])
  const getClosest = item => {
    // find closest entity
    const playerPosition = world.rig.position
    let closestEntity
    let closestDistance = null
    for (const [_, entity] of world.entities.items) {
      if (entity.blueprint === item.blueprint) {
        const distance = playerPosition.distanceTo(entity.root.position)
        if (closestDistance === null || closestDistance > distance) {
          closestEntity = entity
          closestDistance = distance
        }
      }
    }
    return closestEntity
  }
  const toggleTarget = item => {
    if (target === item) {
      world.target.hide()
      setTarget(null)
      return
    }
    const entity = getClosest(item)
    if (!entity) return
    world.target.show(entity.root.position)
    setTarget(item)
  }
  const inspect = item => {
    const entity = getClosest(item)
    world.ui.setApp(entity)
    // world.ui.setMenu({ type: 'app', app: entity })
  }
  const toggle = item => {
    const blueprint = world.blueprints.get(item.blueprint.id)
    const version = blueprint.version + 1
    const disabled = !blueprint.disabled
    world.blueprints.modify({ id: blueprint.id, version, disabled })
    world.admin.blueprintModify({ id: blueprint.id, version, disabled }, { ignoreNetworkId: world.network.id })
    setRefresh(n => n + 1)
  }
  return (
    <div
      className='asettings'
      css={css`
        flex: 1;
        padding: 1.25rem 1.25rem 0;
        .asettings-head {
          position: sticky;
          top: 0;
          display: flex;
          align-items: center;
          margin: 0 0 0.3125rem;
        }
        .asettings-headitem {
          font-size: 1rem;
          font-weight: 500;
          white-space: nowrap;
          text-overflow: ellipsis;
          overflow: hidden;
          &.name {
            flex: 1;
          }
          &.code {
            width: 3rem;
            text-align: right;
          }
          &.count,
          &.geometries,
          &.triangles {
            width: 4rem;
            text-align: right;
          }
          &.textureSize,
          &.fileSize {
            width: 5rem;
            text-align: right;
          }
          &.actions {
            width: 5.45rem;
            text-align: right;
          }
          &:hover:not(.active) {
            cursor: pointer;
          }
          &.active {
            color: #4088ff;
          }
        }
        .asettings-rows {
          overflow-y: auto;
          padding-bottom: 1.25rem;
          max-height: 18.75rem;
        }
        .asettings-row {
          display: flex;
          align-items: center;
          margin: 0 0 0.3125rem;
        }
        .asettings-rowitem {
          font-size: 1rem;
          color: rgba(255, 255, 255, 0.8);
          white-space: nowrap;
          text-overflow: ellipsis;
          overflow: hidden;
          &.name {
            flex: 1;
          }
          &.code {
            width: 3rem;
            text-align: right;
          }
          &.count,
          &.geometries,
          &.triangles {
            width: 4rem;
            text-align: right;
          }
          &.textureSize,
          &.fileSize {
            width: 5rem;
            text-align: right;
          }
          &.actions {
            width: 5.45rem;
            display: flex;
            justify-content: flex-end;
          }
        }
        .asettings-action {
          margin-left: 0.625rem;
          color: rgba(255, 255, 255, 0.4);
          &.active {
            color: #4088ff;
          }
          &.red {
            color: #fb4848;
          }
          &:hover {
            cursor: pointer;
          }
          &:hover:not(.active):not(.red) {
            color: white;
          }
        }
      `}
    >
      <div className='asettings-head'>
        <div
          className={cls('asettings-headitem name', { active: sort === 'name' })}
          onClick={() => reorder('name')}
          title='Name'
        >
          <span>Name</span>
        </div>
        <div
          className={cls('asettings-headitem count', { active: sort === 'count' })}
          onClick={() => reorder('count')}
          title='Instances'
        >
          <HashIcon size={16} />
        </div>
        <div
          className={cls('asettings-headitem geometries', { active: sort === 'geometries' })}
          onClick={() => reorder('geometries')}
          title='Geometries'
        >
          <BoxIcon size={16} />
        </div>
        <div
          className={cls('asettings-headitem triangles', { active: sort === 'triangles' })}
          onClick={() => reorder('triangles')}
          title='Triangles'
        >
          <TriangleIcon size={16} />
        </div>
        <div
          className={cls('asettings-headitem textureSize', { active: sort === 'textureBytes' })}
          onClick={() => reorder('textureBytes')}
          title='Texture Memory Size'
        >
          <BrickWallIcon size={16} />
        </div>
        <div
          className={cls('asettings-headitem code', { active: sort === 'code' })}
          onClick={() => reorder('code')}
          title='Code'
        >
          <FileCode2Icon size={16} />
        </div>
        <div
          className={cls('asettings-headitem fileSize', { active: sort === 'fileBytes' })}
          onClick={() => reorder('fileBytes')}
          title='File Size'
        >
          <HardDriveIcon size={16} />
        </div>
        <div className='asettings-headitem actions' />
      </div>
      <div className='asettings-rows noscrollbar'>
        {items.map(item => (
          <div key={item.blueprint.id} className='asettings-row'>
            <div className='asettings-rowitem name' onClick={() => target(item)}>
              <span>{item.name}</span>
            </div>
            <div className='asettings-rowitem count'>
              <span>{item.count}</span>
            </div>
            <div className='asettings-rowitem geometries'>
              <span>{item.geometries}</span>
            </div>
            <div className='asettings-rowitem triangles'>
              <span>{formatNumber(item.triangles)}</span>
            </div>
            <div className='asettings-rowitem textureSize'>
              <span>{item.textureSize}</span>
            </div>
            <div className='asettings-rowitem code'>
              <span>{item.code ? 'Yes' : 'No'}</span>
            </div>
            <div className='asettings-rowitem fileSize'>
              <span>{item.fileSize}</span>
            </div>
            <div className={'asettings-rowitem actions'}>
              <div className={cls('asettings-action', { red: item.blueprint.disabled })} onClick={() => toggle(item)}>
                {item.blueprint.disabled ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
              </div>
              <div className={cls('asettings-action', { active: target === item })} onClick={() => toggleTarget(item)}>
                <CrosshairIcon size={16} />
              </div>
              <div className={'asettings-action'} onClick={() => inspect(item)}>
                <SettingsIcon size={16} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function AppsPaneVariants({ world, query, refresh }) {
  const [mergingId, setMergingId] = useState(null)
  const groups = useMemo(() => {
    const built = buildScriptGroups(world.blueprints.items)
    let list = Array.from(built.groups.values()).filter(group => group.items.length > 1)
    if (query) {
      const q = query.toLowerCase()
      list = list.filter(group =>
        group.items.some(item => (item?.name || item?.id || '').toLowerCase().includes(q))
      )
    }
    list.sort((a, b) => {
      const aName = (a.main?.name || a.main?.id || '').toLowerCase()
      const bName = (b.main?.name || b.main?.id || '').toLowerCase()
      return aName.localeCompare(bName)
    })
    return list
  }, [refresh, query])

  const mergeVariant = async (main, variant) => {
    if (!main || !variant || variant.id === main.id) return
    if (!areBlueprintsTwinUnique(main, variant)) return
    const targets = []
    for (const entity of world.entities.items.values()) {
      if (entity?.isApp && entity.data.blueprint === variant.id) {
        targets.push(entity)
      }
    }
    const ok = await world.ui.confirm({
      title: 'Merge duplicate',
      message: `Merge "${variant.name || variant.id}" into "${main.name || main.id}"? ${targets.length} instance(s) will be repointed and the duplicate blueprint deleted.`,
      confirmText: 'Merge',
      cancelText: 'Cancel',
    })
    if (!ok) return
    if (world.builder?.ensureAdminReady && !world.builder.ensureAdminReady('Merge')) return
    setMergingId(variant.id)
    try {
      for (const entity of targets) {
        entity.modify({ blueprint: main.id })
        world.admin.entityModify({ id: entity.data.id, blueprint: main.id }, { ignoreNetworkId: world.network.id })
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
    <div
      className='apane-variants'
      css={css`
        flex: 1;
        overflow-y: auto;
        padding: 1rem 1.25rem 1.25rem;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        .apane-variant-group {
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 0.75rem;
          background: rgba(255, 255, 255, 0.03);
          padding: 0.75rem;
        }
        .apane-variant-head {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
          margin-bottom: 0.5rem;
        }
        .apane-variant-title {
          font-weight: 600;
          font-size: 0.95rem;
        }
        .apane-variant-script {
          font-size: 0.7rem;
          color: rgba(255, 255, 255, 0.55);
          word-break: break-all;
        }
        .apane-variant-list {
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
        }
        .apane-variant-row {
          display: flex;
          align-items: center;
          gap: 0.6rem;
          padding: 0.4rem 0.5rem;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 0.6rem;
          background: rgba(255, 255, 255, 0.02);
        }
        .apane-variant-name {
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 0.85rem;
        }
        .apane-variant-main {
          font-size: 0.7rem;
          color: rgba(255, 255, 255, 0.6);
          border: 1px solid rgba(255, 255, 255, 0.2);
          padding: 0.1rem 0.4rem;
          border-radius: 999px;
        }
        .apane-variant-merge {
          border: 1px solid rgba(255, 255, 255, 0.15);
          background: transparent;
          color: rgba(255, 255, 255, 0.75);
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
        .apane-variant-empty {
          font-size: 0.8rem;
          color: rgba(255, 255, 255, 0.5);
        }
      `}
    >
      {groups.length ? (
        groups.map(group => {
          const main = group.main
          if (!main) return null
          return (
            <div key={group.script} className='apane-variant-group'>
              <div className='apane-variant-head'>
                <div className='apane-variant-title'>{main.name || main.id}</div>
                <div className='apane-variant-script'>{group.script}</div>
              </div>
              <div className='apane-variant-list'>
                {group.items.map(variant => {
                  const isMain = variant.id === main.id
                  const canMerge = !isMain && areBlueprintsTwinUnique(main, variant)
                  const isMerging = mergingId === variant.id
                  return (
                    <div key={variant.id} className='apane-variant-row'>
                      <div className='apane-variant-name'>{variant.name || variant.id}</div>
                      {isMain && <div className='apane-variant-main'>Main</div>}
                      {!isMain && canMerge && (
                        <button
                          type='button'
                          className='apane-variant-merge'
                          onClick={() => mergeVariant(main, variant)}
                          disabled={mergingId && !isMerging}
                        >
                          {isMerging ? 'Merging...' : 'Merge'}
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })
      ) : (
        <div className='apane-variant-empty'>No variants found.</div>
      )}
    </div>
  )
}

function formatNumber(num) {
  if (num === null || num === undefined || isNaN(num)) {
    return '0'
  }
  const million = 1000000
  const thousand = 1000
  let result
  if (num >= million) {
    result = (num / million).toFixed(1) + 'M'
  } else if (num >= thousand) {
    result = (num / thousand).toFixed(1) + 'K'
  } else {
    result = Math.round(num).toString()
  }
  return result
    .replace(/\.0+([KM])?$/, '$1') // Replace .0K with K or .0M with M
    .replace(/(\.\d+[1-9])0+([KM])?$/, '$1$2') // Trim trailing zeros (1.50M → 1.5M)
}
