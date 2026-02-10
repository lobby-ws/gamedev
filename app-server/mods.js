import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { parse as acornParse } from 'acorn'
import { build as esbuildBuild } from 'esbuild'
import { isEqual } from 'lodash-es'

import { createEmptyModManifest, normalizeModManifest } from '../src/core/mods/manifest.js'
import { normalizeModOrderSpec, resolveModOrder } from '../src/core/mods/order.js'

const MOD_FILE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'])
const MODS_SCOPE = 'mods'

const SCAN_TARGETS = [
  {
    dir: 'core/server',
    idPrefix: 'core.server',
    kind: 'system',
    scope: 'server',
    platforms: ['server'],
  },
  {
    dir: 'core/client',
    idPrefix: 'core.client',
    kind: 'system',
    scope: 'client',
    platforms: ['client'],
  },
  {
    dir: 'core/shared',
    idPrefix: 'core.shared',
    kind: 'system',
    scope: 'shared',
    platforms: ['server', 'client'],
  },
  {
    dir: 'client/components',
    idPrefix: 'client.components',
    kind: 'component',
    platforms: ['client'],
  },
  {
    dir: 'client/sidebar',
    idPrefix: 'client.sidebar',
    kind: 'sidebar',
    platforms: ['client'],
  },
]

const ESBUILD_LOADERS = {
  '.js': 'jsx',
  '.jsx': 'jsx',
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.mjs': 'js',
  '.cjs': 'js',
}

function normalizePath(value) {
  return value.replace(/\\/g, '/')
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function ensureDirExists(dirPath) {
  try {
    return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()
  } catch {
    return false
  }
}

function isModFile(name) {
  const ext = path.extname(name || '').toLowerCase()
  return MOD_FILE_EXTENSIONS.has(ext)
}

function listModuleFiles(baseDir) {
  const out = []
  if (!ensureDirExists(baseDir)) return out
  const stack = [baseDir]
  while (stack.length) {
    const current = stack.pop()
    const entries = fs.readdirSync(current, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const absPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(absPath)
        continue
      }
      if (!entry.isFile()) continue
      if (!isModFile(entry.name)) continue
      out.push(absPath)
    }
  }
  out.sort((a, b) => a.localeCompare(b))
  return out
}

function normalizeModuleIdSegment(segment) {
  const safe = segment.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  return safe || 'mod'
}

function buildModuleId(prefix, relPath) {
  const normalizedRel = normalizePath(relPath).replace(/\.[^/.]+$/g, '')
  const parts = normalizedRel
    .split('/')
    .filter(Boolean)
    .map(normalizeModuleIdSegment)
  if (!parts.length) return prefix
  return `${prefix}.${parts.join('.')}`
}

function buildSystemKey(moduleId) {
  let key = `mod_${moduleId.replace(/[^a-zA-Z0-9_$]+/g, '_')}`
  if (!/^[A-Za-z_$]/.test(key)) {
    key = `_${key}`
  }
  return key
}

function collectBindingNames(node, names) {
  if (!node) return
  switch (node.type) {
    case 'Identifier':
      names.push(node.name)
      break
    case 'ObjectPattern':
      for (const prop of node.properties || []) {
        if (prop.type === 'RestElement') {
          collectBindingNames(prop.argument, names)
        } else {
          collectBindingNames(prop.value || prop.argument, names)
        }
      }
      break
    case 'ArrayPattern':
      for (const item of node.elements || []) {
        if (item) collectBindingNames(item, names)
      }
      break
    case 'RestElement':
      collectBindingNames(node.argument, names)
      break
    case 'AssignmentPattern':
      collectBindingNames(node.left, names)
      break
    default:
      break
  }
}

