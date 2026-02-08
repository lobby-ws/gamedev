import { System } from './System'
import { parse as acornParse } from 'acorn'

import * as THREE from '../extras/three'
import { DEG2RAD, RAD2DEG } from '../extras/general'
import { clamp, num, uuid } from '../utils'
import { LerpVector3 } from '../extras/LerpVector3'
import { LerpQuaternion } from '../extras/LerpQuaternion'
import { Curve } from '../extras/Curve'
import { prng } from '../extras/prng'
import { BufferedLerpVector3 } from '../extras/BufferedLerpVector3'
import { BufferedLerpQuaternion } from '../extras/BufferedLerpQuaternion'
import { isValidScriptPath } from '../blueprintValidation'
import { buildLegacyBodyModuleSource } from '../legacyBody'
import {
  buildModuleSpecifier,
  parseModuleSpecifier,
  resolveRelativeModuleSpecifier,
  isRelativeImport,
  normalizeSharedRelPath,
  getSharedRelPathAlternate,
} from '../moduleSpecifiers'

/**
 * Script System
 *
 * - Runs on both the server and client.
 * - Executes scripts inside secure compartments
 *
 */

export class Scripts extends System {
  constructor(world) {
    super(world)
    this.moduleSourceCache = new Map()
    this.appContextStack = []
    this.endowments = {
      console: {
        log: (...args) => this._handleConsoleCall('log', args),
        warn: (...args) => this._handleConsoleCall('warn', args),
        error: (...args) => this._handleConsoleCall('error', args),
        time: (...args) => this._handleConsoleTime(args),
        timeEnd: (...args) => this._handleConsoleTimeEnd(args),
      },
      Date: {
        now: () => Date.now(),
      },
      URL,
      Math,
      eval: undefined,
      harden: undefined,
      lockdown: undefined,
      num,
      prng,
      clamp,
      // Layers,
      Object3D: THREE.Object3D,
      Quaternion: THREE.Quaternion,
      Vector3: THREE.Vector3,
      Euler: THREE.Euler,
      Matrix4: THREE.Matrix4,
      LerpVector3, // deprecated - use BufferedLerpVector3
      LerpQuaternion, // deprecated - use BufferedLerpQuaternion
      BufferedLerpVector3,
      BufferedLerpQuaternion,
      // Material: Material,
      Curve,
      // Gradient: Gradient,
      DEG2RAD,
      RAD2DEG,
      uuid,
      // pause: () => this.world.pause(),
    }
    this.compartment = new Compartment(this.endowments)
  }

  withAppContext(appId, fn) {
    if (typeof fn !== 'function') return undefined
    if (typeof appId !== 'string' || !appId) return fn()
    this.appContextStack.push(appId)
    try {
      return fn()
    } finally {
      this.appContextStack.pop()
    }
  }

  getRecentServerLogs(appId, limit = 20) {
    return this.world.serverAppLogs?.getRecent?.(appId, limit) || []
  }

  _getCurrentAppId() {
    if (!this.appContextStack.length) return null
    return this.appContextStack[this.appContextStack.length - 1]
  }

  _recordScriptLog(level, args, extras = {}) {
    const appId = this._getCurrentAppId()
    if (!appId) return
    const record = {
      timestamp: new Date().toISOString(),
      level,
      args,
      ...extras,
    }
    try {
      this.world.serverAppLogs?.record?.(appId, record)
    } catch (err) {
      // ignore logging errors to avoid affecting script execution
    }
  }

  _normalizeTimerLabel(args) {
    const label = Array.isArray(args) && args.length ? args[0] : undefined
    if (typeof label === 'string') {
      const trimmed = label.trim()
      return trimmed || 'default'
    }
    if (typeof label === 'undefined' || label === null) {
      return 'default'
    }
    const text = String(label).trim()
    return text || 'default'
  }

  _handleConsoleCall(level, args) {
    this._recordScriptLog(level, args)
    if (level === 'warn') return console.warn(...args)
    if (level === 'error') return console.error(...args)
    return console.log(...args)
  }

  _handleConsoleTime(args) {
    const appId = this._getCurrentAppId()
    const label = this._normalizeTimerLabel(args)
    if (appId) {
      this.world.serverAppLogs?.startTimer?.(appId, label)
    }
    this._recordScriptLog('time', args, {
      label,
      message: label,
    })
    return console.time(...args)
  }

