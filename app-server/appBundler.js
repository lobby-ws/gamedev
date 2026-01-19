import fs from 'fs'
import fsPromises from 'fs/promises'
import path from 'path'
import { builtinModules } from 'module'
import * as esbuild from 'esbuild'

const TEXT_LOADERS = {
  '.txt': 'text',
  '.md': 'text',
  '.glsl': 'text',
}

const WINDOWS_ABS_PATH = /^[a-zA-Z]:[\\/]+/
const BUILTIN_MODULES = new Set(builtinModules.map(name => name.replace(/^node:/, '')))

function isAbsoluteImport(specifier) {
  return specifier.startsWith('/') || specifier.startsWith('\\') || WINDOWS_ABS_PATH.test(specifier)
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../')
}

function isNodeBuiltin(specifier) {
  if (specifier.startsWith('node:')) return true
  const root = specifier.split('/')[0]
  return BUILTIN_MODULES.has(root)
}

function isInsideDir(targetPath, dirPath) {
  const relative = path.relative(dirPath, targetPath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function resolveEntry(rootDir, appName) {
  const appDir = path.join(rootDir, 'apps', appName)
  const tsEntry = path.join(appDir, 'index.ts')
  if (fs.existsSync(tsEntry)) return tsEntry
  const jsEntry = path.join(appDir, 'index.js')
  if (fs.existsSync(jsEntry)) return jsEntry
  return null
}

function importPolicyPlugin({ rootDir, appName }) {
  const rootAbs = path.resolve(rootDir)
  const appsDir = path.join(rootAbs, 'apps')
  return {
    name: 'app-import-policy',
    setup(build) {
      build.onResolve({ filter: /.*/ }, async args => {
        if (args.pluginData?.skip) return
        if (args.kind === 'entry-point') return

        const specifier = args.path
        if (isNodeBuiltin(specifier)) {
          return {
            errors: [
              { text: `Disallowed node builtin import "${specifier}" (scripts run in sandbox).` },
            ],
          }
        }

        if (isAbsoluteImport(specifier)) {
          return {
            errors: [{ text: `Absolute import "${specifier}" is not allowed; use a relative path.` }],
          }
        }

        const resolved = await build.resolve(specifier, {
          resolveDir: args.resolveDir,
          kind: args.kind,
          pluginData: { skip: true },
        })

        if (resolved.errors?.length) return resolved
        if (!resolved.path || resolved.namespace !== 'file') return resolved

        const resolvedPath = path.resolve(resolved.path)
        const isBare = !isRelativeImport(specifier) && !isAbsoluteImport(specifier)

        if (isBare) {
          const nodeModulesMarker = `${path.sep}node_modules${path.sep}`
          if (!resolvedPath.includes(nodeModulesMarker)) {
            return {
              errors: [{ text: `Bare import "${specifier}" must resolve to node_modules.` }],
            }
          }
          return resolved
        }

        if (!isInsideDir(resolvedPath, rootAbs)) {
          return {
            errors: [{ text: `Import "${specifier}" resolves outside the project root.` }],
          }
        }

        if (isInsideDir(resolvedPath, appsDir)) {
          const relativeToApps = path.relative(appsDir, resolvedPath)
          const targetApp = relativeToApps.split(path.sep)[0]
          if (targetApp && targetApp !== appName) {
            return {
              errors: [
                {
                  text: `Disallowed cross-app import "${specifier}" (apps/${targetApp}/...).`,
                },
              ],
            }
          }
        }

        return resolved
      })
    },
  }
}

function onBuildPlugin(onBuild) {
  if (!onBuild) return null
  return {
    name: 'app-bundler-on-build',
    setup(build) {
      build.onEnd(result => {
        onBuild(result)
      })
    },
  }
}

function createBuildOptions({ rootDir, appName, onBuild }) {
  const entry = resolveEntry(rootDir, appName)
  const outfile = path.join(rootDir, 'dist', 'apps', `${appName}.js`)
  if (!entry) {
    return { entry: null, outfile }
  }
  const plugins = [importPolicyPlugin({ rootDir, appName })]
  const onBuildPluginInstance = onBuildPlugin(onBuild)
  if (onBuildPluginInstance) plugins.push(onBuildPluginInstance)
  return {
    entry,
    outfile,
    options: {
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: 'esm',
      // platform: 'neutral',
      target: 'esnext',
      minify: false,
      sourcemap: false,
      absWorkingDir: rootDir,
      logLevel: 'silent',
      loader: {
        '.json': 'json',
        ...TEXT_LOADERS,
      },
      plugins,
    },
  }
}

export async function buildApp({ rootDir, appName }) {
  const { entry, outfile, options } = createBuildOptions({ rootDir, appName })
  await fsPromises.mkdir(path.dirname(outfile), { recursive: true })
  if (!entry || !options) {
    return {
      outfile,
      errors: [
        {
          text: `Missing entry for app "${appName}". Expected apps/${appName}/index.ts or index.js.`,
        },
      ],
    }
  }
  try {
    const result = await esbuild.build(options)
    return { outfile, errors: result.errors }
  } catch (err) {
    if (err && err.errors) {
      return { outfile, errors: err.errors }
    }
    throw err
  }
}

export async function createAppWatch({ rootDir, appName, onBuild }) {
  const { entry, outfile, options } = createBuildOptions({ rootDir, appName, onBuild })
  await fsPromises.mkdir(path.dirname(outfile), { recursive: true })
  if (!entry || !options) {
    throw new Error(
      `Missing entry for app "${appName}". Expected apps/${appName}/index.ts or index.js.`
    )
  }
  const ctx = await esbuild.context(options)
  await ctx.watch()
  return async () => {
    await ctx.dispose()
  }
}

export function formatBuildErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return []
  return errors.map(error => {
    const text = error?.text || String(error)
    const location = error?.location
    if (!location) return text
    const file = location.file || '<unknown>'
    const line = typeof location.line === 'number' ? location.line : null
    const column = typeof location.column === 'number' ? location.column : null
    if (line == null) return `${file} - ${text}`
    return `${file}:${line}:${column ?? 0} - ${text}`
  })
}
