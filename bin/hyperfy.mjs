#!/usr/bin/env node
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import readline from 'readline'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { customAlphabet } from 'nanoid'

import { HyperfyCLI, runAppCommand } from '../app-server/commands.js'
import { DirectAppServer } from '../app-server/direct.js'
import { applyTargetEnv, parseTargetArgs, resolveTarget, readTargets } from '../app-server/targets.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(__dirname, '..')
const projectDir = process.cwd()
const envPath = path.join(projectDir, '.env')

const ALPHABET = '1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
const uuid = customAlphabet(ALPHABET, 10)

const DEFAULT_WORLD_URL = 'http://localhost:5000'

function normalizeBaseUrl(url) {
  if (!url) return ''
  return url.replace(/\/+$/, '')
}

function parseDotEnv(content) {
  const env = {}
  if (!content) return env
  const lines = content.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const normalized = trimmed.startsWith('export ') ? trimmed.slice('export '.length) : trimmed
    const idx = normalized.indexOf('=')
    if (idx === -1) continue
    const key = normalized.slice(0, idx).trim()
    let value = normalized.slice(idx + 1).trim()
    if (!key) continue
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r')
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

function readDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return null
  return parseDotEnv(fs.readFileSync(filePath, 'utf8'))
}

function writeDotEnv(filePath, content) {
  fs.writeFileSync(filePath, content.endsWith('\n') ? content : `${content}\n`, 'utf8')
}

const TARGETS_FILE = path.join('.hyperfy', 'targets.json')

function writeTargetsFile(targets, rootDir = projectDir) {
  const filePath = path.join(rootDir, TARGETS_FILE)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(targets, null, 2) + '\n', 'utf8')
  return filePath
}

function isProjectEmpty(dirPath) {
  const ignore = new Set(['.git', '.DS_Store'])
  if (!fs.existsSync(dirPath)) return true
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  return entries.every(entry => ignore.has(entry.name))
}

function generateAdminCode() {
  return crypto.randomBytes(16).toString('base64url')
}

function generateDeployCode() {
  return crypto.randomBytes(16).toString('base64url')
}

function generateJwtSecret() {
  return crypto.randomBytes(32).toString('base64url')
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function waitForWorldReady(worldUrl, { timeoutMs = 60000, intervalMs = 500 } = {}) {
  const healthUrl = `${normalizeBaseUrl(worldUrl)}/health`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetchWithTimeout(healthUrl, 2000)
      if (res && res.ok) return true
    } catch {}
    await sleep(intervalMs)
  }
  return false
}

function parseWorldUrl(worldUrl) {
  try {
    return new URL(normalizeBaseUrl(worldUrl))
  } catch {
    return null
  }
}

function getUrlPort(url) {
  if (url.port) return url.port
  return url.protocol === 'https:' ? '443' : '80'
}

function deriveUrls(worldUrl) {
  const url = parseWorldUrl(worldUrl)
  if (!url) return null
  const base = `${url.protocol}//${url.host}`
  const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return {
    base,
    port: getUrlPort(url),
    wsUrl: `${wsProtocol}//${url.host}/ws`,
    apiUrl: `${base}/api`,
    assetsUrl: `${base}/assets`,
  }
}

function isLocalHost(hostname) {
  if (!hostname) return false
  if (hostname === 'localhost' || hostname === '::1') return true
  if (/^127\./.test(hostname)) return true
  const parts = hostname.split('.').map(Number)
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false
  if (parts[0] === 10) return true
  if (parts[0] === 192 && parts[1] === 168) return true
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
  return false
}

function isLocalWorld({ worldUrl }) {
  if (!worldUrl) return false
  const url = parseWorldUrl(worldUrl)
  if (!url) return false
  return isLocalHost(url.hostname)
}

function getWorldDir(worldId) {
  return path.join(os.homedir(), '.hyperfy', worldId)
}

function hasKey(env, key) {
  return Object.prototype.hasOwnProperty.call(env, key)
}

function isMissingValue(env, key) {
  return !hasKey(env, key) || env[key] === ''
}

function applyEnvToProcess(env) {
  if (!env) return
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value
  }
}

