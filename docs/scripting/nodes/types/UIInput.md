# UIInput

World-space text input rendered via CSS3D.

## Properties

### `.value`: String

The current input value.

### `.placeholder`: String

Placeholder text shown when the input is empty.

### `.disabled`: Boolean

Disables interaction when `true`.

### `.fontSize`: Number

Font size in CSS pixels. Defaults to `14`.

### `.type`: String

The HTML input `type` (e.g. `text`, `password`, `email`).

### `.width`: Number

The input width in pixels.

### `.height`: Number

The input height in pixels.

### `.factor`: Number

Pixel-to-world scale factor. World size is `width / factor` and `height / factor`.

### `.color`: String

Text color. Defaults to `#000000`.

### `.backgroundColor`: String

Input background color. Defaults to `#ffffff`.

### `.borderWidth`: Number

Border thickness in pixels. Defaults to `1`.

### `.borderColor`: String

Border color. Defaults to `#cccccc`.

### `.borderRadius`: Number

Border radius in pixels. Defaults to `4`.

### `.padding`: Number

Padding in pixels. Defaults to `8`.

### `.onFocus`: Function|null

Called when the input receives focus. Receives the current value as the first argument.

### `.onBlur`: Function|null

Called when the input loses focus. Receives the current value as the first argument.

### `.onChange`: Function|null

Called when the value changes. Receives the current value as the first argument.

### `.onSubmit`: Function|null

Called when the user presses Enter. Receives the current value as the first argument.

### `.{...Node}`

Inherits all [Node](/docs/scripting/nodes/Node.md) properties.

## Notes

- Clicking the input unlocks pointer lock and focuses it unless build mode is active.
- Escape blurs the input.

## Methods

### `.focus()`

Programmatically focus the input.

### `.blur()`

Programmatically blur the input.
