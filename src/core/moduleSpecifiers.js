import { isValidScriptPath } from './blueprintValidation'

const MODULE_PREFIX = 'app://'
const SHARED_PREFIX = '@shared/'
const SHARED_ALIAS_PREFIX = 'shared/'

export function buildModuleSpecifier({ blueprintId, version, relPath }) {
  return `${MODULE_PREFIX}${blueprintId}@${version}/${relPath}`
}

export function parseModuleSpecifier(specifier) {
  if (typeof specifier !== 'string' || !specifier.startsWith(MODULE_PREFIX)) return null
  const rest = specifier.slice(MODULE_PREFIX.length)
  const slashIndex = rest.indexOf('/')
  if (slashIndex <= 0 || slashIndex === rest.length - 1) return null
  const prefix = rest.slice(0, slashIndex)
  const atIndex = prefix.lastIndexOf('@')
  if (atIndex <= 0 || atIndex === prefix.length - 1) return null
  const blueprintId = prefix.slice(0, atIndex)
  const version = prefix.slice(atIndex + 1)
  const relPath = rest.slice(slashIndex + 1)
  if (!blueprintId || !version || !relPath) return null
  return { blueprintId, version, relPath }
}

export function isRelativeImport(specifier) {
  return typeof specifier === 'string' && (specifier.startsWith('./') || specifier.startsWith('../'))
}

export function normalizeSharedRelPath(importSpecifier) {
  if (typeof importSpecifier !== 'string') return null
  if (importSpecifier.startsWith(SHARED_PREFIX)) {
    return isValidScriptPath(importSpecifier) ? importSpecifier : null
  }
  if (importSpecifier.startsWith(SHARED_ALIAS_PREFIX)) {
    const rest = importSpecifier.slice(SHARED_ALIAS_PREFIX.length)
    if (!rest) return null
    const relPath = `${SHARED_PREFIX}${rest}`
    return isValidScriptPath(relPath) ? relPath : null
  }
  return null
}

export function getSharedRelPathAlternate(relPath) {
  if (typeof relPath !== 'string') return null
  if (relPath.startsWith(SHARED_PREFIX)) {
    const rest = relPath.slice(SHARED_PREFIX.length)
    return rest ? `${SHARED_ALIAS_PREFIX}${rest}` : null
  }
  if (relPath.startsWith(SHARED_ALIAS_PREFIX)) {
    const rest = relPath.slice(SHARED_ALIAS_PREFIX.length)
    return rest ? `${SHARED_PREFIX}${rest}` : null
  }
  return null
}

function normalizeRelativePath(referrerPath, importSpecifier) {
  if (typeof referrerPath !== 'string' || typeof importSpecifier !== 'string') return null
  if (importSpecifier.includes('\\')) return null
  const refSegments = referrerPath.split('/').filter(Boolean)
  refSegments.pop()
  const specSegments = importSpecifier.split('/')
  const nextSegments = [...refSegments]
  for (const segment of specSegments) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (nextSegments.length === 0) return null
      nextSegments.pop()
      continue
    }
    nextSegments.push(segment)
  }
  const normalized = nextSegments.join('/')
  if (!normalized) return null
  return normalized
}

export function resolveRelativeModuleSpecifier(importSpecifier, referrerSpecifier) {
  if (!isRelativeImport(importSpecifier)) return null
  const referrer = parseModuleSpecifier(referrerSpecifier)
  if (!referrer) return null
  const normalizedPath = normalizeRelativePath(referrer.relPath, importSpecifier)
  if (!normalizedPath || !isValidScriptPath(normalizedPath)) return null
  return buildModuleSpecifier({
    blueprintId: referrer.blueprintId,
    version: referrer.version,
    relPath: normalizedPath,
  })
}