function buildDefaultEnv({ worldUrl, worldId, adminCode, jwtSecret }) {
  const derived = deriveUrls(worldUrl)
  if (!derived) throw new Error('Invalid WORLD_URL')

  const lines = []
  lines.push('# Hyperfy project environment')
  lines.push(`WORLD_URL=${normalizeBaseUrl(worldUrl)}`)
  lines.push(`WORLD_ID=${worldId}`)
  lines.push(`ADMIN_CODE=${adminCode}`)
  lines.push('')
  lines.push('# World server')
  lines.push(`PORT=${derived.port}`)
  lines.push(`JWT_SECRET=${jwtSecret}`)
  lines.push('SAVE_INTERVAL=60')
  lines.push('PUBLIC_PLAYER_COLLISION=false')
  lines.push('PUBLIC_MAX_UPLOAD_SIZE=12')
  lines.push(`PUBLIC_WS_URL=${derived.wsUrl}`)
  lines.push(`PUBLIC_API_URL=${derived.apiUrl}`)
  lines.push('')
  lines.push('# Assets')
  lines.push('ASSETS=local')
  lines.push(`ASSETS_BASE_URL=${derived.assetsUrl}`)
  lines.push('ASSETS_S3_URI=')
  lines.push('')
  lines.push('# Database')
  lines.push('DB_URI=local')
  lines.push('DB_SCHEMA=')
  lines.push('')
  lines.push('# Cleanup')
  lines.push('CLEAN=true')
  lines.push('')
  lines.push('# LiveKit (voice chat)')
  lines.push('LIVEKIT_WS_URL=')
  lines.push('LIVEKIT_API_KEY=')
  lines.push('LIVEKIT_API_SECRET=')
  lines.push('')
  lines.push('# AI')
  lines.push('AI_PROVIDER=anthropic')
  lines.push('AI_MODEL=claude-sonnet-4-20250514')
  lines.push('AI_EFFORT=medium')
  lines.push('AI_API_KEY=')
  lines.push('')
  lines.push('# Hooks to connect to a local app dev server')
  lines.push('PUBLIC_DEV_SERVER=false')
  return lines.join('\n') + '\n'
}

function validateBaseEnv(env) {
  const errors = []
  if (isMissingValue(env, 'WORLD_URL')) errors.push('WORLD_URL')
  if (isMissingValue(env, 'WORLD_ID')) errors.push('WORLD_ID')
  if (!hasKey(env, 'ADMIN_CODE')) errors.push('ADMIN_CODE')
  if (env.WORLD_URL && !parseWorldUrl(env.WORLD_URL)) {
    errors.push('WORLD_URL (invalid URL)')
  }
  return errors
}

function normalizeUrlValue(value) {
  if (!value) return ''
  return value.replace(/\/+$/, '')
}

function validateLocalEnv(env, derived) {
  const missing = []
  const required = [
    'PORT',
    'JWT_SECRET',
    'SAVE_INTERVAL',
    'PUBLIC_MAX_UPLOAD_SIZE',
    'PUBLIC_WS_URL',
    'PUBLIC_API_URL',
    'ASSETS',
    'ASSETS_BASE_URL',
  ]
  for (const key of required) {
    if (isMissingValue(env, key)) missing.push(key)
  }

  const issues = []
  if (missing.length) {
    issues.push(`Missing local world envs: ${missing.join(', ')}`)
  }
  if (env.PUBLIC_WS_URL && !env.PUBLIC_WS_URL.startsWith('ws://') && !env.PUBLIC_WS_URL.startsWith('wss://')) {
    issues.push('PUBLIC_WS_URL must start with ws:// or wss://')
  }
  if (env.ASSETS && env.ASSETS !== 'local' && env.ASSETS !== 's3') {
    issues.push("ASSETS must be 'local' or 's3'")
  }

  if (derived) {
    const expectedPort = derived.port
    if (env.PORT && env.PORT !== expectedPort) {
      issues.push(`PORT (${env.PORT}) does not match WORLD_URL port (${expectedPort})`)
    }
    if (env.PUBLIC_WS_URL && normalizeUrlValue(env.PUBLIC_WS_URL) !== derived.wsUrl) {
      issues.push(`PUBLIC_WS_URL should be ${derived.wsUrl}`)
    }
    if (env.PUBLIC_API_URL && normalizeUrlValue(env.PUBLIC_API_URL) !== derived.apiUrl) {
      issues.push(`PUBLIC_API_URL should be ${derived.apiUrl}`)
    }
    if (env.ASSETS_BASE_URL && normalizeUrlValue(env.ASSETS_BASE_URL) !== derived.assetsUrl) {
      issues.push(`ASSETS_BASE_URL should be ${derived.assetsUrl}`)
    }
  }

  return issues
}

