import { css } from '@firebolt-dev/css'
import { useEffect, useState } from 'react'
import { FieldFile, FieldText, FieldTextarea } from '../Fields'
import { Pane } from './Pane'

export function Meta({ world, hidden }) {
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
