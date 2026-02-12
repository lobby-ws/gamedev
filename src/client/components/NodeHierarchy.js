import { css } from '@firebolt-dev/css'
import {
  BlendIcon,
  BoxIcon,
  CircleIcon,
  DumbbellIcon,
  EyeIcon,
  FolderIcon,
  MagnetIcon,
  PersonStandingIcon,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { cls } from './cls'

export function NodeHierarchy({ app }) {
  const [selectedNode, setSelectedNode] = useState(null)
  const rootNode = useMemo(() => app.getNodes(), [])

  useEffect(() => {
    if (rootNode && !selectedNode) {
      setSelectedNode(rootNode)
    }
  }, [rootNode])

  // Helper function to safely get vector string
  const getVectorString = vec => {
    if (!vec || typeof vec.x !== 'number') return null
    return `${vec.x.toFixed(2)}, ${vec.y.toFixed(2)}, ${vec.z.toFixed(2)}`
  }

  // Helper function to safely check if a property exists
  const hasProperty = (obj, prop) => {
    try {
      return obj && typeof obj[prop] !== 'undefined'
    } catch (err) {
      return false
    }
  }

  return (
    <div
      className='nodehierarchy noscrollbar'
      css={css`
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        padding-top: 0.5rem;
        .nodehierarchy-tree {
          flex: 1;
          padding: 0 1rem;
          overflow-y: auto;
          margin-bottom: 1.25rem;
        }
        .nodehierarchy-item {
          display: flex;
          align-items: center;
          padding: 0.25rem 0.375rem;
          border-radius: 0.325rem;
          font-size: 0.9375rem;
          cursor: pointer;
          &:hover {
            color: #00a7ff;
          }
          &.selected {
            color: #00a7ff;
            background: rgba(0, 167, 255, 0.1);
          }
          svg {
            margin-right: 0.5rem;
            opacity: 0.5;
            flex-shrink: 0;
          }
          span {
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          &-indent {
            margin-left: 1.25rem;
          }
        }
        .nodehierarchy-empty {
          color: rgba(255, 255, 255, 0.5);
          text-align: center;
          padding: 1rem;
        }
        .nodehierarchy-details {
          flex-shrink: 0;
          border-top: 0.0625rem solid rgba(255, 255, 255, 0.05);
          padding: 1rem;
          max-height: 40vh;
          overflow-y: auto;
        }
        .nodehierarchy-detail {
          display: flex;
          margin-bottom: 0.5rem;
          font-size: 0.9375rem;
          &-label {
            width: 6.25rem;
            color: rgba(255, 255, 255, 0.5);
            flex-shrink: 0;
          }
          &-value {
            flex: 1;
            word-break: break-word;
            &.copy {
              cursor: pointer;
            }
          }
        }
      `}
    >
      <div className='nodehierarchy-tree'>
        {rootNode ? (
          renderHierarchy([rootNode], 0, selectedNode, setSelectedNode)
        ) : (
          <div className='nodehierarchy-empty'>
            <LayersIcon size={24} />
            <div>No nodes found</div>
          </div>
        )}
      </div>

      {selectedNode && (
        <div className='nodehierarchy-details'>
          <HierarchyDetail label='ID' value={selectedNode.id} copy />
          <HierarchyDetail label='Name' value={selectedNode.name} />

          {/* Position */}
          {hasProperty(selectedNode, 'position') && getVectorString(selectedNode.position) && (
            <HierarchyDetail label='Position' value={getVectorString(selectedNode.position)} />
          )}

          {/* Rotation */}
          {hasProperty(selectedNode, 'rotation') && getVectorString(selectedNode.rotation) && (
            <HierarchyDetail label='Rotation' value={getVectorString(selectedNode.rotation)} />
          )}

          {/* Scale */}
          {hasProperty(selectedNode, 'scale') && getVectorString(selectedNode.scale) && (
            <HierarchyDetail label='Scale' value={getVectorString(selectedNode.scale)} />
          )}

          {/* Material */}
          {hasProperty(selectedNode, 'material') && selectedNode.material && (
            <>
              <HierarchyDetail label='Material' value={selectedNode.material.type || 'Standard'} />
              {hasProperty(selectedNode.material, 'color') && selectedNode.material.color && (
                <HierarchyDetail
                  label='Color'
                  value={
                    selectedNode.material.color.getHexString
                      ? `#${selectedNode.material.color.getHexString()}`
                      : 'Unknown'
                  }
                />
              )}
            </>
          )}

          {/* Geometry */}
          {hasProperty(selectedNode, 'geometry') && selectedNode.geometry && (
            <HierarchyDetail label='Geometry' value={selectedNode.geometry.type || 'Custom'} />
          )}
        </div>
      )}
    </div>
  )
}

function HierarchyDetail({ label, value, copy }) {
  let handleCopy = copy ? () => navigator.clipboard.writeText(value) : null
  return (
    <div className='nodehierarchy-detail'>
      <div className='nodehierarchy-detail-label'>{label}</div>
      <div className={cls('nodehierarchy-detail-value', { copy })} onClick={handleCopy}>
        {value}
      </div>
    </div>
  )
}

const nodeIcons = {
  default: CircleIcon,
  group: FolderIcon,
  mesh: BoxIcon,
  rigidbody: DumbbellIcon,
  collider: BlendIcon,
  lod: EyeIcon,
  avatar: PersonStandingIcon,
  snap: MagnetIcon,
}

function renderHierarchy(nodes, depth = 0, selectedNode, setSelectedNode) {
  if (!Array.isArray(nodes)) return null

  return nodes.map(node => {
    if (!node) return null

    // Skip the root node but show its children
    // if (depth === 0 && node.id === '$root') {
    //   return renderHierarchy(node.children || [], depth, selectedNode, setSelectedNode)
    // }

    // Safely get children
    const children = node.children || []
    const hasChildren = Array.isArray(children) && children.length > 0
    const isSelected = selectedNode?.id === node.id
    const Icon = nodeIcons[node.name] || nodeIcons.default

    return (
      <div key={node.id}>
        <div
          className={cls('nodehierarchy-item', {
            'nodehierarchy-item-indent': depth > 0,
            selected: isSelected,
          })}
          style={{ marginLeft: depth * 20 }}
          onClick={() => setSelectedNode(node)}
        >
          <Icon size={14} />
          <span>{node.id === '$root' ? 'object' : node.id}</span>
        </div>
        {hasChildren && renderHierarchy(children, depth + 1, selectedNode, setSelectedNode)}
      </div>
    )
  })
}
