import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import readline from 'readline'

import { DirectAppServer } from './direct.js'
import { buildApp, formatBuildErrors } from './appBundler.js'
import { uuid } from './utils.js'
import { deriveBlueprintId, isBlueprintDenylist } from './blueprintUtils.js'
import { applyTargetEnv, parseTargetArgs, resolveTarget } from './targets.js'

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

function normalizeBaseUrl(url) {
  if (!url) return ''
  return url.replace(/\/+$/, '')
}

function joinUrl(base, pathname) {
  const a = normalizeBaseUrl(base)
  const b = (pathname || '').replace(/^\/+/, '')
  return `${a}/${b}`
}

function isValidAppName(name) {
  if (typeof name !== 'string') return false
  const trimmed = name.trim()
  if (!trimmed) return false
  if (trimmed.includes('/') || trimmed.includes('\\')) return false
  return true
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

function parseBuildArgs(args = []) {
  const options = { all: false }
  const rest = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--all' || arg === '-a') {
      options.all = true
      continue
    }
    rest.push(arg)
  }
  return { options, rest }
}

function formatLockSummary(lock) {
  if (!lock || typeof lock !== 'object') return ''
  const owner = lock.owner ? `owner: ${lock.owner}` : 'owner: unknown'
  const expiresIn =
    typeof lock.expiresInMs === 'number' ? `, expires in ${Math.ceil(lock.expiresInMs / 1000)}s` : ''
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
      const id = deriveBlueprintId(appName, fileBase)
      results.push({ appName, fileBase, id, configPath: path.join(appPath, file.name) })
    }
  }

  return results
}

