import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import readline from 'readline'

import { DirectAppServer } from './direct.js'
import { uuid } from './utils.js'

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

export class HyperfyCLI {
  constructor({ rootDir = process.cwd() } = {}) {
    this.rootDir = rootDir
    this.appsDir = path.join(this.rootDir, 'apps')
    this.assetsDir = path.join(this.rootDir, 'assets')
    this.worldFile = path.join(this.rootDir, 'world.json')

    this.worldUrl = process.env.WORLD_URL || this._readWorldUrlFromDisk()
    this.adminCode = typeof process.env.ADMIN_CODE === 'string' ? process.env.ADMIN_CODE : null
  }

  _readWorldUrlFromDisk() {
    try {
      const state = this._readWorldState()
      return typeof state?.worldUrl === 'string' ? state.worldUrl : null
    } catch {
      return null
    }
  }

  _readWorldState() {
    if (!fs.existsSync(this.worldFile)) return null
    const data = JSON.parse(fs.readFileSync(this.worldFile, 'utf8'))
    if (!data || typeof data !== 'object') return null
    data.blueprints = data.blueprints && typeof data.blueprints === 'object' ? data.blueprints : {}
    return data
  }

  _writeWorldState(state) {
    fs.writeFileSync(this.worldFile, JSON.stringify(state, null, 2) + '\n', 'utf8')
  }