async function confirmAction(prompt) {
  if (!process.stdin.isTTY) return false
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise(resolve => rl.question(prompt, resolve))
  rl.close()
  const normalized = (answer || '').trim().toLowerCase()
  return normalized === 'y' || normalized === 'yes'
}

async function promptValue(prompt) {
  if (!process.stdin.isTTY) return null
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise(resolve => rl.question(prompt, resolve))
  rl.close()
  const trimmed = typeof answer === 'string' ? answer.trim() : ''
  return trimmed || null
}

function ensureEnvForStart() {
  if (!fs.existsSync(envPath)) {
    if (!isProjectEmpty(projectDir)) {
      console.error('Error: Missing .env in a non-empty project.')
      console.error('Hint: Create a .env with WORLD_URL, WORLD_ID, ADMIN_CODE, and world server settings.')
      return { ok: false }
    }

    const worldId = `local-${uuid()}`
    const adminCode = generateAdminCode()
    const jwtSecret = generateJwtSecret()
    const envText = buildDefaultEnv({ worldUrl: DEFAULT_WORLD_URL, worldId, adminCode, jwtSecret })

    writeDotEnv(envPath, envText)
    console.log('Created .env with local world defaults.')
  }

  const env = readDotEnv(envPath)
  if (!env) {
    console.error('Error: Failed to read .env')
    return { ok: false }
  }
  applyEnvToProcess(env)
  return { ok: true, env }
}

function resolveServerPaths({ needsWorldServer }) {
  const worldServerPath = path.join(packageRoot, 'build', 'index.js')
  const appServerPath = path.join(packageRoot, 'app-server', 'server.js')
  if (!fs.existsSync(appServerPath)) {
    console.error(`Error: Missing app-server at ${appServerPath}`)
    return null
  }
  if (needsWorldServer && !fs.existsSync(worldServerPath)) {
    console.error(`Error: Missing build output at ${worldServerPath}`)
    console.error('Hint: Run the build before starting the server.')
    return null
  }
  return { worldServerPath, appServerPath }
}

function spawnProcess(label, command, args, options) {
  const child = spawn(command, args, { stdio: 'inherit', ...options })
  child.on('exit', (code, signal) => {
    if (signal) {
      console.error(`Error: ${label} exited with signal ${signal}`)
    } else if (code && code !== 0) {
      console.error(`Error: ${label} exited with code ${code}`)
    }
  })
  return child
}

