import fs from 'fs'
import path from 'path'

const BLUEPRINT_DENYLIST = new Set(['package.json', 'tsconfig.json', 'jsconfig.json'])

export function deriveBlueprintId(appName, fileBase) {
  if (fileBase === appName) {
    return fileBase
  }
  return `${appName}__${fileBase}`
}

export function parseBlueprintId(id) {
  if (id === '$scene') {
    return { appName: '$scene', fileBase: '$scene' }
  }

  const idx = id.indexOf('__')
  if (idx !== -1) {
    return {
      appName: id.slice(0, idx),
      fileBase: id.slice(idx + 2),
    }
  }

  return {
    appName: id,
    fileBase: id,
  }
}

export function isBlueprintDenylist(filename) {
  return BLUEPRINT_DENYLIST.has(filename)
}

export function getScriptPath(appName, appsDir) {
  const appPath = path.join(appsDir, appName)
  const _jsPath = path.join(appPath, 'index.js')
  const _tsPath = path.join(appPath, 'index.js')
  if (fs.existsSync(_tsPath)) return _tsPath
  if (fs.existsSync(_jsPath)) return _jsPath
  return _tsPath
}
