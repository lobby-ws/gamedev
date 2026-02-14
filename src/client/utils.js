export function cls(...args) {
  let str = ''
  for (const arg of args) {
    if (typeof arg === 'string') {
      str += ' ' + arg
    } else if (typeof arg === 'object') {
      for (const key in arg) {
        const value = arg[key]
        if (value) str += ' ' + key
      }
    }
  }
  return str
}

function normalizeAssetBase(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.replace(/\/+$/, '')
}

export function assetPath(value) {
  if (typeof value !== 'string' || !value.trim()) return ''
  const pathname = value.startsWith('/') ? value : `/${value}`
  const base = normalizeAssetBase(globalThis?.env?.PUBLIC_ASSET_BASE)
  if (!base) return pathname
  return `${base}${pathname}`
}

// export const isTouch = !!navigator.userAgent.match(/OculusBrowser|iPhone|iPad|iPod|Android/i)

// if at least two indicators point to touch, consider it primarily touch-based:
const coarse = window.matchMedia('(pointer: coarse)').matches
const noHover = window.matchMedia('(hover: none)').matches
const hasTouch = navigator.maxTouchPoints > 0
export const isTouch = (coarse && hasTouch) || (noHover && hasTouch)
