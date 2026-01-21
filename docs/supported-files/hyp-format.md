# .hyp File Format

The `.hyp` file format bundles a blueprint configuration with its associated assets so apps can be exported and re-imported.

You can:
- Export from the in-world App menu via `Download`.
- Import by drag-and-dropping a `.hyp` file into the viewport.

## File Structure

A `.hyp` file consists of three sections:

1. Header Size (4 bytes)
   - Uint32 (little-endian) indicating the size of the header JSON in bytes
2. Header (JSON)
   - Contains the `blueprint` and `assets` metadata
3. Asset Data
   - Raw bytes for each asset concatenated in order

## Header Format

The header JSON has this shape:

```json
{
  "blueprint": {
    "name": "string",
    "model": "string (optional)",
    "script": "string (optional)",
    "image": "string|object (optional)",
    "props": {
      "[key]": {
        "type": "string (optional)",
        "url": "string"
      }
    }
  },
  "assets": [
    {
      "type": "model | avatar | script | texture | image | hdr | video | audio",
      "url": "string",
      "size": "number",
      "mime": "string"
    }
  ]
}
```

## Binary Layout

```
[Header Size (4 bytes)][Header JSON (variable size)][Asset1 Data][Asset2 Data]...
```

## Usage

```js
// Export
const hypFile = await exportApp(blueprint, resolveFile)

// Import
const { blueprint, assets } = await importApp(hypFile)
```

The header size is encoded in little-endian format.