function getNamedExports(sourceText) {
  if (typeof sourceText !== 'string' || !sourceText.trim()) return []
  let ast = null
  try {
    ast = acornParse(sourceText, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
    })
  } catch {
    return []
  }
  const names = new Set()
  for (const node of ast.body) {
    if (node.type !== 'ExportNamedDeclaration') continue
    if (node.declaration) {
      if (
        node.declaration.type === 'FunctionDeclaration' ||
        node.declaration.type === 'ClassDeclaration'
      ) {
        if (node.declaration.id?.name) names.add(node.declaration.id.name)
        continue
      }
      if (node.declaration.type === 'VariableDeclaration') {
        for (const decl of node.declaration.declarations || []) {
          const next = []
          collectBindingNames(decl.id, next)
          for (const name of next) names.add(name)
        }
      }
      continue
    }
    for (const specifier of node.specifiers || []) {
      const exported = specifier.exported
      if (exported?.type === 'Identifier') names.add(exported.name)
      if (exported?.type === 'Literal' && typeof exported.value === 'string') names.add(exported.value)
    }
  }
  return Array.from(names)
}

function inferSidebarExports(absPath) {
  const sourceText = fs.readFileSync(absPath, 'utf8')
  const names = getNamedExports(sourceText)
  const buttonExport = names.includes('Button') ? 'Button' : names.find(name => name.endsWith('Button')) || null
  const paneExport = names.includes('Pane') ? 'Pane' : names.find(name => name.endsWith('Pane')) || null
  if (!buttonExport || !paneExport) {
    throw new Error(`invalid_sidebar_exports:${normalizePath(absPath)}`)
  }
  return { buttonExport, paneExport }
}

function collectManifestAssetUrls(manifest) {
  const urls = new Set()
  if (!manifest || !Array.isArray(manifest.modules)) return urls
  for (const module of manifest.modules) {
    if (typeof module?.serverUrl === 'string' && module.serverUrl.startsWith('asset://')) {
      urls.add(module.serverUrl)
    }
    if (typeof module?.clientUrl === 'string' && module.clientUrl.startsWith('asset://')) {
      urls.add(module.clientUrl)
    }
  }
  return urls
}

function normalizeManifestForDiff(manifest) {
  if (!manifest) return null
  return {
    ...manifest,
    deployedAt: null,
  }
}

function formatNameList(values) {
  if (!values.length) return ''
  if (values.length <= 5) return values.join(', ')
  return `${values.slice(0, 5).join(', ')}, +${values.length - 5} more`
}

async function bundleModule(absPath, { platform }) {
  const isServer = platform === 'server'
  const result = await esbuildBuild({
    entryPoints: [absPath],
    bundle: true,
    write: false,
    format: 'esm',
    platform: isServer ? 'node' : 'browser',
    target: isServer ? 'node22' : 'es2022',
    logLevel: 'silent',
    sourcemap: false,
    legalComments: 'none',
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
    loader: ESBUILD_LOADERS,
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  })
  const output = Array.isArray(result.outputFiles) ? result.outputFiles[0] : null
  if (!output) {
    throw new Error(`mods_bundle_failed:${normalizePath(absPath)}`)
  }
  const buffer = Buffer.from(output.contents)
  const hash = sha256(buffer)
  return {
    hash,
    filename: `${hash}.js`,
    buffer,
  }
}

export class ModsDeployer {
  constructor({ rootDir = process.cwd(), adminClient, targetName = null } = {}) {
    this.rootDir = rootDir
    this.modsDir = path.join(this.rootDir, 'mods')
    this.adminClient = adminClient
    this.targetName = targetName || process.env.HYPERFY_TARGET || null
  }

  _getLockOwner() {
    const target = this.targetName || 'default'
    return `mods-deploy:${target}:${process.pid}`
  }

  _readLoadOrder() {
    const filePath = path.join(this.modsDir, 'load-order.json')
    if (!fs.existsSync(filePath)) return null
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch (err) {
      throw new Error(`invalid_load_order_json:${normalizePath(filePath)}`)
    }
    return normalizeModOrderSpec(parsed)
  }

