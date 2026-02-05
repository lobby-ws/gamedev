import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import readline from 'readline'
import { fileURLToPath } from 'url'
import { parse as acornParse } from 'acorn'

import { DirectAppServer } from './direct.js'
import { uuid } from './utils.js'
import { resolveBlueprintId, isBlueprintDenylist } from './blueprintUtils.js'
import { applyTargetEnv, parseTargetArgs, resolveTarget } from './targets.js'
import { buildLegacyBodyModuleSource } from '../src/core/legacyBody.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

function isValidAppName(name) {
  if (typeof name !== 'string') return false
  const trimmed = name.trim()
  if (!trimmed) return false
  if (trimmed.includes('/') || trimmed.includes('\\')) return false
  return true
}

function resolveBuiltinAssetPath(filename) {
  const buildPath = path.join(__dirname, '..', 'build', 'world', 'assets', filename)
  if (fs.existsSync(buildPath)) return buildPath
  const srcPath = path.join(__dirname, '..', 'src', 'world', 'assets', filename)
  if (fs.existsSync(srcPath)) return srcPath
  return null
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function parseDeployArgs(args = []) {
  const options = { dryRun: false, yes: false, note: null }
  const rest = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--dry-run' || arg === '-n') {
      options.dryRun = true
      continue
    }
    if (arg === '--yes' || arg === '-y') {
      options.yes = true
      continue
    }
    if (arg === '--note') {
      const next = args[i + 1]
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --note')
      }
      options.note = next
      i += 1
      continue
    }
    if (arg.startsWith('--note=')) {
      options.note = arg.slice('--note='.length)
      continue
    }
    rest.push(arg)
  }
  return { options, rest }
}

function formatLockSummary(lock) {
  if (!lock || typeof lock !== 'object') return ''
  const owner = lock.owner ? `owner: ${lock.owner}` : 'owner: unknown'
  const expiresIn = typeof lock.expiresInMs === 'number' ? `, expires in ${Math.ceil(lock.expiresInMs / 1000)}s` : ''
  return `${owner}${expiresIn}`
}

function listLocalBlueprints(appsDir) {
  const results = []
  if (!fs.existsSync(appsDir)) return results

  const apps = fs
    .readdirSync(appsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)

  for (const appName of apps) {
    const appPath = path.join(appsDir, appName)
    const files = fs.readdirSync(appPath, { withFileTypes: true })
    for (const file of files) {
      if (!file.isFile()) continue
      if (!file.name.endsWith('.json')) continue
      if (isBlueprintDenylist(file.name)) continue
      const fileBase = path.basename(file.name, '.json')
      const configPath = path.join(appPath, file.name)
      const cfg = readJson(configPath)
      const id = resolveBlueprintId(appName, fileBase, cfg)
      results.push({ appName, fileBase, id, configPath })
    }
  }

  return results
}

function getExportedName(node) {
  if (!node) return null
  if (node.type === 'Identifier') return node.name
  if (node.type === 'Literal') return String(node.value)
  return null
}