async function startCommand(args = []) {
  let target = null
  try {
    const parsed = parseTargetArgs(args)
    target = parsed.target ? resolveTarget(projectDir, parsed.target) : null
  } catch (err) {
    console.error(`Error: ${err?.message || err}`)
    return 1
  }
  const envResult = ensureEnvForStart()
  if (!envResult.ok) return 1
  let env = envResult.env
  if (target) {
    applyTargetEnv(target)
    env = {
      ...env,
      WORLD_URL: target.worldUrl || env.WORLD_URL,
      WORLD_ID: target.worldId || env.WORLD_ID,
      ADMIN_CODE: typeof target.adminCode === 'string' ? target.adminCode : env.ADMIN_CODE,
      DEPLOY_CODE: typeof target.deployCode === 'string' ? target.deployCode : env.DEPLOY_CODE,
    }
  }

  const baseErrors = validateBaseEnv(env)
  if (baseErrors.length) {
    console.error('Error: Issues in .env:')
    for (const error of baseErrors) {
      console.error(`  - ${error}`)
    }
    console.error('Hint: Update .env and try again.')
    return 1
  }

  const derived = deriveUrls(env.WORLD_URL)
  if (!derived) {
    console.error('Error: WORLD_URL is invalid. Expected a full URL like http://localhost:5000')
    return 1
  }

  const localMode = isLocalWorld({ worldUrl: env.WORLD_URL, worldId: env.WORLD_ID })

  if (localMode) {
    const localIssues = validateLocalEnv(env, derived)
    if (localIssues.length) {
      console.error('Error: Local world configuration issues:')
      for (const issue of localIssues) {
        console.error(`  - ${issue}`)
      }
      console.error('Hint: Update .env and try again.')
      return 1
    }
  }

  const artifacts = resolveServerPaths({ needsWorldServer: localMode })
  if (!artifacts) return 1

  const envBase = { ...process.env, ...env }
  const children = []
  let worldChild = null

  if (localMode) {
    const worldDir = getWorldDir(env.WORLD_ID)
    const worldEnv = { ...envBase, WORLD: worldDir }
    console.log(`World: Starting local world server (${env.WORLD_URL})`)
    worldChild = spawnProcess('world server', process.execPath, [artifacts.worldServerPath], {
      cwd: projectDir,
      env: worldEnv,
    })
    children.push(worldChild)
    console.log('World: Waiting for server to be ready...')
    const ready = await waitForWorldReady(env.WORLD_URL)
    if (!ready) {
      console.error('Error: World server did not become ready in time.')
      if (worldChild && !worldChild.killed) worldChild.kill('SIGTERM')
      return 1
    }
  } else {
    console.log('World: Remote world detected, skipping local world server.')
  }

  console.log('Sync: Starting app-server sync')
  children.push(
    spawnProcess('app server', process.execPath, [artifacts.appServerPath], {
      cwd: projectDir,
      env: envBase,
    })
  )

  let shuttingDown = false
  const shutdown = (code = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    for (const child of children) {
      if (child && !child.killed) {
        child.kill('SIGTERM')
      }
    }
    setTimeout(() => process.exit(code), 250)
  }

  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))

  for (const child of children) {
    child.on('exit', (code, signal) => {
      if (shuttingDown) return
      const exitCode = signal ? 1 : code || 0
      shutdown(exitCode)
    })
  }

  return new Promise(() => {})
}

async function appsCommand(args) {
  if (!args.length || ['help', '--help', '-h'].includes(args[0])) {
    await runAppCommand({ command: 'help', args: [], rootDir: projectDir, helpPrefix: 'hyperfy apps' })
    return 0
  }

  let command = args[0]
  let commandArgs = args.slice(1)
  try {
    const parsed = parseTargetArgs(args)
    command = parsed.args[0]
    commandArgs = parsed.args.slice(1)
    if (parsed.target) {
      commandArgs.push('--target', parsed.target)
    }
  } catch (err) {
    console.error(`Error: ${err?.message || err}`)
    return 1
  }

  const env = readDotEnv(envPath)
  if (env) applyEnvToProcess(env)

  return runAppCommand({ command, args: commandArgs, rootDir: projectDir, helpPrefix: 'hyperfy apps' })
}

async function connectAdminServer({ worldUrl, adminCode, rootDir }) {
  let code = adminCode || process.env.ADMIN_CODE || null
  let server = new DirectAppServer({ worldUrl, adminCode: code, rootDir })
  try {
    await server.connect()
    return server
  } catch (err) {
    const msg = err?.message || ''
    const canRetry = (msg === 'invalid_code' || msg === 'unauthorized') && process.stdin.isTTY
    if (!canRetry) throw err
    code = await promptValue('Enter ADMIN_CODE: ')
    if (!code) throw err
    server = new DirectAppServer({ worldUrl, adminCode: code, rootDir })
    await server.connect()
    return server
  }
}

async function projectCommand(args) {
  if (!args.length || ['help', '--help', '-h'].includes(args[0])) {
    printHelp()
    return 0
  }

  if (args[0] !== 'reset') {
    console.error(`Error: Unknown project command: ${args[0]}`)
    printHelp()
    return 1
  }

  const force = args.includes('--force') || args.includes('-f')
  const cli = new HyperfyCLI({ rootDir: projectDir })
  await cli.reset({ force })
  return 0
}

async function worldsCommand(args) {
  if (!args.length || ['help', '--help', '-h'].includes(args[0]) || args[0] === 'list') {
    const root = path.join(os.homedir(), '.hyperfy')
    if (!fs.existsSync(root)) {
      console.log('Worlds: No local worlds found.')
      return 0
    }
    const entries = fs
      .readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)

    if (!entries.length) {
      console.log('Worlds: No local worlds found.')
      return 0
    }

    console.log('Worlds: Local worlds:')
    for (const entry of entries) {
      console.log(`  - ${entry}`)
    }
    return 0
  }

  console.error(`Error: Unknown worlds command: ${args[0]}`)
  printHelp()
  return 1
}