  _scanModules() {
    const modules = []
    for (const target of SCAN_TARGETS) {
      const dirPath = path.join(this.modsDir, target.dir)
      const files = listModuleFiles(dirPath)
      for (const absPath of files) {
        const relPath = normalizePath(path.relative(dirPath, absPath))
        const sourcePath = normalizePath(path.relative(this.rootDir, absPath))
        const module = {
          id: buildModuleId(target.idPrefix, relPath),
          kind: target.kind,
          scope: target.scope || null,
          absPath,
          relPath,
          sourcePath,
          platforms: target.platforms.slice(),
        }
        if (target.kind === 'sidebar') {
          Object.assign(module, inferSidebarExports(absPath))
        }
        modules.push(module)
      }
    }
    modules.sort((a, b) => a.id.localeCompare(b.id))
    return modules
  }

  async buildManifest({ note = null } = {}) {
    const scanned = this._scanModules()
    const bundles = new Map()
    const moduleRows = []
    for (const entry of scanned) {
      if (entry.kind === 'system') {
        const row = {
          id: entry.id,
          kind: 'system',
          scope: entry.scope,
          systemKey: buildSystemKey(entry.id),
          sourcePath: entry.sourcePath,
        }
        if (entry.platforms.includes('server')) {
          const bundle = await bundleModule(entry.absPath, { platform: 'server' })
          bundles.set(bundle.filename, bundle.buffer)
          row.serverUrl = `asset://${bundle.filename}`
        }
        if (entry.platforms.includes('client')) {
          const bundle = await bundleModule(entry.absPath, { platform: 'client' })
          bundles.set(bundle.filename, bundle.buffer)
          row.clientUrl = `asset://${bundle.filename}`
        }
        moduleRows.push(row)
        continue
      }

      const bundle = await bundleModule(entry.absPath, { platform: 'client' })
      bundles.set(bundle.filename, bundle.buffer)

      if (entry.kind === 'component') {
        moduleRows.push({
          id: entry.id,
          kind: 'component',
          sourcePath: entry.sourcePath,
          exportName: 'default',
          clientUrl: `asset://${bundle.filename}`,
        })
        continue
      }

      moduleRows.push({
        id: entry.id,
        kind: 'sidebar',
        sourcePath: entry.sourcePath,
        buttonExport: entry.buttonExport,
        paneExport: entry.paneExport,
        clientUrl: `asset://${bundle.filename}`,
      })
    }

    const loadOrder = this._readLoadOrder()
    const moduleIds = moduleRows.map(module => module.id)
    if (loadOrder) {
      resolveModOrder(moduleIds, loadOrder)
    }

    const manifest = normalizeModManifest({
      ...createEmptyModManifest(),
      deployNote: typeof note === 'string' && note.trim() ? note.trim() : null,
      modules: moduleRows,
      loadOrder,
    })

    return { manifest, bundles }
  }

  async _readRemoteState() {
    const state = await this.adminClient.getModsState()
    return {
      manifest: normalizeModManifest(state?.manifest, { allowNull: true }),
      loadOrderOverride: normalizeModOrderSpec(state?.loadOrderOverride),
    }
  }