  _handleConsoleTimeEnd(args) {
    const appId = this._getCurrentAppId()
    const label = this._normalizeTimerLabel(args)
    const durationMs = appId ? this.world.serverAppLogs?.endTimer?.(appId, label) ?? null : null
    this._recordScriptLog('timeEnd', args, {
      label,
      durationMs,
      message: Number.isFinite(durationMs) ? `${label}: ${Math.round(durationMs)}ms` : label,
    })
    return console.timeEnd(...args)
  }

  evaluate(code) {
    let value
    const result = {
      exec: (...args) => {
        if (!value) value = this.compartment.evaluate(wrapRawCode(code))
        return value(...args)
      },
      code,
    }
    return result
  }

  async loadModuleScript({ blueprint }) {
    const scriptFiles = blueprint?.scriptFiles
    const scriptEntry = blueprint?.scriptEntry
    const scriptFormat = blueprint?.scriptFormat
    if (!scriptFiles || !scriptEntry) {
      throw new Error('module_script_missing_fields')
    }
    if (!isValidScriptPath(scriptEntry) || !Object.prototype.hasOwnProperty.call(scriptFiles, scriptEntry)) {
      throw new Error('module_script_entry_missing')
    }
    if (scriptFormat && scriptFormat !== 'module' && scriptFormat !== 'legacy-body') {
      throw new Error(`invalid_script_format:${scriptFormat}`)
    }
    const resolvedScriptFormat = scriptFormat || 'legacy-body'

    const blueprintId = blueprint.id
    const version = Number.isFinite(blueprint.version) ? blueprint.version : 0
    const entrySpecifier = buildModuleSpecifier({
      blueprintId,
      version,
      relPath: scriptEntry,
    })

    const resolveHook = (importSpecifier, referrerSpecifier) => {
      if (importSpecifier.startsWith('app://')) {
        const parsed = parseModuleSpecifier(importSpecifier)
        if (!parsed || !isValidScriptPath(parsed.relPath)) {
          throw new Error(`invalid_module_specifier:${importSpecifier}`)
        }
        if (parsed.blueprintId !== blueprintId || parsed.version !== String(version)) {
          throw new Error(`cross_app_import_not_allowed:${importSpecifier}`)
        }
        return importSpecifier
      }
      const sharedRelPath = normalizeSharedRelPath(importSpecifier)
      if (sharedRelPath) {
        let relPath = sharedRelPath
        if (!Object.prototype.hasOwnProperty.call(scriptFiles, relPath)) {
          const altRelPath = getSharedRelPathAlternate(relPath)
          if (altRelPath && Object.prototype.hasOwnProperty.call(scriptFiles, altRelPath)) {
            relPath = altRelPath
          }
        }
        return buildModuleSpecifier({
          blueprintId,
          version,
          relPath,
        })
      }
      if (isRelativeImport(importSpecifier)) {
        const resolved = resolveRelativeModuleSpecifier(importSpecifier, referrerSpecifier)
        if (!resolved) {
          throw new Error(`invalid_relative_import:${importSpecifier}`)
        }
        return resolved
      }
      throw new Error(`unsupported_import:${importSpecifier}`)
    }

    const importHook = async moduleSpecifier => {
      const parsed = parseModuleSpecifier(moduleSpecifier)
      if (!parsed || !isValidScriptPath(parsed.relPath)) {
        throw new Error(`invalid_module_specifier:${moduleSpecifier}`)
      }
      if (parsed.blueprintId !== blueprintId || parsed.version !== String(version)) {
        throw new Error(`cross_app_import_not_allowed:${moduleSpecifier}`)
      }
      const assetUrl = scriptFiles[parsed.relPath]
      if (!assetUrl) {
        throw new Error(`module_not_found:${parsed.relPath}`)
      }
      if (this.moduleSourceCache.has(moduleSpecifier)) {
        return this.moduleSourceCache.get(moduleSpecifier)
      }
      const sourceText = await this._loadModuleText(assetUrl)
      const isEntry = parsed.relPath === scriptEntry
      const useLegacyBody = resolvedScriptFormat === 'legacy-body' && isEntry
      const moduleSource = useLegacyBody
        ? compileLegacyBodyModuleSource(sourceText, moduleSpecifier)
        : compileModuleSource(sourceText, moduleSpecifier)
      this.moduleSourceCache.set(moduleSpecifier, moduleSource)
      return moduleSource
    }

    const importMetaHook = (moduleSpecifier, importMeta) => {
      importMeta.url = moduleSpecifier
    }

    const compartment = new Compartment(this.endowments, {}, {
      resolveHook,
      importHook,
      importMetaHook,
      __noNamespaceBox__: true,
    })

    const namespaceBox = await compartment.import(entrySpecifier)
    const namespace = namespaceBox && namespaceBox.namespace ? namespaceBox.namespace : namespaceBox
    const exec = (...args) => {
      if (!namespace || typeof namespace.default !== 'function') {
        throw new Error('module_entry_missing_default_export')
      }
      return namespace.default(...args)
    }

    return { exec, entryUrl: entrySpecifier, namespace }
  }