async function worldCommand(args) {
  if (!args.length || ['help', '--help', '-h'].includes(args[0])) {
    printHelp()
    return 0
  }

  const action = args[0]

  if (action === 'export' || action === 'import' || action === 'wipe') {
    const env = readDotEnv(envPath)
    if (!env) {
      console.error('Error: Missing .env in this project.')
      return 1
    }
    applyEnvToProcess(env)

    const worldUrl = env.WORLD_URL
    const worldId = env.WORLD_ID
    if (!worldUrl || !worldId) {
      console.error('Error: Missing WORLD_URL or WORLD_ID in .env')
      return 1
    }

    if (action === 'wipe') {
      if (!isLocalWorld({ worldUrl })) {
        console.error('Error: WORLD_URL does not indicate a local world. Refusing to wipe.')
        return 1
      }

      const worldDir = getWorldDir(worldId)
      if (!fs.existsSync(worldDir)) {
        console.log(`Worlds: No local world found at ${worldDir}`)
        return 0
      }

      const force = args.includes('--force') || args.includes('-f')
      if (!force) {
        const ok = await confirmAction(`Delete local world data at ${worldDir}? (y/N): `)
        if (!ok) {
          console.log('World wipe cancelled')
          return 1
        }
      }

      try {
        fs.rmSync(worldDir, { recursive: true, force: true })
        console.log(`Deleted ${worldDir}`)
        return 0
      } catch (error) {
        console.error(`Error: Failed to delete ${worldDir}`, error?.message || error)
        return 1
      }
    }

    let server
    try {
      server = await connectAdminServer({ worldUrl, adminCode: env.ADMIN_CODE, rootDir: projectDir })
      if (action === 'export') {
        await server.exportWorldToDisk()
        console.log('✅ World export complete')
      } else {
        await server.importWorldFromDisk()
        console.log('✅ World import complete')
      }
      return 0
    } catch (error) {
      console.error(`Error: World ${action} failed:`, error?.message || error)
      return 1
    } finally {
      try {
        server?.client?.ws?.close()
      } catch {}
    }
  }

  console.error(`Error: Unknown world command: ${args[0]}`)
  printHelp()
  return 1
}

function printFlyHelp() {
  console.log(`
Hyperfy Fly

Usage:
  hyperfy fly <command> [options]

Commands:
  init                      Generate fly.toml and optional GitHub workflow
  secrets                   Generate secrets + print fly secrets set command
  help                      Show this help

Init options:
  --app <name>              Fly app name (required)
  --region <code>           Fly region (default: ams)
  --persist                 Enable volume mount + SAVE_INTERVAL
  --world-id <id>           WORLD_ID override (default: fly-<app>)
  --target <name>           Update .hyperfy/targets.json with worldUrl/worldId
  --force, -f               Overwrite existing fly.toml / workflow

Secrets options:
  --target <name>           Update .hyperfy/targets.json with generated codes
  --no-deploy-code          Skip DEPLOY_CODE generation
  --force, -f               Overwrite existing target codes
`)
}

function buildFlyToml({ app, region, worldId, persist }) {
  const baseUrl = `https://${app}.fly.dev`
  const wsUrl = `wss://${app}.fly.dev/ws`
  const apiUrl = `${baseUrl}/api`
  const assetsUrl = `${baseUrl}/assets`
  const saveInterval = persist ? 60 : 0
  const lines = []
  lines.push(`app = "${app}"`)
  lines.push(`primary_region = "${region}"`)
  lines.push('')
  lines.push('[env]')
  lines.push('  NODE_ENV = "production"')
  lines.push('  PORT = "3000"')
  lines.push('  WORLD = "world"')
  lines.push(`  WORLD_ID = "${worldId}"`)
  lines.push(`  PUBLIC_WS_URL = "${wsUrl}"`)
  lines.push(`  PUBLIC_API_URL = "${apiUrl}"`)
  lines.push('  ASSETS = "local"')
  lines.push(`  ASSETS_BASE_URL = "${assetsUrl}"`)
  lines.push('  PUBLIC_MAX_UPLOAD_SIZE = "12"')
  lines.push(`  SAVE_INTERVAL = "${saveInterval}"`)
  lines.push('')
  lines.push('[http_service]')
  lines.push('  internal_port = 3000')
  lines.push('  force_https = true')
  if (persist) {
    lines.push('')
    lines.push('[[mounts]]')
    lines.push('  source = "data"')
    lines.push('  destination = "/app/world"')
  }
  return lines.join('\n') + '\n'
}

