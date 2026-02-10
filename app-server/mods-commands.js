import readline from 'readline'

import { DirectAppServer } from './direct.js'
import { ModsDeployer } from './mods.js'
import { applyTargetEnv, parseTargetArgs, resolveTarget } from './targets.js'

function parseDeployArgs(args = []) {
  const options = { dryRun: false, note: null }
  const rest = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--dry-run' || arg === '-n') {
      options.dryRun = true
      continue
    }
    if (arg === '--note') {
      const value = args[i + 1]
      if (!value || value.startsWith('-')) {
        throw new Error('Missing value for --note')
      }
      options.note = value
      i += 1
      continue
    }
    if (arg.startsWith('--note=')) {
      options.note = arg.slice('--note='.length)
      continue
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`)
    }
    rest.push(arg)
  }
  return { options, rest }
}

function parseOrderIds(args = []) {
  const ids = []
  for (const arg of args) {
    const chunks = String(arg)
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
    for (const id of chunks) ids.push(id)
  }
  if (!ids.length) {
    throw new Error('Order ids required. Example: gamedev mods order set mod.a,mod.b')
  }
  return ids
}

function formatLockSummary(lock) {
  if (!lock || typeof lock !== 'object') return ''
  const owner = lock.owner ? `owner: ${lock.owner}` : 'owner: unknown'
  const expiresIn = typeof lock.expiresInMs === 'number' ? `, expires in ${Math.ceil(lock.expiresInMs / 1000)}s` : ''
  return `${owner}${expiresIn}`
}

export class ModsCLI {
  constructor({ rootDir = process.cwd(), overrides = {} } = {}) {
    this.rootDir = rootDir
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

  async _connectAdminClient() {
    this._requireWorldUrl()
    let adminCode = this.adminCode
    if (!adminCode) {
      adminCode = await this._promptAdminCode()
      this.adminCode = adminCode
    }
    let server = new DirectAppServer({
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
      server = new DirectAppServer({
        worldUrl: this.worldUrl,
        adminCode,
        rootDir: this.rootDir,
      })
      await server.connect()
      return server
    }
  }

  _closeAdminClient(server) {
    try {
      server?.client?.ws?.close()
    } catch {}
  }

  async deploy(options = {}) {
    console.log('🚀 Deploying mods')
    const server = await this._connectAdminClient()
    try {
      const deployer = new ModsDeployer({
        rootDir: this.rootDir,
        adminClient: server.client,
        targetName: process.env.HYPERFY_TARGET || null,
      })
      await deployer.deploy({
        dryRun: !!options.dryRun,
        note: options.note || null,
      })
      if (options.dryRun) {
        console.log('✅ Mods dry run complete')
      }
    } catch (error) {
      if (error?.code === 'locked' || error?.code === 'deploy_locked') {
        const detail = formatLockSummary(error.lock)
        console.error(`❌ Deploy locked${detail ? ` (${detail})` : ''}`)
        return
      }
      if (error?.code === 'deploy_lock_required') {
        console.error('❌ Deploy lock required (acquire the lock and retry).')
        return
      }
      const detail = error?.detail ? ` (${error.detail})` : ''
      console.error(`❌ Mods deploy failed: ${error?.message || error}${detail}`)
    } finally {
      this._closeAdminClient(server)
    }
  }

  async orderShow() {
    console.log('📚 Mods load-order override')
    const server = await this._connectAdminClient()
    try {
      const state = await server.client.getModsState()
      const override = state?.loadOrderOverride
      if (!override) {
        console.log('  • override: none')
        return
      }
      console.log('  • override:')
      console.log(JSON.stringify(override, null, 2))
    } catch (error) {
      console.error(`❌ Failed to read mods order: ${error?.message || error}`)
    } finally {
      this._closeAdminClient(server)
    }
  }

  async orderSet(ids = []) {
    console.log('🧭 Setting mods load-order override')
    const server = await this._connectAdminClient()
    try {
      const lock = await server.client.acquireDeployLock({
        owner: `mods-order:${process.env.HYPERFY_TARGET || 'default'}:${process.pid}`,
        scope: 'mods',
      })
      try {
        await server.client.putModsLoadOrder({
          loadOrder: ids,
          lockToken: lock.token,
        })
        console.log(`✅ Override set (${ids.join(', ')})`)
      } finally {
        await server.client.releaseDeployLock({
          token: lock.token,
          scope: 'mods',
        })
      }
    } catch (error) {
      if (error?.code === 'locked' || error?.code === 'deploy_locked') {
        const detail = formatLockSummary(error.lock)
        console.error(`❌ Order update locked${detail ? ` (${detail})` : ''}`)
        return
      }
      console.error(`❌ Failed to set mods order: ${error?.message || error}`)
    } finally {
      this._closeAdminClient(server)
    }
  }

  async orderClear() {
    console.log('🧭 Clearing mods load-order override')
    const server = await this._connectAdminClient()
    try {
      const lock = await server.client.acquireDeployLock({
        owner: `mods-order:${process.env.HYPERFY_TARGET || 'default'}:${process.pid}`,
        scope: 'mods',
      })
      try {
        await server.client.clearModsLoadOrder({
          lockToken: lock.token,
        })
        console.log('✅ Override cleared')
      } finally {
        await server.client.releaseDeployLock({
          token: lock.token,
          scope: 'mods',
        })
      }
    } catch (error) {
      if (error?.code === 'locked' || error?.code === 'deploy_locked') {
        const detail = formatLockSummary(error.lock)
        console.error(`❌ Order update locked${detail ? ` (${detail})` : ''}`)
        return
      }
      console.error(`❌ Failed to clear mods order: ${error?.message || error}`)
    } finally {
      this._closeAdminClient(server)
    }
  }

  showHelp({ commandPrefix = 'gamedev mods' } = {}) {
    console.log(`
🧩 Mods CLI

Usage:
  ${commandPrefix} <command> [options]

Commands:
  deploy                     Build, upload, and publish mods from ./mods
  order show                 Show DB load-order override
  order set <ids>            Set DB load-order override (comma or space separated ids)
  order clear                Clear DB load-order override
  help                       Show this help
  --target <name>            Use .lobby/targets.json entry for WORLD_URL/WORLD_ID/ADMIN_CODE

Options (deploy):
  --dry-run, -n              Show deploy plan without applying changes
  --note <text>              Attach a deploy note to the mods manifest
`)
  }
}

export async function runModsCommand({ command, args = [], rootDir = process.cwd(), helpPrefix } = {}) {
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
  const cli = new ModsCLI({ rootDir })
  const commandPrefix = helpPrefix || 'gamedev mods'

  switch (command) {
    case 'deploy':
      try {
        const parsed = parseDeployArgs(args)
        if (parsed.rest.length) {
          throw new Error(`Unexpected arguments: ${parsed.rest.join(' ')}`)
        }
        await cli.deploy(parsed.options)
        return 0
      } catch (err) {
        console.error(`❌ ${err?.message || err}`)
        return 1
      }
    case 'help':
    case '--help':
    case '-h':
      cli.showHelp({ commandPrefix })
      return 0
    case 'order': {
      const op = args[0]
      if (!op || op === 'show') {
        await cli.orderShow()
        return 0
      }
      if (op === 'set') {
        try {
          const ids = parseOrderIds(args.slice(1))
          await cli.orderSet(ids)
          return 0
        } catch (err) {
          console.error(`❌ ${err?.message || err}`)
          return 1
        }
      }
      if (op === 'clear') {
        await cli.orderClear()
        return 0
      }
      console.error(`❌ Unknown order subcommand: ${op}`)
      return 1
    }
    default:
      if (command) {
        console.error(`❌ Unknown command: ${command}`)
      }
      cli.showHelp({ commandPrefix })
      return command ? 1 : 0
  }
}
