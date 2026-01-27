# Node

The base class for all other nodes.

## Properties

### `.id`: String

The ID of the node. This is auto generated when creating nodes via script. For GLTF models converted to nodes, it uses the same object name you would see in blender.

NOTE: Blender GLTF exporter does rename objects in some cases, eg by removing spaces. Best practice is to simply name everything in UpperCamelCase with no other characters.

### `.position`: Vector3

The local position of the node.

### `.quaternion`: Quaternion

The local quaternion rotation of the node. Updating this automatically updates the `rotation` property.

### `.rotation`: Euler

The local euler rotation of the node. Updating this automatically updates the `quaternion` property.

### `.scale`: Vector3

The local scale of the node.

### `.matrixWorld`: Matrix4

The world matrix of this node in global space.

### `.parent`: Node

The parent node, if any.

### `.children`: [Node]

The child nodes.

## Methods

### `.add(otherNode)`: Self

Adds `otherNode` as a child of this node.

### `.remove(otherNode)`: Self

Removes `otherNode` if it is a child of this node.

### `.traverse(callback)`

Traverses this and all descendents calling `callback` with the node in the first argument.

## Pointer Events

All pointer event callbacks receive an event object with the following properties:
- `type`: String - The event type (`'pointerenter'`, `'pointerleave'`, `'pointerdown'`, or `'pointerup'`)
- `stopPropagation()`: Function - Call to prevent the event from bubbling to parent nodes

### `.onPointerEnter`: Function

Callback function that is called when the pointer enters this node.

### `.onPointerLeave`: Function

Callback function that is called when the pointer leaves this node.

### `.onPointerDown`: Function

Callback function that is called when the pointer button is pressed down on this node.

### `.onPointerUp`: Function

Callback function that is called when the pointer button is released on this node.

## Examples

### Pointer Events

```javascript
const box = app.create('prim', {
  type: 'box',
  size: [1, 1, 1],
  color: 'blue',
})

box.onPointerEnter = () => {
  box.color = 'red'
}
```