function entryHasDefaultExport(sourceText) {
  if (typeof sourceText !== 'string' || !sourceText.trim()) return false
  let ast
  try {
    ast = acornParse(sourceText, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
    })
  } catch {
    return false
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

function resolveEntryPath(appDir) {
  const tsPath = path.join(appDir, 'index.js')
  if (fs.existsSync(tsPath)) return tsPath
  const jsPath = path.join(appDir, 'index.js')
  if (fs.existsSync(jsPath)) return jsPath
  return null
}

function parseScriptMigrateArgs(args = []) {
  let mode = null
  const rest = []
  for (const arg of args) {
    if (arg === '--module') {
      mode = 'module'
      continue
    }
    if (arg === '--legacy-body') {
      mode = 'legacy-body'
      continue
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`)
    }
    rest.push(arg)
  }
  const appName = rest[0] || null
  return { mode, appName }
}

export class HyperfyCLI {
  constructor({ rootDir = process.cwd(), overrides = {} } = {}) {
    this.rootDir = rootDir
    this.appsDir = path.join(this.rootDir, 'apps')
    this.assetsDir = path.join(this.rootDir, 'assets')
    this.worldFile = path.join(this.rootDir, 'world.json')
    this.syncStateFile = path.join(this.rootDir, '.lobby', 'sync-state.json')

    this.worldUrl = overrides.worldUrl || process.env.WORLD_URL || null
    this.adminCode =
      typeof overrides.adminCode === 'string'
        ? overrides.adminCode
        : typeof process.env.ADMIN_CODE === 'string'
          ? process.env.ADMIN_CODE
          : null
  }

  _requireWorldUrl() {
    if (this.worldUrl) return this.worldUrl
    throw new Error('Missing WORLD_URL in environment')
  }

  async _promptAdminCode() {
    if (!process.stdin.isTTY) return null
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    const answer = await new Promise(resolve => {
      rl.question('Enter ADMIN_CODE: ', resolve)
    })
    rl.close()
    const trimmed = typeof answer === 'string' ? answer.trim() : ''
    return trimmed ? trimmed : null
  }

  async _confirmPrompt(message) {
    if (!process.stdin.isTTY) return false
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    const answer = await new Promise(resolve => {
      rl.question(message, resolve)
    })
    rl.close()
    const normalized = typeof answer === 'string' ? answer.trim().toLowerCase() : ''
    return normalized === 'y' || normalized === 'yes'
  }

  _shouldConfirmDeployTarget() {
    const target = (process.env.HYPERFY_TARGET || '').toLowerCase()
    if (target === 'prod' || target === 'production') return true
    return process.env.HYPERFY_TARGET_CONFIRM === 'true'
  }

  async _connectAdminClient() {
    this._requireWorldUrl()

    let adminCode = this.adminCode
    if (!adminCode) {
      adminCode = await this._promptAdminCode()
      this.adminCode = adminCode
    }

    const server = new DirectAppServer({
      worldUrl: this.worldUrl,
      adminCode,
      rootDir: this.rootDir,
    })
    try {
      await server.connect()
      return server
    } catch (err) {
      const msg = err?.message || ''
      const canRetry = (msg === 'invalid_code' || msg === 'unauthorized') && process.stdin.isTTY
      if (!canRetry) throw err
      adminCode = await this._promptAdminCode()
      this.adminCode = adminCode
      const retryServer = new DirectAppServer({
        worldUrl: this.worldUrl,
        adminCode,
        rootDir: this.rootDir,
      })
      await retryServer.connect()
      return retryServer
    }
  }

  _closeAdminClient(server) {
    try {
      server?.client?.ws?.close()
    } catch {}
  }

  async list() {
    console.log(`📋 Listing apps...`)

    const blueprints = listLocalBlueprints(this.appsDir)
    if (blueprints.length === 0) {
      console.log(`📝 No local blueprints found in ${this.appsDir}`)
      console.log(`💡 Run "gamedev world export" to pull blueprints from the world.`)
      console.log(`   Use --include-built-scripts for legacy single-file scripts.`)
      return
    }

    const byApp = new Map()
    for (const item of blueprints) {
      if (!byApp.has(item.appName)) byApp.set(item.appName, [])
      byApp.get(item.appName).push(item)
    }

    console.log(`\n📱 Found ${byApp.size} local app folder(s):`)
    for (const [appName, items] of byApp.entries()) {
      console.log(`  • ${appName}`)
      for (const item of items) {
        console.log(`    - ${item.fileBase} (${item.id})`)
      }
      console.log(`    📁 ${path.join(this.appsDir, appName)}`)
      console.log(``)
    }
  }

  async new(appName) {
    if (!isValidAppName(appName)) {
      console.error(`❌ Invalid app name: ${appName}`)
      console.log(`💡 App names cannot contain / or \\`)
      return
    }

    const appDir = path.join(this.appsDir, appName)
    if (fs.existsSync(appDir)) {
      console.error(`❌ App folder already exists: ${appDir}`)
      return
    }

    console.log(`🧩 Creating local app: ${appName}`)
    const assetDest = path.join(this.assetsDir, 'Model.glb')
    if (!fs.existsSync(assetDest)) {
      const assetSrc = resolveBuiltinAssetPath('Model.glb')
      if (!assetSrc) {
        console.error('❌ Missing builtin asset Model.glb')
        console.log(`💡 Expected Model.glb in build/world/assets or src/world/assets`)
        return
      }
      fs.mkdirSync(this.assetsDir, { recursive: true })
      fs.copyFileSync(assetSrc, assetDest)
    }

    fs.mkdirSync(appDir, { recursive: true })

    const blueprintPath = path.join(appDir, `${appName}.json`)
    const blueprint = {
      id: appName,
      model: 'assets/Model.glb',
      scriptFormat: 'module',
      image: {
        url: 'assets/Model.png',
      },
      props: {},
      preload: false,
      public: false,
      locked: false,
      frozen: false,
      unique: false,
      scene: false,
      disabled: false,
    }
    fs.writeFileSync(blueprintPath, JSON.stringify(blueprint, null, 2) + '\n', 'utf8')

    const scriptPath = path.join(appDir, 'index.js')
    if (!fs.existsSync(scriptPath)) {
      const script = `export default (world, app, fetch, props, setTimeout) => {
  app.on('update', () => {})
}
`
      fs.writeFileSync(scriptPath, script, 'utf8')
    }

    console.log(`✅ Created ${appName}`)
    console.log(`   • ${blueprintPath}`)
    console.log(`   • ${scriptPath}`)
    console.log(`   • ${assetDest}`)
  }

  async deploy(appName, options = {}) {
    if (!isValidAppName(appName)) {
      console.error(`❌ Invalid app name: ${appName}`)
      return
    }

    const blueprints = listLocalBlueprints(this.appsDir).filter(item => item.appName === appName)
    if (!blueprints.length) {
      console.error(`❌ No blueprints found for ${appName}`)
      console.log(`💡 Expected ${path.join(this.appsDir, appName, '<blueprint>.json')}`)
      return
    }

    console.log(`🚀 Deploying app: ${appName}`)

    const server = await this._connectAdminClient()
    try {
      if (!options.dryRun && !options.yes && this._shouldConfirmDeployTarget()) {
        const target = process.env.HYPERFY_TARGET ? ` "${process.env.HYPERFY_TARGET}"` : ''
        const ok = await this._confirmPrompt(`Confirm deploy to${target}? (y/N): `)
        if (!ok) {
          console.log('❌ Deploy cancelled')
          return
        }
      }
      await server.deployApp(appName, {
        dryRun: options.dryRun,
        note: options.note,
      })
      if (options.dryRun) {
        console.log(`✅ Dry run complete`)
      } else {
        console.log(`✅ Deployed ${appName}`)
      }
    } catch (error) {
      if (error?.code === 'locked' || error?.code === 'deploy_locked') {
        const detail = formatLockSummary(error.lock)
        console.error(`❌ Deploy locked${detail ? ` (${detail})` : ''}`)
        return
      }
      if (error?.code === 'deploy_lock_required') {
        console.error(`❌ Deploy lock required (acquire the lock and retry).`)
        return
      }
      console.error(`❌ Error deploying app:`, error?.message || error)
    } finally {
      this._closeAdminClient(server)
    }
  }

  async update(appName, options = {}) {
    return this.deploy(appName, options)
  }

  async rollback(snapshotId) {
    console.log(`⏪ Rolling back deploy snapshot...`)
    const server = await this._connectAdminClient()
    try {
      const owner = `hyperfy-cli:${process.env.HYPERFY_TARGET || 'default'}:${process.pid}`
      const lock = await server.client.acquireDeployLock({ owner })
      try {
        const result = await server.client.rollbackDeploySnapshot({ id: snapshotId, lockToken: lock.token })
        console.log(`✅ Rollback complete`)
        if (Array.isArray(result?.restored) && result.restored.length) {
          console.log(`   • Restored ${result.restored.length} blueprint(s)`)
        }
        if (Array.isArray(result?.failed) && result.failed.length) {
          console.log(`⚠️  Failed to restore ${result.failed.length} blueprint(s)`)
        }
      } finally {
        await server.client.releaseDeployLock({ token: lock.token })
      }
    } catch (error) {
      if (error?.code === 'locked' || error?.code === 'deploy_locked') {
        const detail = formatLockSummary(error.lock)
        console.error(`❌ Rollback locked${detail ? ` (${detail})` : ''}`)
        return
      }
      if (error?.code === 'deploy_lock_required') {
        console.error(`❌ Deploy lock required (acquire the lock and retry).`)
        return
      }
      console.error(`❌ Rollback failed:`, error?.message || error)
    } finally {
      this._closeAdminClient(server)
    }
  }

  async status() {
    console.log(`📊 Admin Status`)
    const server = await this._connectAdminClient()
    try {
      const snapshot = await server.client.getSnapshot()
      const blueprints = Array.isArray(snapshot?.blueprints) ? snapshot.blueprints.length : 0
      const entities = Array.isArray(snapshot?.entities) ? snapshot.entities.length : 0
      console.log(`  World URL:   ${this.worldUrl}`)
      console.log(`  World ID:    ${snapshot?.worldId || 'unknown'}`)
      console.log(`  Assets URL:  ${snapshot?.assetsUrl || 'unknown'}`)
      console.log(`  Blueprints:  ${blueprints}`)
      console.log(`  Entities:    ${entities}`)
    } catch (error) {
      console.error(`❌ Status failed:`, error?.message || error)
    } finally {
      this._closeAdminClient(server)
    }
  }

  async reset(options = {}) {
    const force = options.force || false

    if (!force) {
      console.log(`⚠️  This will permanently delete:`)
      console.log(`   • Local apps in ${this.appsDir}`)
      console.log(`   • Local assets in ${this.assetsDir}`)
      console.log(`   • ${this.worldFile}`)
      console.log(`   • ${this.syncStateFile}`)
      console.log(``)

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      })

      const answer = await new Promise(resolve => {
        rl.question('Are you sure you want to reset local state? (yes/no): ', resolve)
      })
      rl.close()

      if (answer.toLowerCase() !== 'yes' && answer.toLowerCase() !== 'y') {
        console.log('❌ Reset cancelled')
        return
      }
    }

    try {
      if (fs.existsSync(this.appsDir)) {
        fs.rmSync(this.appsDir, { recursive: true, force: true })
      }
      if (fs.existsSync(this.assetsDir)) {
        fs.rmSync(this.assetsDir, { recursive: true, force: true })
      }
      if (fs.existsSync(this.worldFile)) {
        fs.rmSync(this.worldFile, { force: true })
      }
      if (fs.existsSync(this.syncStateFile)) {
        fs.rmSync(this.syncStateFile, { force: true })
      }
      console.log(`✅ Reset complete!`)
    } catch (error) {
      console.error(`❌ Reset failed:`, error?.message || error)
    }
  }

  async migrateScripts({ mode, appName } = {}) {
    if (mode !== 'module' && mode !== 'legacy-body') {
      console.error('❌ Migration mode required: use --module or --legacy-body')
      return false
    }
    if (appName && !isValidAppName(appName)) {
      console.error(`❌ Invalid app name: ${appName}`)
      return false
    }

    const blueprints = listLocalBlueprints(this.appsDir).filter(item => (appName ? item.appName === appName : true))
    if (!blueprints.length) {
      console.error(`❌ No blueprints found${appName ? ` for ${appName}` : ''}`)
      return false
    }

    const byApp = new Map()
    for (const item of blueprints) {
      if (!byApp.has(item.appName)) byApp.set(item.appName, [])
      byApp.get(item.appName).push(item)
    }

    let updated = 0
    let ok = true
    for (const [name, items] of byApp.entries()) {
      const appDir = path.join(this.appsDir, name)
      let canSetFormat = true

      if (mode === 'module') {
        const entryPath = resolveEntryPath(appDir)
        if (!entryPath) {
          console.error(`❌ Missing entry script for ${name} (index.js/js)`)
          ok = false
          canSetFormat = false
        } else {
          const entryText = fs.readFileSync(entryPath, 'utf8')
          if (!entryHasDefaultExport(entryText)) {
            try {
              const moduleSource = buildLegacyBodyModuleSource(entryText, entryPath)
              if (moduleSource !== entryText) {
                fs.writeFileSync(entryPath, moduleSource, 'utf8')
              }
            } catch (err) {
              console.error(`❌ Failed to convert ${name} entry:`, err?.message || err)
              ok = false
              canSetFormat = false
            }
          }
        }
      }

      if (!canSetFormat) continue

      for (const item of items) {
        try {
          const raw = fs.readFileSync(item.configPath, 'utf8')
          const data = JSON.parse(raw)
          if (data.scriptFormat === mode) continue
          data.scriptFormat = mode
          fs.writeFileSync(item.configPath, JSON.stringify(data, null, 2) + '\n', 'utf8')
          updated += 1
        } catch (err) {
          console.error(`❌ Failed to update ${item.configPath}:`, err?.message || err)
          ok = false
        }
      }
    }

    if (updated) {
      console.log(`✅ Updated scriptFormat in ${updated} blueprint file(s).`)
    } else if (ok) {
      console.log('✅ No scriptFormat changes needed.')
    }

    return ok
  }

  showHelp({ commandPrefix = 'gamedev apps' } = {}) {
    console.log(`
🚀 Gamedev CLI (direct /admin mode)

Usage:
  ${commandPrefix} <command> [options]

Commands:
  new <appName>              Create a local app folder + blueprint
  list                       List local apps in ./apps
  deploy <appName>           Deploy all local blueprints under ./apps/<appName>
  update <appName>           Alias for deploy
  rollback [snapshotId]      Roll back the latest deploy snapshot (or by id)
  reset [--force]            Delete local apps/assets/world.json
  status                     Show /admin snapshot summary
  help                       Show this help
  --target <name>            Use .lobby/targets.json entry for WORLD_URL/WORLD_ID/ADMIN_CODE

Options:
  --dry-run, -n              Show deploy plan without applying changes
  --note <text>              Attach a note to the deploy snapshot
  --yes, -y                  Skip confirmation prompt (for prod targets)

Environment:
  WORLD_URL                  World server base URL (e.g. http://localhost:3000)
  WORLD_ID                   World ID (must match remote worldId)
  ADMIN_CODE                 Admin code (if the world requires it)

Notes:
  - Blueprints live at apps/<appName>/*.json with a shared index.js/js script.
  - Start the direct app-server for continuous sync:
      WORLD_URL=... WORLD_ID=... ADMIN_CODE=... node <path-to-repo>/app-server/server.js
`)
  }
}

export async function runAppCommand({ command, args = [], rootDir = process.cwd(), helpPrefix } = {}) {
  let targetName = null
  try {
    const parsed = parseTargetArgs(args)
    targetName = parsed.target
    args = parsed.args
  } catch (err) {
    console.error(`❌ ${err?.message || err}`)
    return 1
  }
  if (targetName) {
    try {
      const target = resolveTarget(rootDir, targetName)
      applyTargetEnv(target)
    } catch (err) {
      console.error(`❌ ${err?.message || err}`)
      return 1
    }
  }
  const cli = new HyperfyCLI({ rootDir })
  const commandPrefix = helpPrefix || 'gamedev apps'
  let exitCode = 0

  switch (command) {
    case 'new':
      if (!args[0]) {
        console.error('❌ App name required')
        console.log(`Usage: ${commandPrefix} new <appName>`)
        return 1
      }
      await cli.new(args[0])
      break

    case 'deploy':
      try {
        const parsed = parseDeployArgs(args)
        const appName = parsed.rest[0]
        if (!appName) {
          console.error('❌ App name required')
          console.log(`Usage: ${commandPrefix} deploy <appName>`)
          return 1
        }
        await cli.deploy(appName, parsed.options)
      } catch (err) {
        console.error(`❌ ${err?.message || err}`)
        return 1
      }
      break

    case 'update':
      try {
        const parsed = parseDeployArgs(args)
        const appName = parsed.rest[0]
        if (!appName) {
          console.error('❌ App name required')
          console.log(`Usage: ${commandPrefix} update <appName>`)
          return 1
        }
        await cli.update(appName, parsed.options)
      } catch (err) {
        console.error(`❌ ${err?.message || err}`)
        return 1
      }
      break

    case 'rollback':
      await cli.rollback(args[0])
      break

    case 'list':
      await cli.list()
      break

    case 'reset': {
      const force = args.includes('--force') || args.includes('-f')
      await cli.reset({ force })
      break
    }

    case 'status':
      await cli.status()
      break

    case 'help':
    case '--help':
    case '-h':
      cli.showHelp({ commandPrefix })
      break

    default:
      if (command) {
        console.error(`❌ Unknown command: ${command}`)
        exitCode = 1
      }
      cli.showHelp({ commandPrefix })
  }

  return exitCode
}

function showScriptsHelp({ commandPrefix = 'gamedev scripts' } = {}) {
  console.log(`
🔧 Script migration helper

Usage:
  ${commandPrefix} <command> [options]

Commands:
  migrate                   Set scriptFormat across local blueprints
  help                      Show this help

Options (migrate):
  --module                  Convert legacy entry bodies to modules and set scriptFormat: "module"
  --legacy-body             Set scriptFormat: "legacy-body" without rewriting scripts

Examples:
  ${commandPrefix} migrate --module
  ${commandPrefix} migrate --legacy-body MyApp
`)
}

export async function runScriptCommand({ command, args = [], rootDir = process.cwd(), helpPrefix } = {}) {
  const cli = new HyperfyCLI({ rootDir })
  const commandPrefix = helpPrefix || 'gamedev scripts'
  let exitCode = 0

  switch (command) {
    case 'migrate': {
      try {
        const parsed = parseScriptMigrateArgs(args)
        if (!parsed.mode) {
          console.error('❌ Migration mode required: use --module or --legacy-body')
          showScriptsHelp({ commandPrefix })
          return 1
        }
        const ok = await cli.migrateScripts({ mode: parsed.mode, appName: parsed.appName })
        if (!ok) exitCode = 1
      } catch (err) {
        console.error(`❌ ${err?.message || err}`)
        return 1
      }
      break
    }

    case 'help':
    case '--help':
    case '-h':
      showScriptsHelp({ commandPrefix })
      break

    default:
      if (command) {
        console.error(`❌ Unknown command: ${command}`)
        exitCode = 1
      }
      showScriptsHelp({ commandPrefix })
  }

  return exitCode
}
