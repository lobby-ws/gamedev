import { parse as acornParse } from 'acorn'
import { isValidScriptPath } from '../../../core/blueprintValidation'

const languageByExt = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
}

const SHARED_PREFIX = '@shared/'
const SHARED_ALIAS = 'shared/'

function isSharedPath(path) {
  if (typeof path !== 'string') return false
  return path.startsWith(SHARED_PREFIX) || path.startsWith(SHARED_ALIAS)
}

function toSharedPath(path) {
  if (typeof path !== 'string') return null
  if (path.startsWith(SHARED_PREFIX)) return path
  if (path.startsWith(SHARED_ALIAS)) {
    return `${SHARED_PREFIX}${path.slice(SHARED_ALIAS.length)}`
  }
  return `${SHARED_PREFIX}${path}`
}

function normalizeAiPatchSet(input) {
  if (!input) return null
  const patchSet = input
  const files = Array.isArray(patchSet)
    ? patchSet
    : patchSet.files || patchSet.changes || patchSet.patches
  if (!Array.isArray(files) || files.length === 0) return null
  const normalizedFiles = []
  for (const entry of files) {
    if (!entry) continue
    const path = entry.path || entry.relPath || entry.file
    const content = entry.content ?? entry.text ?? entry.nextText ?? entry.code
    if (!path || typeof content !== 'string') continue
    normalizedFiles.push({ path, content })
  }
  if (!normalizedFiles.length) return null
  const autoApply =
    patchSet.autoApply === true || patchSet.autoCommit === true || patchSet.autoAccept === true
  return {
    id: typeof patchSet.id === 'string' ? patchSet.id : null,
    summary:
      typeof patchSet.summary === 'string'
        ? patchSet.summary
        : typeof patchSet.prompt === 'string'
          ? patchSet.prompt
          : '',
    source: typeof patchSet.source === 'string' ? patchSet.source : '',
    scriptRootId:
      typeof patchSet.scriptRootId === 'string'
        ? patchSet.scriptRootId
        : typeof patchSet.blueprintId === 'string'
          ? patchSet.blueprintId
          : null,
    autoPreview: patchSet.autoPreview !== false && !autoApply,
    autoApply,
    files: normalizedFiles,
  }
}

function getFileExtension(path) {
  if (typeof path !== 'string') return ''
  const idx = path.lastIndexOf('.')
  if (idx === -1 || idx === path.length - 1) return ''
  return path.slice(idx + 1).toLowerCase()
}

function getLanguageForPath(path) {
  const ext = getFileExtension(path)
  return languageByExt[ext] || 'javascript'
}

function normalizeScope(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function getExportedName(node) {
  if (!node) return null
  if (node.type === 'Identifier') return node.name
  if (node.type === 'Literal') return String(node.value)
  return null
}

function entryHasDefaultExport(sourceText) {
  if (typeof sourceText !== 'string' || !sourceText.trim()) return false
  let ast = null
  try {
    ast = acornParse(sourceText, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
    })
  } catch {
    // Fallback for parse failures (e.g. transient edits or TS syntax):
    // detect common default-export forms to keep scriptFormat in sync.
    return /\bexport\s+default\b/.test(sourceText) || /\bexport\s*\{[^}]*\bdefault\b[^}]*\}/.test(sourceText)
  }
  for (const node of ast.body) {
    if (node.type === 'ExportDefaultDeclaration') return true
    if (node.type === 'ExportNamedDeclaration' && Array.isArray(node.specifiers)) {
      for (const spec of node.specifiers) {
        if (spec.type !== 'ExportSpecifier') continue
        const exported = getExportedName(spec.exported)
        if (exported === 'default') return true
      }
    }
  }
  return false
}

function resolveScriptFormatForSave(scriptRoot, entryPath, fileStates, nextEntryText = null) {
  const currentFormat = scriptRoot?.scriptFormat === 'legacy-body' ? 'legacy-body' : 'module'
  if (!entryPath || !isValidScriptPath(entryPath)) return currentFormat
  const entryState = fileStates?.get?.(entryPath)
  const entryText =
    typeof nextEntryText === 'string'
      ? nextEntryText
      : typeof entryState?.model?.getValue === 'function'
      ? entryState.model.getValue()
      : typeof entryState?.originalText === 'string'
        ? entryState.originalText
        : null
  if (typeof entryText !== 'string') return currentFormat
  return entryHasDefaultExport(entryText) ? 'module' : 'legacy-body'
}

function buildFileTree(paths) {
  const root = { name: '', path: null, fullPath: '', children: new Map() }
  for (const path of paths) {
    const parts = path.split('/')
    let node = root
    let currentPath = ''
    for (let idx = 0; idx < parts.length; idx += 1) {
      const part = parts[idx]
      currentPath = currentPath ? `${currentPath}/${part}` : part
      let child = node.children.get(part)
      if (!child) {
        child = { name: part, path: null, fullPath: currentPath, children: new Map() }
        node.children.set(part, child)
      }
      if (idx === parts.length - 1) {
        child.path = path
      }
      node = child
    }
  }
  return root
}

export {
  SHARED_ALIAS,
  SHARED_PREFIX,
  buildFileTree,
  ensureJsExtension,
  getNewFileTemplate,
  getFileExtension,
  getLanguageForPath,
  isSharedPath,
  normalizeAiPatchSet,
  normalizeScope,
  resolveScriptFormatForSave,
  toSharedPath,
}

function getNewFileTemplate() {
  return 'export default (world, app, fetch, props, setTimeout) => {\n}\n'
}

function ensureJsExtension(path) {
  if (typeof path !== 'string') return path
  const trimmed = path.trim()
  if (!trimmed) return trimmed
  if (trimmed.endsWith('/')) return trimmed
  const lastSlash = trimmed.lastIndexOf('/')
  const lastSegment = trimmed.slice(lastSlash + 1)
  if (!lastSegment) return trimmed
  const lower = lastSegment.toLowerCase()
  if (lower.endsWith('.js')) {
    return `${trimmed.slice(0, trimmed.length - 3)}.js`
  }
  let base = trimmed
  while (base.endsWith('.')) {
    base = base.slice(0, -1)
  }
  const dotIndex = base.lastIndexOf('.')
  if (dotIndex > lastSlash) {
    base = base.slice(0, dotIndex)
  }
  return `${base}.js`
}