  async _loadModuleText(url) {
    if (!url) return ''
    if (this.world?.loader?.loadFile) {
      const file = await this.world.loader.loadFile(url)
      return file.text()
    }
    if (this.world?.loader?.fetchText) {
      const resolved = this.world.resolveURL(url, true)
      return this.world.loader.fetchText(resolved)
    }
    const resolved = this.world.resolveURL ? this.world.resolveURL(url, true) : url
    const response = await fetch(resolved)
    return response.text()
  }
}

// NOTE: config is deprecated and renamed to props
function wrapRawCode(code) {
  return `
  (function() {
    const shared = {}
    return (world, app, fetch, props, setTimeout) => {
      const config = props // deprecated
      ${code}
    }
  })()
  `
}

export function compileLegacyBodyModuleSource(code, moduleSpecifier) {
  const moduleSource = buildLegacyBodyModuleSource(code, moduleSpecifier)
  return compileModuleSource(moduleSource, moduleSpecifier)
}

function compileModuleSource(code, moduleSpecifier) {
  const ast = acornParse(code, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowHashBang: true,
  })
  const importStatements = []
  const exportStatements = []
  const bodyChunks = []
  const importSpecifiers = []
  const importSet = new Set()
  const exportSet = new Set()
  const importVars = new Map()
  let importIndex = 0
  const addImport = specifier => {
    if (!importSet.has(specifier)) {
      importSet.add(specifier)
      importSpecifiers.push(specifier)
    }
  }
  const ensureImportVar = specifier => {
    let name = importVars.get(specifier)
    if (!name) {
      name = `__hyp_import_${importIndex++}__`
      importVars.set(specifier, name)
      importStatements.push(`const ${name} = importNow(${JSON.stringify(specifier)});`)
      addImport(specifier)
    }
    return name
  }
  const addExport = name => {
    exportSet.add(name)
  }
  const getExportName = node => {
    if (!node) return null
    if (node.type === 'Identifier') return node.name
    if (node.type === 'Literal') return String(node.value)
    return null
  }
  const isValidIdentifier = name => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
  const propAccess = (obj, prop) =>
    isValidIdentifier(prop) ? `${obj}.${prop}` : `${obj}[${JSON.stringify(prop)}]`
  const collectBindingNames = (node, names) => {
    if (!node) return
    switch (node.type) {
      case 'Identifier':
        names.push(node.name)
        break
      case 'ObjectPattern':
        for (const prop of node.properties) {
          if (prop.type === 'RestElement') {
            collectBindingNames(prop.argument, names)
          } else {
            collectBindingNames(prop.value || prop.argument, names)
          }
        }
        break
      case 'ArrayPattern':
        for (const element of node.elements) {
          if (element) collectBindingNames(element, names)
        }
        break
      case 'AssignmentPattern':
        collectBindingNames(node.left, names)
        break
      case 'RestElement':
        collectBindingNames(node.argument, names)
        break
      default:
        break
    }
  }

  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') {
      const specifier = node.source?.value
      if (!specifier || typeof specifier !== 'string') {
        throw new Error(`invalid_import_specifier:${moduleSpecifier}`)
      }
      if (node.specifiers.length === 0) {
        importStatements.push(`importNow(${JSON.stringify(specifier)});`)
        addImport(specifier)
        continue
      }
      const importVar = ensureImportVar(specifier)
      for (const spec of node.specifiers) {
        if (spec.type === 'ImportDefaultSpecifier') {
          importStatements.push(`const ${spec.local.name} = ${importVar}.default;`)
        } else if (spec.type === 'ImportNamespaceSpecifier') {
          importStatements.push(`const ${spec.local.name} = ${importVar};`)
        } else if (spec.type === 'ImportSpecifier') {
          const importedName = getExportName(spec.imported)
          if (!importedName) {
            throw new Error(`invalid_import_specifier:${moduleSpecifier}`)
          }
          importStatements.push(`const ${spec.local.name} = ${propAccess(importVar, importedName)};`)
        }
      }
      continue
    }

    if (node.type === 'ExportAllDeclaration') {
      throw new Error(`export_all_not_supported:${moduleSpecifier}`)
    }

    if (node.type === 'ExportDefaultDeclaration') {
      addExport('default')
      const decl = node.declaration
      if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') {
        if (decl.id && decl.id.name) {
          bodyChunks.push(code.slice(decl.start, decl.end))
          exportStatements.push(`exports.default = ${decl.id.name};`)
        } else {
          const declCode = code.slice(decl.start, decl.end)
          bodyChunks.push(`const __hyp_default__ = ${declCode};`)
          exportStatements.push('exports.default = __hyp_default__;')
        }
      } else {
        const exprCode = code.slice(decl.start, decl.end)
        bodyChunks.push(`const __hyp_default__ = ${exprCode};`)
        exportStatements.push('exports.default = __hyp_default__;')
      }
      continue
    }

    if (node.type === 'ExportNamedDeclaration') {
      if (node.source) {
        const specifier = node.source.value
        if (typeof specifier !== 'string') {
          throw new Error(`invalid_export_specifier:${moduleSpecifier}`)
        }
        const importVar = ensureImportVar(specifier)
        for (const spec of node.specifiers) {
          if (spec.type === 'ExportSpecifier') {
            const localName = getExportName(spec.local)
            const exportedName = getExportName(spec.exported)
            if (!localName || !exportedName) {
              throw new Error(`invalid_export_specifier:${moduleSpecifier}`)
            }
            addExport(exportedName)
            exportStatements.push(
              `${propAccess('exports', exportedName)} = ${propAccess(importVar, localName)};`
            )
          } else if (spec.type === 'ExportNamespaceSpecifier') {
            const exportedName = getExportName(spec.exported)
            if (!exportedName) {
              throw new Error(`invalid_export_specifier:${moduleSpecifier}`)
            }
            addExport(exportedName)
            exportStatements.push(`${propAccess('exports', exportedName)} = ${importVar};`)
          }
        }
      } else if (node.declaration) {
        const decl = node.declaration
        bodyChunks.push(code.slice(decl.start, decl.end))
        const names = []
        if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') {
          if (!decl.id || !decl.id.name) {
            throw new Error(`invalid_export_declaration:${moduleSpecifier}`)
          }
          names.push(decl.id.name)
        } else if (decl.type === 'VariableDeclaration') {
          for (const declarator of decl.declarations) {
            collectBindingNames(declarator.id, names)
          }
        }
        for (const name of names) {
          addExport(name)
          exportStatements.push(`${propAccess('exports', name)} = ${name};`)
        }
      } else if (node.specifiers.length) {
        for (const spec of node.specifiers) {
          if (spec.type !== 'ExportSpecifier') continue
          const localName = getExportName(spec.local)
          const exportedName = getExportName(spec.exported)
          if (!localName || !exportedName) {
            throw new Error(`invalid_export_specifier:${moduleSpecifier}`)
          }
          addExport(exportedName)
          exportStatements.push(`${propAccess('exports', exportedName)} = ${localName};`)
        }
      }
      continue
    }

    bodyChunks.push(code.slice(node.start, node.end))
  }

  const moduleBody = [
    '"use strict";',
    ...importStatements,
    ...bodyChunks,
    ...exportStatements,
  ]
    .filter(Boolean)
    .join('\n')

  const wrapperSource = `(exports, importNow) => {\n${moduleBody}\n}`
  const compiledByCompartment = new WeakMap()

  return {
    imports: importSpecifiers,
    exports: Array.from(exportSet),
    execute(exportsTarget, compartment, resolvedImports) {
      let compiled = compiledByCompartment.get(compartment)
      if (!compiled) {
        compiled = compartment.evaluate(wrapperSource)
        compiledByCompartment.set(compartment, compiled)
      }
      const importCache = Object.create(null)
      const importNow = spec => {
        const resolved = resolvedImports?.[spec]
        if (!resolved) {
          throw new Error(`module_import_unresolved:${spec}`)
        }
        if (!importCache[spec]) {
          let namespace = compartment.importNow(resolved)
          if (namespace && namespace.namespace) {
            namespace = namespace.namespace
          }
          importCache[spec] = namespace
        }
        return importCache[spec]
      }
      compiled(exportsTarget, importNow)
    },
  }
}