function listLocalApps(appsDir) {
  if (!fs.existsSync(appsDir)) return []
  return fs
    .readdirSync(appsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
}

export class HyperfyCLI {
  constructor({ rootDir = process.cwd(), overrides = {} } = {}) {
    this.rootDir = rootDir
    this.appsDir = path.join(this.rootDir, 'apps')
    this.assetsDir = path.join(this.rootDir, 'assets')
    this.worldFile = path.join(this.rootDir, 'world.json')

    this.worldUrl = overrides.worldUrl || process.env.WORLD_URL || null
    this.adminCode =
      typeof overrides.adminCode === 'string'
        ? overrides.adminCode
        : typeof process.env.ADMIN_CODE === 'string'
          ? process.env.ADMIN_CODE
          : null
    this.deployCode =
      typeof overrides.deployCode === 'string'
        ? overrides.deployCode
        : typeof process.env.DEPLOY_CODE === 'string'
          ? process.env.DEPLOY_CODE
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
      deployCode: this.deployCode,
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
        deployCode: this.deployCode,
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

  async _buildAppBundle(appName) {
    try {
      const result = await buildApp({ rootDir: this.rootDir, appName })
      if (result.errors?.length) {
        console.error(`❌ App build failed for ${appName}`)
        const details = formatBuildErrors(result.errors)
        if (details.length) {
          for (const line of details) {
            console.error(`   ${line}`)
          }
        }
        return null
      }
      return result.outfile
    } catch (error) {
      console.error(`❌ App build failed for ${appName}:`, error?.message || error)
      return null
    }
  }

  async list() {
    console.log(`📋 Listing apps...`)

    const blueprints = listLocalBlueprints(this.appsDir)
    if (blueprints.length === 0) {
      console.log(`📝 No local blueprints found in ${this.appsDir}`)
      console.log(`💡 Run "gamedev world export" to pull blueprints from the world.`)
      console.log(`   Use --include-built-scripts if you need script code locally.`)
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

  async create(appName, options = {}) {
    if (!isValidAppName(appName)) {
      console.error(`❌ Invalid app name: ${appName}`)
      console.log(`💡 App names cannot contain / or \\`)
      return
    }

    console.log(`🚀 Creating new app: ${appName}`)

    const bundlePath = await this._buildAppBundle(appName)
    if (!bundlePath) return

    const server = await this._connectAdminClient()
    try {
      const scriptContent =
        options.script ||
        `// scripts exist inside apps, which are isolated from eachother but can communicate
// global variables: Vector3, Quaternion, Matrix4, Euler, fetch, num(min, max) (similar to Math.random)

// exposes variables to the UI (docs/scripting/app/Props.md)
app.configure([
  {
    type: "text",
    key: "color",
    label: "Box Color",
    placeholder: "Enter a hex color",
    initial: "#ff0000",
  },
]);

// create nodes (docs/scripting/nodes/types/**.md)
const group = app.create("group");
const box = app.create("prim", {
  type: "box",
  scale: [2, 1, 3],
  position: [0, 1, 0],
  color: props.color,
});
group.add(box);
app.add(group); // add to world space with world.add(group)

// networking (docs/scripting/Networking.md)
if (world.isServer) {
  app.on("ping", () => {
    console.log("ping heard on server of original app");
    app.emit("cross-app-ping", {});
  });
  world.on("cross-app-pong", () => {
    app.send("end", {});
  });
}

if (world.isClient) {
  // get player objects (docs/scripting/world/World.md)
  const localPlayer = world.getPlayer();
  world.on('enter', (player) => {
    console.log('player entered', player.playerId)
  })
  // client-side code
  app.on("end", () => {
    console.log("full loop ended");
  });
  app.send("ping", {});
}

app.on("update", (delta) => {
  // runs on both client and server
  // 'fixedUpdate' is better for physics
});
`

      const scriptHash = sha256Hex(scriptContent)
      const scriptFilename = `${scriptHash}.js`
      await server.client.uploadAsset({
        filename: scriptFilename,
        buffer: Buffer.from(scriptContent, 'utf8'),
        mimeType: 'text/javascript',
      })

      const existingIds = new Set(server.snapshot?.blueprints?.keys() || [])
      let fileBase = appName
      let blueprintId = deriveBlueprintId(appName, fileBase)
      let suffix = 2
      while (existingIds.has(blueprintId)) {
        fileBase = `${appName}_${suffix}`
        blueprintId = deriveBlueprintId(appName, fileBase)
        suffix += 1
      }

      const entityId = uuid()

      const blueprint = {
        id: blueprintId,
        version: 0,
        name: fileBase,
        image: null,
        author: null,
        url: null,
        desc: null,
        model: options.model || 'asset://Model.glb',
        script: `asset://${scriptFilename}`,
        props: options.props || {},
        preload: false,
        public: false,
        locked: false,
        frozen: false,
        unique: false,
        scene: false,
        disabled: false,
      }

      const entity = {
        id: entityId,
        type: 'app',
        blueprint: blueprintId,
        position: options.position || [0, 0, 0],
        quaternion: options.quaternion || [0, 0, 0, 1],
        scale: options.scale || [1, 1, 1],
        mover: null,
        uploader: null,
        pinned: false,
        props: {},
        state: options.state || {},
      }

      await server.client.request('blueprint_add', { blueprint })
      await server.client.request('entity_add', { entity })

      console.log(`✅ Successfully created app in world: ${appName}`)
      console.log(`   • Blueprint: ${blueprintId}`)
      console.log(`   • Entity:    ${entityId}`)
      console.log(`💡 Run "gamedev world export" to sync into ${this.appsDir}.`)
      console.log(`   Use --include-built-scripts if you need script code locally.`)
    } catch (error) {
      console.error(`❌ Error creating app:`, error?.message || error)
      if (!this.worldUrl) {
        console.error(`💡 Set WORLD_URL (and ADMIN_CODE if required)`) 
      }
    } finally {
      this._closeAdminClient(server)
    }
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
        build: false,
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

  async validate(appName) {
    if (!isValidAppName(appName)) {
      console.error(`❌ Invalid app name: ${appName}`)
      return
    }

    console.log(`🔍 Validating app: ${appName}`)

    const blueprints = listLocalBlueprints(this.appsDir).filter(item => item.appName === appName)
    if (!blueprints.length) {
      console.error(`❌ No blueprints found for ${appName}`)
      return
    }

    const bundlePath = await this._buildAppBundle(appName)
    if (!bundlePath) return

    const server = await this._connectAdminClient()
    try {
      const localText = fs.readFileSync(bundlePath, 'utf8')
      const localHash = sha256Hex(localText)
      const assetsUrl = server.assetsUrl

      let allMatch = true
      for (const blueprint of blueprints) {
        const remoteBlueprint = await server.client.getBlueprint(blueprint.id)
        const remoteScript = remoteBlueprint?.script
        if (!remoteScript) {
          console.error(`❌ World blueprint ${blueprint.id} has no script set`)
          allMatch = false
          continue
        }

        if (!remoteScript.startsWith('asset://')) {
          const matches = localText === String(remoteScript)
          if (!matches) {
            console.error(`❌ Script mismatch for ${blueprint.id} (inline script differs)`)
            allMatch = false
          }
          continue
        }

        const filename = remoteScript.slice('asset://'.length)
        const res = await fetch(joinUrl(assetsUrl, encodeURIComponent(filename)))
        if (!res.ok) {
          console.error(`❌ Failed to fetch remote script for ${blueprint.id}: ${res.status}`)
          allMatch = false
          continue
        }
        const remoteText = await res.text()
        const remoteHash = sha256Hex(remoteText)
        if (localHash !== remoteHash) {
          console.error(`❌ Script mismatch for ${blueprint.id}`)
          console.log(`🔗 Local:  ${localHash}`)
          console.log(`🔗 World:  ${remoteHash} (${filename})`)
          allMatch = false
        }
      }

      if (allMatch) {
        console.log(`✅ Script validation passed for ${appName}`)
        console.log(`🔗 Hash: ${localHash}`)
      } else {
        console.log(`💡 Run 'gamedev apps deploy ${appName}' (or save the file with app-server running)`) 
      }
    } catch (error) {
      console.error(`❌ Error validating app:`, error?.message || error)
    } finally {
      this._closeAdminClient(server)
    }
  }

  async build(appName, options = {}) {
    const appNames = options.all ? listLocalApps(this.appsDir) : [appName]
    if (!options.all && !isValidAppName(appName)) {
      console.error(`❌ Invalid app name: ${appName}`)
      return false
    }
    if (!appNames.length) {
      console.error(`❌ No local apps found in ${this.appsDir}`)
      return false
    }

    let ok = true
    for (const name of appNames) {
      if (!isValidAppName(name)) {
        console.error(`❌ Invalid app name: ${name}`)
        ok = false
        continue
      }
      const outfile = await this._buildAppBundle(name)
      if (!outfile) {
        ok = false
        continue
      }
      console.log(`✅ Built ${name}`)
    }
    return ok
  }

  async clean() {
    const distAppsDir = path.join(this.rootDir, 'dist', 'apps')
    if (!fs.existsSync(distAppsDir)) {
      console.log(`✅ dist/apps already clean`)
      return true
    }
    try {
      fs.rmSync(distAppsDir, { recursive: true, force: true })
      console.log(`✅ Cleaned dist/apps`)
      return true
    } catch (error) {
      console.error(`❌ Failed to clean dist/apps:`, error?.message || error)
      return false
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
      console.log(`✅ Reset complete!`)
    } catch (error) {
      console.error(`❌ Reset failed:`, error?.message || error)
    }
  }

  showHelp({ commandPrefix = 'gamedev apps' } = {}) {
    console.log(`
🚀 Gamedev CLI (direct /admin mode)

Usage:
  ${commandPrefix} <command> [options]

Commands:
  create <appName>           Create a new app in the connected world
  list                       List local apps in ./apps
  build <appName>            Build app bundle to ./dist/apps/<appName>.js
  build --all                Build bundles for all local apps
  deploy <appName>           Deploy all local blueprints under ./apps/<appName>
  update <appName>           Alias for deploy
  rollback [snapshotId]      Roll back the latest deploy snapshot (or by id)
  validate <appName>         Verify local script matches world blueprint script(s)
  clean                      Remove ./dist/apps build artifacts
  reset [--force]            Delete local apps/assets/world.json
  status                     Show /admin snapshot summary
  help                       Show this help
  --target <name>            Use .lobby/targets.json entry for WORLD_URL/WORLD_ID/ADMIN_CODE/DEPLOY_CODE

Options:
  --dry-run, -n              Show deploy plan without applying changes
  --note <text>              Attach a note to the deploy snapshot
  --all, -a                  Build all local apps (build only)
  --yes, -y                  Skip confirmation prompt (for prod targets)

Environment:
  WORLD_URL                  World server base URL (e.g. http://localhost:5000)
  WORLD_ID                   World ID (must match remote worldId)
  ADMIN_CODE                 Admin code (if the world requires it)
  DEPLOY_CODE                Deploy code (required for script updates when configured)

Notes:
  - Blueprints live at apps/<appName>/*.json with a shared index.ts/js script.
  - Start the direct app-server for continuous sync:
      WORLD_URL=... WORLD_ID=... ADMIN_CODE=... DEPLOY_CODE=... node <path-to-repo>/app-server/server.js
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
    case 'create':
      if (!args[0]) {
        console.error('❌ App name required')
        console.log(`Usage: ${commandPrefix} create <appName>`)
        return 1
      }
      await cli.create(args[0])
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

    case 'build': {
      try {
        const parsed = parseBuildArgs(args)
        const appName = parsed.rest[0] || null
        if (!parsed.options.all && !appName) {
          console.error('❌ App name required')
          console.log(`Usage: ${commandPrefix} build <appName>`)
          return 1
        }
        const ok = await cli.build(appName, parsed.options)
        if (!ok) exitCode = 1
      } catch (err) {
        console.error(`❌ ${err?.message || err}`)
        return 1
      }
      break
    }

    case 'validate':
      if (!args[0]) {
        console.error('❌ App name required')
        console.log(`Usage: ${commandPrefix} validate <appName>`)
        return 1
      }
      await cli.validate(args[0])
      break

    case 'clean': {
      const ok = await cli.clean()
      if (!ok) exitCode = 1
      break
    }

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
