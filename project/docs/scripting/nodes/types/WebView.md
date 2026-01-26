# WebView

Embeds an interactive iframe in either 3D world space or 2D screen space. WebViews support both rendering modes:

- **World Space**: Iframes positioned in 3D space using CSS3D rendering with proper depth occlusion, allowing 3D objects to pass in front naturally.
- **Screen Space**: Iframes positioned as 2D overlays using CSS absolute positioning, like traditional UI elements.

When players click on a WebView, their pointer is unlocked so they can interact with the iframe content (world space mode only).

## Properties

### `.space`: String ('world' | 'screen')

The rendering space for the WebView. Defaults to `'world'`.

- **`'world'`**: Renders the iframe in 3D space using CSS3D. The iframe can be positioned, rotated, and scaled like any 3D object. 3D objects can occlude the iframe. Requires `width` and `height` in meters.
- **`'screen'`**: Renders the iframe as a 2D overlay on the screen. The iframe is positioned using percentages and pixel offsets, like UI nodes. Requires `width` and `height` in pixels. The `position` property uses percentages (0-1 for x/y) and z for z-index.

**Important**: When changing `space`, you'll likely need to adjust `width`, `height`, and `position` values to match the new coordinate system.

### `.src`: String

A URL to load in the iframe. This can be any website that allows iframe embedding.

Note: Some websites block embedding via `X-Frame-Options` headers. For these cases, use the `.html` property instead.

### `.html`: String

Raw HTML content to embed directly in the iframe using the `srcdoc` attribute. This is useful for:
- Embedding widgets that don't allow direct URL access (e.g., TradingView)
- Creating custom HTML interfaces
- Bypassing X-Frame-Options restrictions

When both `.src` and `.html` are set, `.html` takes precedence.

### `.width`: Number

The width of the WebView surface. Defaults to `1`.

- **World space**: Width in meters (physical size in 3D world)
- **Screen space**: Width in pixels

### `.height`: Number

The height of the WebView surface. Defaults to `1`.

- **World space**: Height in meters (physical size in 3D world)
- **Screen space**: Height in pixels

### `.factor`: Number

**World space only.** The resolution scaling factor. Higher values produce sharper content but use more memory. Defaults to `100`.

The actual iframe pixel dimensions are calculated as: `width * factor` by `height * factor`.

For high-detail content like charts or text, use values between `150-300`. For simple content, `100` is sufficient.

This property has no effect in screen space mode.

### `.doubleside`: Boolean

**World space only.** Whether the WebView should render on both sides of the plane. Defaults to `false` (single-sided).

When `true`, the iframe content is visible from both the front and back of the plane. When `false`, it's only visible from the front.

This property has no effect in screen space mode.

### `.onPointerDown`: Function

**World space only.** Callback function triggered when a player clicks on the WebView.

By default, clicking unlocks the pointer to allow iframe interaction. In build mode, pointer unlocking is automatically prevented. You can override this behavior by setting a custom `onPointerDown` handler and calling `e.preventDefault()`.

In screen space mode, the iframe is always interactive and pointer events work like regular DOM elements.

```javascript
webview.onPointerDown = (e) => {
  console.log('WebView clicked')
  e.preventDefault() // Prevents default pointer unlock behavior
}
```

### `.{...Node}`

Inherits all [Node](/docs/scripting/nodes/Node.md) properties

## Examples

### Basic Website Embed

```javascript
const webview = app.create('webview', {
  src: 'https://example.com',
  width: 2,
  height: 1.5,
  position: [0, 1.5, 0],
})
app.add(webview)
```

### TradingView Widget

```javascript
const webview = app.create('webview', {
  html: `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        * { margin: 0; padding: 0; }
        html, body { width: 100%; height: 100%; overflow: hidden; }
      </style>
    </head>
    <body>
      <div class="tradingview-widget-container" style="height:100%;width:100%">
        <div class="tradingview-widget-container__widget" style="height:100%;width:100%"></div>
        <script type="text/javascript" src="https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js" async>
        {
          "autosize": true,
          "symbol": "NASDAQ:AAPL",
          "interval": "D",
          "timezone": "Etc/UTC",
          "theme": "dark",
          "style": "1",
          "locale": "en",
          "toolbar_bg": "#f1f3f6",
          "enable_publishing": false,
          "allow_symbol_change": true,
          "container_id": "tradingview_widget"
        }
        </script>
      </div>
    </body>
    </html>
  `,
  width: 3.2,
  height: 1.8,
  position: [0, 1.5, 0],
  factor: 200, // Higher resolution for readable charts
})
app.add(webview)
```

### High-Resolution Dashboard

```javascript
const dashboard = app.create('webview', {
  src: 'https://my-dashboard.com',
  width: 4,
  height: 2.25,
  position: [0, 2, -5],
  factor: 250, // Very high resolution for crisp text
})
app.add(dashboard)
```

### Interactive Portal Wall

```javascript
const wall = app.create('group')

const urls = [
  'https://news.ycombinator.com',
  'https://github.com/trending',
  'https://example.com/dashboard',
]

urls.forEach((url, i) => {
  const webview = app.create('webview', {
    src: url,
    width: 2,
    height: 1.5,
    position: [i * 2.5 - 2.5, 1.5, 0],
    factor: 150,
  })
  wall.add(webview)
})

app.add(wall)
```

### Double-Sided Display (World Space)

```javascript
// Create a WebView that's visible from both sides
const billboard = app.create('webview', {
  src: 'https://example.com/dashboard',
  width: 3,
  height: 2,
  position: [0, 2, 0],
  doubleside: true, // Visible from front and back
})
app.add(billboard)
```

### Screen Space HUD

```javascript
// Create a screen space WebView overlay
const hud = app.create('webview', {
  space: 'screen',
  src: 'https://example.com/stats',
  width: 400,    // pixels
  height: 300,   // pixels
  position: [0.02, 0.02, 100], // x%, y%, z-index
})
app.add(hud)
```

### Screen Space Fullscreen

```javascript
// Create a fullscreen browser overlay
const browser = app.create('webview', {
  space: 'screen',
  src: 'https://example.com',
  width: window.innerWidth,
  height: window.innerHeight,
  position: [0, 0, 50], // Top-left corner, z-index 50
})
app.add(browser)
```

### Switching Between World and Screen Space

```javascript
const webview = app.create('webview', {
  space: 'world',
  src: 'https://example.com',
  width: 2,      // meters for world space
  height: 1.5,   // meters for world space
  position: [0, 1.5, 0],
})
app.add(webview)

// Later, switch to screen space
webview.space = 'screen'
webview.width = 800    // pixels for screen space
webview.height = 600   // pixels for screen space
webview.position.set(0.5, 0.5, 10) // Center screen, z-index 10
```

## Notes

### World Space WebViews

- Use CSS3D rendering positioned behind the WebGL canvas, with a black mesh providing depth occlusion
- Automatically prevent pointer unlock when in build mode, allowing you to move them freely
- Pointer must be unlocked (by clicking) for interaction
- Support rotation, scaling, and 3D positioning
- 3D objects can properly occlude the iframe

### Screen Space WebViews

- Positioned as DOM overlays using CSS absolute positioning
- Always interactive - no pointer unlocking required
- Cannot be rotated or scaled in 3D
- Position uses percentages (0-1) for x/y, z for z-index
- Do not participate in 3D occlusion

### General

- The iframe content runs in a sandboxed environment with standard browser security policies
- For best performance, avoid creating too many WebViews (>10) in a single scene
- Content that uses heavy JavaScript or rendering may impact performance
