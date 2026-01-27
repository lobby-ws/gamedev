export function isValidScriptPath(value) {
  if (typeof value !== 'string') return false
  if (!value.trim()) return false
  if (value.startsWith('/')) return false
  if (value.includes('\\')) return false
  const segments = value.split('/')
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      return false
    }
  }
  return true
}

export function isValidAssetUrl(value) {
  return typeof value === 'string' && value.startsWith('asset://') && value.length > 'asset://'.length
}

export function validateScriptFiles(scriptFiles) {
  if (scriptFiles == null) return { ok: true }
  if (typeof scriptFiles !== 'object' || Array.isArray(scriptFiles)) {
    return { ok: false, error: 'invalid_script_files' }
  }
  for (const [relPath, url] of Object.entries(scriptFiles)) {
    if (!isValidScriptPath(relPath)) {
      return { ok: false, error: 'invalid_script_files' }
    }
    if (!isValidAssetUrl(url)) {
      return { ok: false, error: 'invalid_script_files' }
    }
  }
  return { ok: true }
}

export function validateScriptEntry(scriptEntry) {
  if (scriptEntry == null) return { ok: true }
  if (!isValidScriptPath(scriptEntry)) {
    return { ok: false, error: 'invalid_script_entry' }
  }
  return { ok: true }
}

export function validateBlueprintScriptFields(data) {
  if (!data || typeof data !== 'object') return { ok: true }
  const filesCheck = validateScriptFiles(data.scriptFiles)
  if (!filesCheck.ok) return filesCheck
  const entryCheck = validateScriptEntry(data.scriptEntry)
  if (!entryCheck.ok) return entryCheck
  return { ok: true }
}
