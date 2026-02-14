import { css } from '@firebolt-dev/css'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BoxIcon,
  BrickWallIcon,
  CrosshairIcon,
  FileCode2Icon,
  HardDriveIcon,
  HashIcon,
  OctagonXIcon,
  Rows3Icon,
  TriangleIcon,
} from 'lucide-react'

import { cls } from './cls'
import { orderBy } from 'lodash-es'
import { formatBytes } from '../../core/extras/formatBytes'

const defaultStats = {
  geometries: 0,
  triangles: 0,
  textureBytes: 0,
  fileBytes: 0,
}

export function AppsList({ world, query, perf, refresh, setRefresh }) {
  const [sort, setSort] = useState('count')
  const [asc, setAsc] = useState(false)
  const [target, setTarget] = useState(null)
  let items = useMemo(() => {
    const itemMap = new Map() // id -> { blueprint, count }
    let items = []
    for (const [_, entity] of world.entities.items) {
      if (!entity.isApp) continue
      const blueprint = world.blueprints.get(entity.data.blueprint)
      if (!blueprint) continue // still loading?
      if (!blueprint.model) continue // corrupt app?
      let item = itemMap.get(blueprint.id)
      if (!item) {
        let count = 0
        const type = blueprint.model.endsWith('.vrm') ? 'avatar' : 'model'
        const model = world.loader.get(type, blueprint.model)
        const stats = model?.getStats() || defaultStats
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
  useEffect(() => {
    function onChange() {
      setRefresh(n => n + 1)
    }
    world.entities.on('added', onChange)
    world.entities.on('removed', onChange)
    return () => {
      world.entities.off('added', onChange)
      world.entities.off('removed', onChange)
    }
  }, [])
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
  }
  const toggle = item => {
    const blueprint = world.blueprints.get(item.blueprint.id)
    const version = blueprint.version + 1
    const disabled = !blueprint.disabled
    world.blueprints.modify({ id: blueprint.id, version, disabled })
    world.admin.blueprintModify({ id: blueprint.id, version, disabled }, { ignoreNetworkId: world.network.id })
    setRefresh(n => n + 1)
  }
  const sortButtons = [
    { key: 'count', icon: HashIcon, title: 'Instances' },
    { key: 'geometries', icon: BoxIcon, title: 'Geometries' },
    { key: 'triangles', icon: TriangleIcon, title: 'Triangles' },
    { key: 'textureBytes', icon: BrickWallIcon, title: 'Texture Size' },
    { key: 'code', icon: FileCode2Icon, title: 'Code' },
    { key: 'fileBytes', icon: HardDriveIcon, title: 'File Size' },
  ]
  return (
    <div
      className='appslist'
      css={css`
        flex: 1;
        .appslist-sortbar {
          display: flex;
          align-items: center;
          gap: 0.25rem;
          padding: 0.5rem 1rem;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          margin: 0 0 0.3125rem;
        }
        .appslist-sortbtn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 1.75rem;
          height: 1.75rem;
          border-radius: 0.25rem;
          color: #5d6077;
          &:hover {
            cursor: pointer;
            color: rgba(255, 255, 255, 0.7);
            background: rgba(255, 255, 255, 0.05);
          }
          &.active {
            color: #4088ff;
          }
        }
        .appslist-row {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          padding: 0.6rem 1rem;
          &:hover {
            cursor: pointer;
            background: rgba(255, 255, 255, 0.03);
          }
        }
        .appslist-name {
          flex: 1;
          font-size: 1rem;
          color: rgba(255, 255, 255, 0.8);
          white-space: nowrap;
          text-overflow: ellipsis;
          overflow: hidden;
        }
        .appslist-actions {
          display: flex;
          justify-content: flex-end;
        }
        .appslist-action {
          margin-left: 0.625rem;
          color: #5d6077;
          &.active {
            color: white;
          }
          &:hover {
            cursor: pointer;
          }
        }
        .appslist-stats {
          width: 100%;
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.4);
          line-height: 1.4;
          margin-top: 0.2rem;
        }
      `}
    >
      {perf && (
        <div className='appslist-sortbar'>
          {sortButtons.map(btn => (
            <div
              key={btn.key}
              className={cls('appslist-sortbtn', { active: sort === btn.key })}
              onClick={() => reorder(btn.key)}
              title={btn.title}
            >
              <btn.icon size={14} />
            </div>
          ))}
        </div>
      )}
      <div className='appslist-rows'>
        {items.map(item => (
          <div key={item.blueprint.id} className='appslist-row'>
            <div className='appslist-name' onClick={() => inspect(item)}>
              <span>{item.name}</span>
            </div>
            <div className='appslist-actions'>
              {!item.blueprint.scene && (
                <>
                  <div
                    className={cls('appslist-action', { active: item.blueprint.disabled })}
                    onClick={() => toggle(item)}
                  >
                    <OctagonXIcon size='1rem' />
                  </div>
                  <div
                    className={cls('appslist-action', { active: target === item })}
                    onClick={() => toggleTarget(item)}
                  >
                    <CrosshairIcon size='1rem' />
                  </div>
                </>
              )}
            </div>
            {perf && (
              <div className='appslist-stats'>
                {item.count}x · {item.geometries} geo · {formatNumber(item.triangles)} tri · {item.textureSize} tex · {item.fileSize} file{item.code ? ' · code' : ''}
              </div>
            )}
          </div>
        ))}
      </div>
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
