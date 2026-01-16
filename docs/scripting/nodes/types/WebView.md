# WebView

Embeds a live iframe into the world (CSS3D). Supports world-space and screen-space modes.

## Properties

### `.src`: String|null

The iframe URL to load. Use `null` to clear.

### `.html`: String|null

Inline HTML to load into the iframe. When set, it takes priority over `.src`.

### `.srcdoc`: String|null

Alias for `.html`.

### `.space`: Enum("world", "screen")

`world` places the WebView in 3D space with depth occlusion. `screen` places it as a screen overlay inside the UI layer.

### `.width`: Number

The WebView width. In world space this is in world units; in screen space it's in pixels.

### `.height`: Number

The WebView height. In world space this is in world units; in screen space it's in pixels.

### `.factor`: Number

Pixel density multiplier for world-space rendering. Higher values increase iframe resolution.

### `.doubleside`: Boolean

Render the occlusion plane double-sided. Defaults to `false`.

### `.pointerEvents`: Boolean

Whether the WebView can receive pointer interactions. Defaults to `true`.

### `.{...Node}`

Inherits all [Node](/docs/scripting/nodes/Node.md) properties.

## Notes

- WebViews do not render in immersive XR.
- In world space, clicking the WebView unlocks pointer lock unless build mode is active.
- In screen space, `position.x/y` are normalized and `position.z` controls stacking order.
