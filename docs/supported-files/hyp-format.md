# .hyp File Format Documentation

The `.hyp` file format is a custom binary format used for Hyperfy Apps that bundles a blueprint configuration with its associated assets.

## File Structure

A `.hyp` file consists of three main sections:

1. Header Size (4 bytes)
   - Uint32 value (little-endian) indicating the size of the header JSON in bytes

2. Header (JSON)
   - Contains two main objects:
     - `blueprint`: The app configuration
     - `assets`: Metadata for all bundled assets

3. Asset Data
   - Raw binary data of all assets concatenated sequentially

## Header Format

The header is a JSON object with the following structure:

```json
{
  "blueprint": {
    "name": "string",
    "model": "string (optional)",
    "script": "string (optional)",
    "scriptEntry": "string (optional)",
    "scriptFiles": {
      "[relativePath: string]": "string"
    },
    "scriptFormat": "string (optional)",
    "scriptRef": "string (optional)",
    "assetMap": {
      "[relativePath: string]": "string"
    },
    "props": {
      [key: string]: {
        "type": "string",
        "url": "string"
      }
    },
    "frozen": "boolean"
  },
  "assets": [
    {
      "type": "model | avatar | script",
      "url": "string",
      "size": "number",
      "mime": "string"
    }
  ]
}
```

### Blueprint Properties

- `name`: The name of the app (used for the output filename if not specified)
- `model`: (Optional) URL of the main 3D model file
- `script`: (Optional) URL of the app's script file
- `scriptEntry`: (Optional) App-relative module entry path within `apps/<AppName>/` (e.g. `index.js`).
- `scriptFiles`: (Optional) Map of app-relative module paths to canonical `asset://...` URLs.
- `scriptFormat`: (Optional) `module` or `legacy-body` to describe how the entry is interpreted.
- `scriptRef`: (Optional) Blueprint id that owns the shared `scriptFiles/scriptEntry/scriptFormat` for this app.
  - Variants (`App__Variant`) should set `scriptRef` to the shared script-root blueprint to avoid duplicating `scriptFiles`.
- `assetMap`: (Optional) Map of app-relative paths (e.g. `assets/foo.png`) to canonical `asset://...` URLs.
  - Used to make local app `.hyp` exports portable: runtime helpers like `app.asset('./assets/foo.png')` can return the bundled `asset://...` URL after import.
  - When absent, `app.asset()` may resolve to `app://...` only for live local apps.
- `props`: Object containing additional properties with associated assets
- `frozen`: Boolean flag indicating if the app is locked/frozen

### Asset Types

Assets can be of different types:
- `model`: 3D model files (e.g., .glb)
- `avatar`: VRM avatar files
- `script`: JavaScript files
- `file`: Generic bundled files (e.g. images/data files) that may not be pre-parsed by the loader but are included for portability

## File Operations

### Exporting

When creating a .hyp file:
1. The blueprint is cloned
2. All assets are collected from:
   - Main model file
   - Script file
   - `scriptFiles` module sources (if present)
   - Props with URLs
3. Header is created with blueprint and asset metadata
4. Header size is written as first 4 bytes
5. Header JSON is converted to bytes and written
6. All asset files are appended sequentially

### Importing

When reading a .hyp file:
1. First 4 bytes are read to determine header size
2. Header JSON is parsed from the next bytes
3. Remaining bytes are split into individual asset files based on size metadata
4. Returns an object containing:
   - The blueprint configuration
   - Array of asset files with their metadata

Import normalization:
- Legacy single-file scripts (no `scriptFiles`, or `scriptFormat: "legacy-body"`) are converted to module format on import.
- The entry becomes a module file with a default export, `scriptEntry`/`scriptFiles` are populated, and `scriptFormat` is set to `module`.
- The blueprint `script` field is updated to point at the new entry asset.
- The legacy script asset is replaced in the upload list when conversion happens.

## Usage Example

```javascript
// Export a .hyp file
const hypFile = await exportApp(blueprint, resolveFile)

// Import a .hyp file
const { blueprint, assets } = await importApp(hypFile)
```

## Binary Format Specification

```
[Header Size (4 bytes)][Header JSON (variable size)][Asset1 Data][Asset2 Data]...
```

The format uses little-endian encoding for the header size value.