  _requireWorldUrl() {
    if (this.worldUrl) return this.worldUrl
    throw new Error('Missing WORLD_URL (or world.json with worldUrl)')
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

  async _connectAdminClient() {
    this._requireWorldUrl()

    let adminCode = this.adminCode
    if (!adminCode) {
      adminCode = await this._promptAdminCode()
      this.adminCode = adminCode
    }

    const server = new DirectAppServer({ worldUrl: this.worldUrl, adminCode, rootDir: this.rootDir })
    try {
      await server.client.connect()
      return server
    } catch (err) {
      const msg = err?.message || ''
      const canRetry = (msg === 'invalid_code' || msg === 'unauthorized') && process.stdin.isTTY
      if (!canRetry) throw err
      adminCode = await this._promptAdminCode()
      this.adminCode = adminCode
      const retryServer = new DirectAppServer({ worldUrl: this.worldUrl, adminCode, rootDir: this.rootDir })
      await retryServer.client.connect()
      return retryServer
    }
  }

  _closeAdminClient(server) {
    try {
      server?.client?.ws?.close()
    } catch {}
  }

  _findBlueprintIdByAppName(appName) {
    const state = this._readWorldState()
    const entries = state?.blueprints && typeof state.blueprints === 'object' ? Object.entries(state.blueprints) : []
    for (const [blueprintId, info] of entries) {
      if (info?.appName === appName) return blueprintId
    }
    return null
  }

  _getLocalScriptPath(appName) {
    const base = path.join(this.appsDir, appName)
    const ts = path.join(base, 'index.ts')
    const js = path.join(base, 'index.js')
    return fs.existsSync(ts) ? ts : js
  }

  async list() {
    console.log(`📋 Listing apps...`)

    const dirs = fs.existsSync(this.appsDir)
      ? fs
          .readdirSync(this.appsDir, { withFileTypes: true })
          .filter(e => e.isDirectory())
          .map(e => e.name)
      : []

    if (dirs.length === 0) {
      console.log(`📝 No local apps found in ${this.appsDir}`)
      console.log(`💡 Start the app-server in this folder to bootstrap from the world:`)
      console.log(`   WORLD_URL=<world url> ADMIN_CODE=<code> node <path-to-repo>/app-server/server.js`)
      return
    }

    const state = this._readWorldState()
    const blueprintByApp = new Map()
    if (state?.blueprints && typeof state.blueprints === 'object') {
      for (const [blueprintId, info] of Object.entries(state.blueprints)) {
        if (info?.appName) blueprintByApp.set(info.appName, { blueprintId, version: info.version })
      }
    }

    console.log(`\n📱 Found ${dirs.length} local app(s):`)
    for (const dir of dirs) {
      const link = blueprintByApp.get(dir)
      const suffix = link ? ` (${link.blueprintId}${typeof link.version === 'number' ? ` v${link.version}` : ''})` : ''
      console.log(`  • ${dir}${suffix}`)
      console.log(`    📁 ${path.join(this.appsDir, dir)}`)
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

      const blueprintId = uuid()
      const entityId = uuid()

      const blueprint = {
        id: blueprintId,
        version: 0,
        name: options.name || appName,
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
        state: options.state || {},
      }

      await server.client.request('blueprint_add', { blueprint })
      await server.client.request('entity_add', { entity })

      let assetsUrl = null
      try {
        const snapshot = await server.client.getSnapshot()
        assetsUrl = snapshot?.assetsUrl || null
      } catch {}

      const existing = this._readWorldState()
      const nextState = existing && typeof existing === 'object' ? existing : { worldUrl: this.worldUrl, assetsUrl: assetsUrl || null, blueprints: {} }
      nextState.worldUrl = this.worldUrl
      if (assetsUrl) nextState.assetsUrl = assetsUrl
      nextState.blueprints = nextState.blueprints && typeof nextState.blueprints === 'object' ? nextState.blueprints : {}
      nextState.blueprints[blueprintId] = { appName, version: blueprint.version }
      this._writeWorldState(nextState)

      console.log(`✅ Successfully created app in world: ${appName}`)
      console.log(`   • Blueprint: ${blueprintId}`)
      console.log(`   • Entity:    ${entityId}`)
      console.log(`💡 If app-server is running in this folder, it should sync into ${this.appsDir} shortly.`)
    } catch (error) {
      console.error(`❌ Error creating app:`, error?.message || error)
      if (!this.worldUrl) {
        console.error(`💡 Set WORLD_URL (and ADMIN_CODE if required)`)
      }
    } finally {
      this._closeAdminClient(server)
    }
  }

  async deploy(appName) {
    if (!isValidAppName(appName)) {
      console.error(`❌ Invalid app name: ${appName}`)
      return
    }

    console.log(`🚀 Deploying app: ${appName}`)

    const server = await this._connectAdminClient()
    try {
      const blueprintId = this._findBlueprintIdByAppName(appName)
      if (!blueprintId) {
        console.error(`❌ App ${appName} is not linked (missing in world.json)`)
        console.log(`💡 Start app-server in this folder to bootstrap/linking.`)
        return
      }

      await server._deployApp(appName)
      console.log(`✅ Deployed ${appName}`)
    } catch (error) {
      console.error(`❌ Error deploying app:`, error?.message || error)
    } finally {
      this._closeAdminClient(server)
    }
  }

  async update(appName) {
    // Legacy command retained; in direct mode this is equivalent to deploy.
    return this.deploy(appName)
  }

  async validate(appName) {
    if (!isValidAppName(appName)) {
      console.error(`❌ Invalid app name: ${appName}`)
      return
    }

    console.log(`🔍 Validating app: ${appName}`)

    const scriptPath = this._getLocalScriptPath(appName)
    if (!fs.existsSync(scriptPath)) {
      console.error(`❌ Script not found: ${scriptPath}`)
      return
    }

    const blueprintId = this._findBlueprintIdByAppName(appName)
    if (!blueprintId) {
      console.error(`❌ App ${appName} is not linked (missing in world.json)`)
      return
    }

    const server = await this._connectAdminClient()
    try {
      const blueprint = await server.client.getBlueprint(blueprintId)
      const remoteScript = blueprint?.script
      if (!remoteScript) {
        console.error(`❌ World blueprint has no script set`)
        return
      }

      const localText = fs.readFileSync(scriptPath, 'utf8')
      const localHash = sha256Hex(localText)

      if (!remoteScript.startsWith('asset://')) {
        const matches = localText === String(remoteScript)
        if (matches) {
          console.log(`✅ Script validation passed!`)
        } else {
          console.log(`❌ Script validation failed! (world script is inline, local differs)`)
        }
        return
      }

      const filename = remoteScript.slice('asset://'.length)
      let assetsUrl = this._readWorldState()?.assetsUrl || null
      if (!assetsUrl) {
        try {
          const snapshot = await server.client.getSnapshot()
          assetsUrl = snapshot?.assetsUrl || null
        } catch {}
      }
      if (!assetsUrl) {
        console.error(`❌ Missing assetsUrl (start app-server once to write world.json, or ensure /admin/snapshot works)`)
        return
      }

      const res = await fetch(joinUrl(assetsUrl, encodeURIComponent(filename)))
      if (!res.ok) {
        console.error(`❌ Failed to fetch remote script: ${res.status}`)
        return
      }
      const remoteText = await res.text()
      const remoteHash = sha256Hex(remoteText)

      if (localHash === remoteHash) {
        console.log(`✅ Script validation passed!`)
        console.log(`📝 ${path.basename(scriptPath)} matches the script currently set on the world blueprint`)
        console.log(`🔗 Hash: ${localHash}`)
      } else {
        console.log(`❌ Script validation failed!`)
        console.log(`🔗 Local:  ${localHash}`)
        console.log(`🔗 World:  ${remoteHash} (${filename})`)
        console.log(`💡 Run 'hyperfy deploy ${appName}' (or just save the file with app-server running)`)
      }
    } catch (error) {
      console.error(`❌ Error validating app:`, error?.message || error)
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

  showHelp({ commandPrefix = 'hyperfy apps' } = {}) {
    console.log(`
🚀 Hyperfy CLI (direct /admin mode)

Usage:
  ${commandPrefix} <command> [options]

Commands:
  create <appName>           Create a new app in the connected world
  list                       List local apps in ./apps
  deploy <appName>           Deploy local app (blueprint.json + index.js/ts) to world
  update <appName>           Alias for deploy
  validate <appName>         Verify local script matches world blueprint script
  reset [--force]            Delete local apps/assets/world.json
  status                     Show /admin snapshot summary
  help                       Show this help

Environment:
  WORLD_URL                  World server base URL (e.g. http://localhost:5000)
  ADMIN_CODE                 Admin code (if the world requires it)

Notes:
  - This CLI no longer talks to a local app-server HTTP API.
  - Start the direct app-server for continuous sync:
      WORLD_URL=... ADMIN_CODE=... node <path-to-repo>/app-server/server.js
`)
  }
}

export async function runAppCommand({ command, args = [], rootDir = process.cwd(), helpPrefix } = {}) {
  const cli = new HyperfyCLI({ rootDir })
  const commandPrefix = helpPrefix || 'hyperfy apps'
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
      if (!args[0]) {
        console.error('❌ App name required')
        console.log(`Usage: ${commandPrefix} deploy <appName>`)
        return 1
      }
      await cli.deploy(args[0])
      break

    case 'update':
      if (!args[0]) {
        console.error('❌ App name required')
        console.log(`Usage: ${commandPrefix} update <appName>`)
        return 1
      }
      await cli.update(args[0])
      break

    case 'list':
      await cli.list()
      break

    case 'validate':
      if (!args[0]) {
        console.error('❌ App name required')
        console.log(`Usage: ${commandPrefix} validate <appName>`)
        return 1
      }
      await cli.validate(args[0])
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
