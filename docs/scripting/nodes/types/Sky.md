# Sky

Controls the sky, lighting, and fog for the environment.

When multiple Sky nodes exist, the last one mounted takes priority. Setting a property to `null` falls back to the base environment default.

## Properties

### `.bg`: String

URL to an equirectangular background image. Defaults to `null`.

### `.hdr`: String

URL to an HDR environment map used for reflections and lighting. Defaults to `null`.

### `.shader`: String

A GLSL fragment shader body for procedural skies. When set, takes priority over `.bg`. Max 8192 characters. Defaults to `null`.

Your code has access to:
- `direction` (vec3) - normalized world-space position on the sky sphere
- `vUv` (vec2) - UV coordinates
- `uTime` (float) - elapsed time in seconds
- `uResolution` (vec2) - viewport size in pixels
- Any custom uniforms defined in `.shaderUniforms`

Write to `color` (vec3) and optionally `alpha` (float, defaults to 1.0).

```glsl
sky.shader = `
  float t = 0.5 + 0.5 * direction.y;
  color = mix(vec3(0.9, 0.5, 0.2), vec3(0.1, 0.2, 0.6), t);
`
```

### `.shaderUniforms`: Object

Custom uniforms to pass to the shader. Values must be numbers or arrays of 2-4 numbers (mapped to float/vec2/vec3/vec4). Defaults to `null`.

```js
sky.shaderUniforms = { uCloudDensity: 0.5, uWindDir: [1, 0] }
```

### `.rotationY`: Number

Rotation of the sky and environment map around the Y axis in radians. Defaults to `null`.

### `.sunDirection`: Vector3

Direction of the sun light. Defaults to `null`.

### `.sunIntensity`: Number

Intensity of the sun light. Defaults to `null`.

### `.sunColor`: String

Color of the sun light as a CSS color string. Defaults to `null`.

### `.fogNear`: Number

Near distance for linear fog. Fog is only applied when `.fogNear`, `.fogFar`, and `.fogColor` are all set. Defaults to `null`.

### `.fogFar`: Number

Far distance for linear fog. Defaults to `null`.

### `.fogColor`: String

Color of the fog as a CSS color string. Defaults to `null`.

### `.{...Node}`

Inherits all [Node](/docs/scripting/nodes/Node.md) properties
