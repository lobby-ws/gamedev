# Water

Creates a reflective water surface using the three.js Water shader with real-time planar reflections and animated waves.

The water plane is oriented horizontally (XZ plane) by default.

## Properties

### `.width`: Number

The width of the water plane (X axis). Defaults to `10`.

### `.height`: Number

The depth of the water plane (Z axis). Defaults to `10`.

### `.color`: String

The base water body color as a hex string. Defaults to `#001e0f` (dark ocean green).

### `.sunColor`: String

The sun reflection color as a hex string. Defaults to `#ffffff`.

### `.sunDirection`: Array

The direction of the sun as `[x, y, z]`. Affects specular highlights and reflection. Defaults to `[0, 0, 0]`.

### `.distortionScale`: Number

The scale of wave distortion on the reflection. Higher values create more turbulent-looking water. Defaults to `2`.

### `.speed`: Number

The speed of wave animation. `0` is frozen, `0.1` is a calm default, `1` is fast. Defaults to `0.1`.

### `.alpha`: Number

The opacity of the water surface, from 0.0 (fully transparent) to 1.0 (fully opaque). Defaults to `1`.

### `.reflectivity`: Number

The base reflectivity of the water surface (Fresnel rf0), from 0.0 (no reflection) to 1.0 (full mirror). Defaults to `0.3`.

### `.textureSize`: Number

The resolution of the reflection render target in pixels. Higher values give sharper reflections but cost more performance. Defaults to `256`.

### `.normals`: String | null

URL or path to a water normals texture. This texture drives the wave pattern on the surface. If `null`, the built-in `waternormals.jpg` texture is used. Defaults to `null`.

### `.{...Node}`

Inherits all [Node](/docs/scripting/nodes/Node.md) properties

## Examples

```javascript
// Basic ocean water
const water = app.create('water', {
  width: 100,
  height: 100,
  position: [0, 0, 0],
  color: '#001e0f',
  sunColor: '#ffffff',
  sunDirection: [0.7, 0.7, 0],
  distortionScale: 2,
})
app.add(water)
```

## Notes

- The water plane is automatically oriented horizontally (rotation is handled internally). Use `position.y` to set the water level height.
- The water shader renders real-time planar reflections. This means the scene is rendered a second time from a mirrored camera each frame, which has a performance cost.
- Lower `textureSize` values (e.g., `256`) improve performance at the cost of reflection quality. `512` is a good balance.
- The `color`, `sunColor`, `sunDirection`, `distortionScale`, and `alpha` properties can be updated at runtime without rebuilding the water mesh.
- Changing `width`, `height`, `textureSize`, or `normals` triggers a rebuild. `speed` can be changed at runtime without rebuilding.
- The water surface does not include physics. To make it collidable, place an invisible static physics prim at the same position.
