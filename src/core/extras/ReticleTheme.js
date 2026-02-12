import { clamp } from '../utils'

const SHAPES = ['line', 'circle', 'dot', 'rect', 'arc']
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const MAX_LAYERS = 32

function sanitizeColor(value, fallback) {
  if (typeof value !== 'string') return fallback
  if (COLOR_RE.test(value)) return value
  return fallback
}

function num(value, min, max, fallback) {
  return typeof value === 'number' ? clamp(value, min, max) : fallback
}

function validateLayer(layer) {
  if (!layer || typeof layer !== 'object') return null
  if (!SHAPES.includes(layer.shape)) return null
  const base = {
    shape: layer.shape,
    color: sanitizeColor(layer.color, null),
    outlineColor: sanitizeColor(layer.outlineColor, null),
    outlineWidth: num(layer.outlineWidth, 0, 4, 0),
    opacity: num(layer.opacity, 0, 1, 1),
  }
  switch (layer.shape) {
    case 'line':
      return { ...base, length: num(layer.length, 1, 64, 8), gap: num(layer.gap, 0, 32, 0), angle: num(layer.angle, 0, 360, 0), thickness: num(layer.thickness, 0.5, 8, 1.5) }
    case 'circle':
      return { ...base, radius: num(layer.radius, 1, 64, 10), thickness: num(layer.thickness, 0.5, 8, 1.5) }
    case 'dot':
      return { ...base, radius: num(layer.radius, 0.5, 16, 2) }
    case 'rect':
      return { ...base, width: num(layer.width, 1, 64, 8), height: num(layer.height, 1, 64, 8), rx: num(layer.rx, 0, 32, 0), thickness: num(layer.thickness, 0.5, 8, 1.5) }
    case 'arc':
      return { ...base, radius: num(layer.radius, 1, 64, 10), startAngle: num(layer.startAngle, -360, 360, -30), endAngle: num(layer.endAngle, -360, 360, 30), thickness: num(layer.thickness, 0.5, 8, 1.5) }
    default:
      return null
  }
}

export function validateReticle(input) {
  if (!input || typeof input !== 'object') return null
  const result = {
    spread: num(input.spread, 0, 64, 0),
    color: sanitizeColor(input.color, '#FFFFFF'),
    opacity: num(input.opacity, 0, 1, 1),
    layers: [],
  }
  if (Array.isArray(input.layers)) {
    for (let i = 0; i < Math.min(input.layers.length, MAX_LAYERS); i++) {
      const layer = validateLayer(input.layers[i])
      if (layer) result.layers.push(layer)
    }
  }
  return result
}