  _buildPlan({ currentManifest, nextManifest, bundles }) {
    const current = normalizeManifestForDiff(currentManifest)
    const next = normalizeManifestForDiff(nextManifest)

    const currentModules = new Map((current?.modules || []).map(module => [module.id, module]))
    const nextModules = new Map((next?.modules || []).map(module => [module.id, module]))

    const adds = []
    const updates = []
    const unchanged = []
    const removes = []

    for (const [id, nextModule] of nextModules.entries()) {
      const currentModule = currentModules.get(id)
      if (!currentModule) {
        adds.push(id)
        continue
      }
      if (isEqual(currentModule, nextModule)) {
        unchanged.push(id)
      } else {
        updates.push(id)
      }
    }

    for (const id of currentModules.keys()) {
      if (!nextModules.has(id)) {
        removes.push(id)
      }
    }

    adds.sort((a, b) => a.localeCompare(b))
    updates.sort((a, b) => a.localeCompare(b))
    removes.sort((a, b) => a.localeCompare(b))
    unchanged.sort((a, b) => a.localeCompare(b))

    const orderChanged = !isEqual(current?.loadOrder || null, next?.loadOrder || null)
    const noteChanged = !isEqual(current?.deployNote || null, next?.deployNote || null)

    const uploads = []
    const neededAssetUrls = collectManifestAssetUrls(next)
    for (const assetUrl of neededAssetUrls) {
      const filename = assetUrl.slice('asset://'.length)
      const buffer = bundles.get(filename)
      if (!buffer) continue
      uploads.push({ filename, buffer })
    }
    uploads.sort((a, b) => a.filename.localeCompare(b.filename))

    const totalChanges = adds.length + updates.length + removes.length + (orderChanged ? 1 : 0) + (noteChanged ? 1 : 0)
    const hasServerSystems = next.modules.some(
      module => module.kind === 'system' && (module.scope === 'server' || module.scope === 'shared')
    )

    return {
      adds,
      updates,
      unchanged,
      removes,
      orderChanged,
      noteChanged,
      uploads,
      totalChanges,
      hasServerSystems,
      manifestChanged: totalChanges > 0,
    }
  }

  _printPlan(plan) {
    console.log('🧩 Mods deploy plan:')
    if (!plan.totalChanges) {
      console.log('  • no manifest changes')
    } else {
      if (plan.adds.length) {
        console.log(`  • add: ${plan.adds.length} (${formatNameList(plan.adds)})`)
      }
      if (plan.updates.length) {
        console.log(`  • update: ${plan.updates.length} (${formatNameList(plan.updates)})`)
      }
      if (plan.removes.length) {
        console.log(`  • remove: ${plan.removes.length} (${formatNameList(plan.removes)})`)
      }
      if (plan.orderChanged) {
        console.log('  • load-order changed')
      }
      if (plan.noteChanged) {
        console.log('  • deploy note changed')
      }
      if (plan.unchanged.length) {
        console.log(`  • unchanged: ${plan.unchanged.length}`)
      }
    }
    if (plan.uploads.length) {
      console.log(`  • upload bundles: ${plan.uploads.length}`)
    }
  }

  async deploy({ dryRun = false, note = null } = {}) {
    const { manifest, bundles } = await this.buildManifest({ note })
    const remote = await this._readRemoteState()
    const plan = this._buildPlan({
      currentManifest: remote.manifest,
      nextManifest: manifest,
      bundles,
    })

    this._printPlan(plan)
    if (dryRun) {
      return { dryRun: true, plan, manifest }
    }
    if (!plan.manifestChanged) {
      console.log('✅ Mods already up to date')
      return { dryRun: false, plan, manifest: remote.manifest || manifest }
    }

    const lock = await this.adminClient.acquireDeployLock({
      owner: this._getLockOwner(),
      scope: MODS_SCOPE,
    })
    try {
      for (const upload of plan.uploads) {
        await this.adminClient.uploadAsset({
          filename: upload.filename,
          buffer: upload.buffer,
          mimeType: 'text/javascript',
        })
      }
      const deployedManifest = {
        ...manifest,
        deployedAt: new Date().toISOString(),
      }
      await this.adminClient.putModsManifest({
        manifest: deployedManifest,
        lockToken: lock.token,
      })

      console.log('✅ Mods deployed')
      if (plan.hasServerSystems) {
        console.log('⚠️  Server/shared mods deployed. Restart the world server to apply server-side changes.')
      }
      return { dryRun: false, plan, manifest: deployedManifest }
    } finally {
      await this.adminClient.releaseDeployLock({
        token: lock.token,
        scope: MODS_SCOPE,
      })
    }
  }
}