function buildFlyWorkflow() {
  return `name: Fly Deploy

on:
  push:
    branches:
      - main

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: superfly/flyctl-actions/setup-flyctl@master
      - run: flyctl deploy --remote-only
        env:
          FLY_API_TOKEN: \${{ secrets.FLY_API_TOKEN }}
`
}

function parseFlyInitArgs(args) {
  const options = {
    app: null,
    region: 'ams',
    persist: false,
    worldId: null,
    target: null,
    force: false,
    help: false,
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg === '--persist') {
      options.persist = true
      continue
    }
    if (arg === '--force' || arg === '-f') {
      options.force = true
      continue
    }
    if (arg === '--app') {
      const value = args[i + 1]
      if (!value || value.startsWith('-')) throw new Error('Missing value for --app')
      options.app = value
      i += 1
      continue
    }
    if (arg.startsWith('--app=')) {
      options.app = arg.slice('--app='.length)
      continue
    }
    if (arg === '--region') {
      const value = args[i + 1]
      if (!value || value.startsWith('-')) throw new Error('Missing value for --region')
      options.region = value
      i += 1
      continue
    }
    if (arg.startsWith('--region=')) {
      options.region = arg.slice('--region='.length)
      continue
    }
    if (arg === '--world-id') {
      const value = args[i + 1]
      if (!value || value.startsWith('-')) throw new Error('Missing value for --world-id')
      options.worldId = value
      i += 1
      continue
    }
    if (arg.startsWith('--world-id=')) {
      options.worldId = arg.slice('--world-id='.length)
      continue
    }
    if (arg === '--target') {
      const value = args[i + 1]
      if (!value || value.startsWith('-')) throw new Error('Missing value for --target')
      options.target = value
      i += 1
      continue
    }
    if (arg.startsWith('--target=')) {
      options.target = arg.slice('--target='.length)
      continue
    }
    throw new Error(`Unknown option: ${arg}`)
  }
  return options
}

function parseFlySecretsArgs(args) {
  const options = {
    target: null,
    deployCode: true,
    force: false,
    help: false,
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg === '--force' || arg === '-f') {
      options.force = true
      continue
    }
    if (arg === '--no-deploy-code') {
      options.deployCode = false
      continue
    }
    if (arg === '--deploy-code') {
      options.deployCode = true
      continue
    }
    if (arg === '--target') {
      const value = args[i + 1]
      if (!value || value.startsWith('-')) throw new Error('Missing value for --target')
      options.target = value
      i += 1
      continue
    }
    if (arg.startsWith('--target=')) {
      options.target = arg.slice('--target='.length)
      continue
    }
    throw new Error(`Unknown option: ${arg}`)
  }
  return options
}

async function flyInitCommand(args) {
  let options
  try {
    options = parseFlyInitArgs(args)
  } catch (err) {
    console.error(`Error: ${err?.message || err}`)
    return 1
  }
  if (options.help) {
    printFlyHelp()
    return 0
  }
  if (!options.app) {
    console.error('Error: --app is required for fly init')
    return 1
  }
  const worldId = options.worldId || `fly-${options.app}`
  const flyTomlPath = path.join(projectDir, 'fly.toml')
  if (fs.existsSync(flyTomlPath) && !options.force) {
    console.error('Error: fly.toml already exists (use --force to overwrite)')
    return 1
  }
  fs.writeFileSync(
    flyTomlPath,
    buildFlyToml({
      app: options.app,
      region: options.region,
      worldId,
      persist: options.persist,
    }),
    'utf8'
  )
  console.log(`Wrote ${flyTomlPath}`)

  const workflowPath = path.join(projectDir, '.github', 'workflows', 'fly-deploy.yml')
  if (!fs.existsSync(workflowPath) || options.force) {
    fs.mkdirSync(path.dirname(workflowPath), { recursive: true })
    fs.writeFileSync(workflowPath, buildFlyWorkflow(), 'utf8')
    console.log(`Wrote ${workflowPath}`)
  } else {
    console.log('Workflow: .github/workflows/fly-deploy.yml already exists, skipping.')
  }

  if (options.target) {
    let targets
    try {
      targets = readTargets(projectDir) || {}
    } catch (err) {
      console.error(`Error: ${err?.message || err}`)
      return 1
    }
    const entry = targets[options.target]
    const next = entry && typeof entry === 'object' ? { ...entry } : {}
    next.worldUrl = normalizeBaseUrl(`https://${options.app}.fly.dev`)
    next.worldId = worldId
    targets[options.target] = next
    const filePath = writeTargetsFile(targets, projectDir)
    console.log(`Updated ${filePath} (${options.target})`)
  }

  return 0
}

async function flySecretsCommand(args) {
  let options
  try {
    options = parseFlySecretsArgs(args)
  } catch (err) {
    console.error(`Error: ${err?.message || err}`)
    return 1
  }
  if (options.help) {
    printFlyHelp()
    return 0
  }

  const adminCode = generateAdminCode()
  const jwtSecret = generateJwtSecret()
  const deployCode = options.deployCode ? generateDeployCode() : null
  const parts = [`ADMIN_CODE=${adminCode}`, `JWT_SECRET=${jwtSecret}`]
  if (deployCode) parts.push(`DEPLOY_CODE=${deployCode}`)
  console.log(`fly secrets set ${parts.join(' ')}`)

  if (options.target) {
    let targets
    try {
      targets = readTargets(projectDir) || {}
    } catch (err) {
      console.error(`Error: ${err?.message || err}`)
      return 1
    }
    const entry = targets[options.target]
    const next = entry && typeof entry === 'object' ? { ...entry } : {}
    if (!options.force) {
      if (next.adminCode || (options.deployCode && next.deployCode)) {
        console.error(`Error: Target "${options.target}" already has codes (use --force to overwrite)`)
        return 1
      }
    }
    next.adminCode = adminCode
    if (deployCode) next.deployCode = deployCode
    next.confirm = true
    targets[options.target] = next
    const filePath = writeTargetsFile(targets, projectDir)
    console.log(`Updated ${filePath} (${options.target})`)
  }

  return 0
}

async function flyCommand(args) {
  if (!args.length || ['help', '--help', '-h'].includes(args[0])) {
    printFlyHelp()
    return 0
  }
  const action = args[0]
  const actionArgs = args.slice(1)
  if (action === 'init') {
    return flyInitCommand(actionArgs)
  }
  if (action === 'secrets') {
    return flySecretsCommand(actionArgs)
  }
  if (action === 'help') {
    printFlyHelp()
    return 0
  }
  console.error(`Error: Unknown fly command: ${action}`)
  printFlyHelp()
  return 1
}

function printHelp() {
  console.log(`
Hyperfy CLI

Usage:
  hyperfy <command> [options]

Commands:
  start                     Start the world (local or remote) + app-server sync
  dev                       Alias for start
  apps <command>            Manage apps (create, list, deploy, update, validate, status)
  fly <command>             Fly.io deployment helpers
  project reset [--force]   Delete local apps/assets/world.json in this project
  world export              Export world.json + apps/assets from the world
  world import              Import local apps + world.json into the world
  world wipe [--force]      Delete the local world runtime directory for this project
  worlds list               List local world directories in ~/.hyperfy
  help                      Show this help

Options:
  --target <name>           Use .hyperfy/targets.json entry (applies to start/dev/apps)
`)
}

async function main() {
  const [command, ...args] = process.argv.slice(2)

  switch (command) {
    case 'start':
    case 'dev':
      return startCommand(args)
    case 'apps':
      return appsCommand(args)
    case 'project':
      return projectCommand(args)
    case 'world':
      return worldCommand(args)
    case 'worlds':
      return worldsCommand(args)
    case 'fly':
      return flyCommand(args)
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      printHelp()
      return 0
    default:
      console.error(`Error: Unknown command: ${command}`)
      printHelp()
      return 1
  }
}

main()
  .then(exitCode => {
    if (typeof exitCode === 'number') process.exit(exitCode)
  })
  .catch(error => {
    console.error('Error: CLI Error:', error?.message || error)
    process.exit(1)
  })
