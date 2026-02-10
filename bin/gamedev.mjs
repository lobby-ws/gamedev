#!/usr/bin/env node
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import readline from 'readline'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { customAlphabet } from 'nanoid'

import { runAppCommand, runScriptCommand } from '../app-server/commands.js'
import { runModsCommand } from '../app-server/mods-commands.js'
import { DirectAppServer } from '../app-server/direct.js'
import { scaffoldBaseProject, scaffoldBuiltins, updateBuiltins, writeManifest } from '../app-server/scaffold.js'
import { applyTargetEnv, parseTargetArgs, resolveTarget } from '../app-server/targets.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(__dirname, '..')
const projectDir = process.cwd()
const envPath = path.join(projectDir, '.env')

const ALPHABET = '1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
const uuid = customAlphabet(ALPHABET, 10)

const DEFAULT_WORLD_URL = 'http://localhost:3000'
const UPDATE_CHECK_TIMEOUT_MS = 1500
const UPDATE_CHECK_ENV = 'GAMEDEV_DISABLE_UPDATE_CHECK'

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

function generateAdminCode() {
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

function isUpdateCheckDisabled() {
  const value = process.env[UPDATE_CHECK_ENV]
  if (!value) return false
  if (value === '1') return true
  return value.toLowerCase() === 'true'
}

function getPackageInfo() {
  try {
    const packagePath = path.join(packageRoot, 'package.json')
    const raw = fs.readFileSync(packagePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return { name: parsed.name, version: parsed.version }
  } catch {
    return null
  }
}

function parseSemver(value) {
  if (!value) return null
  const cleaned = value.trim().replace(/^v/, '')
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/)
  if (!match) return null
  const prerelease = match[4] ? match[4].split('.').map(part => (/^\d+$/.test(part) ? Number(part) : part)) : null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  }
}

function compareSemver(left, right) {
  const a = parseSemver(left)
  const b = parseSemver(right)
  if (!a || !b) return 0
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1

  if (!a.prerelease && !b.prerelease) return 0
  if (!a.prerelease && b.prerelease) return 1
  if (a.prerelease && !b.prerelease) return -1

  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < length; i += 1) {
    const aId = a.prerelease[i]
    const bId = b.prerelease[i]
    if (aId === undefined) return -1
    if (bId === undefined) return 1
    const aIsNum = typeof aId === 'number'
    const bIsNum = typeof bId === 'number'
    if (aIsNum && bIsNum) {
      if (aId !== bId) return aId < bId ? -1 : 1
      continue
    }
    if (aIsNum !== bIsNum) return aIsNum ? -1 : 1
    if (aId !== bId) return aId < bId ? -1 : 1
  }

  return 0
}

async function checkForUpdates() {
  if (isUpdateCheckDisabled()) return
  const pkg = getPackageInfo()
  if (!pkg?.name || !pkg?.version) return

  const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/latest`
  let res
  try {
    res = await fetchWithTimeout(registryUrl, UPDATE_CHECK_TIMEOUT_MS)
  } catch {
    return
  }
  if (!res?.ok) return

  let data
  try {
    data = await res.json()
  } catch {
    return
  }

  const latest = data?.version
  if (!latest) return
  if (compareSemver(pkg.version, latest) >= 0) return

  const updateCommand = `npm install -D ${pkg.name}@latest`
  const npxCommand = `npx ${pkg.name}@latest`
  console.warn(
    `Update available for ${pkg.name}: ${pkg.version} -> ${latest}\n` +
      `Run "${updateCommand}" to update your project.`
  )
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
  return path.join(projectDir, '.lobby', worldId)
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
  lines.push(`ADMIN_CODE=`)
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
    const worldId = `local-xxxxxxxxxx`
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
    console.error('Error: WORLD_URL is invalid. Expected a full URL like http://localhost:3000')
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

async function appServerCommand(args = []) {
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

  const localMode = isLocalWorld({ worldUrl: env.WORLD_URL, worldId: env.WORLD_ID })

  const artifacts = resolveServerPaths({ needsWorldServer: false })
  if (!artifacts) return 1

  const appProjectDir = path.join(projectDir, 'project')
  fs.mkdirSync(appProjectDir, { recursive: true })

  if (localMode) {
    console.log(`World: Local world detected, waiting for server (${env.WORLD_URL})`)
    const ready = await waitForWorldReady(env.WORLD_URL)
    if (!ready) {
      console.error('Error: Local world server did not become ready in time.')
      console.error('Hint: Start the world server separately or run "gamedev dev".')
      return 1
    }
  } else {
    console.log('World: Remote world detected, skipping local world server.')
  }

  const envBase = { ...process.env, ...env }
  const children = []

  console.log('Sync: Starting app-server sync')
  children.push(
    spawnProcess('app server', process.execPath, [artifacts.appServerPath], {
      cwd: appProjectDir,
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

function printInitHelp() {
  console.log(`
Gamedev Init

Usage:
  gamedev init [options]

Options:
  --name <package>          Package name (defaults to folder name)
  --force, -f               Overwrite existing scaffold files
  --help, -h                Show this help
`)
}

function parseInitArgs(args) {
  const options = { name: null, force: false, help: false }
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
    if (arg === '--name') {
      const value = args[i + 1]
      if (!value || value.startsWith('-')) throw new Error('Missing value for --name')
      options.name = value
      i += 1
      continue
    }
    if (arg.startsWith('--name=')) {
      options.name = arg.slice('--name='.length)
      continue
    }
    throw new Error(`Unknown option: ${arg}`)
  }
  return options
}

async function initCommand(args = []) {
  let options
  try {
    options = parseInitArgs(args)
  } catch (err) {
    console.error(`Error: ${err?.message || err}`)
    return 1
  }
  if (options.help) {
    printInitHelp()
    return 0
  }

  let baseReport
  let builtinsReport
  let manifestReport
  try {
    baseReport = scaffoldBaseProject({
      rootDir: projectDir,
      packageName: options.name,
      force: options.force,
    })
    const builtins = scaffoldBuiltins({
      rootDir: projectDir,
      force: options.force,
    })
    builtinsReport = builtins.report
    manifestReport = writeManifest({
      rootDir: projectDir,
      manifest: builtins.manifest,
      force: options.force,
    })
  } catch (err) {
    console.error(`Error: Init failed: ${err?.message || err}`)
    return 1
  }

  const created = [...baseReport.created, ...builtinsReport.created, ...manifestReport.created]
  const updated = [...baseReport.updated, ...builtinsReport.updated, ...manifestReport.updated]
  const skipped = [...baseReport.skipped, ...builtinsReport.skipped, ...manifestReport.skipped]

  if (created.length) {
    console.log(`✅ Created ${created.length} file(s)`)
  }
  if (updated.length) {
    console.log(`✏️  Updated ${updated.length} file(s)`)
  }
  if (!created.length && !updated.length) {
    console.log('ℹ️  Nothing to scaffold (all files already exist)')
  }
  if (skipped.length && (created.length || updated.length)) {
    console.log(`↪️  Skipped ${skipped.length} existing file(s)`)
  }

  const envResult = ensureEnvForStart()
  if (!envResult.ok) return 1

  return 0
}

async function updateCommand() {
  let baseReport
  let builtinsReport
  try {
    baseReport = scaffoldBaseProject({
      rootDir: projectDir,
      force: true,
    })
    builtinsReport = updateBuiltins({
      rootDir: projectDir,
    })
  } catch (err) {
    console.error(`Error: Update failed: ${err?.message || err}`)
    return 1
  }

  const created = [...baseReport.created, ...builtinsReport.created]
  const updated = [...baseReport.updated, ...builtinsReport.updated]
  const skipped = [...baseReport.skipped, ...builtinsReport.skipped]
  const userModified = builtinsReport.userModified || []

  if (created.length) {
    console.log(`\u2705 Created ${created.length} file(s)`)
  }
  if (updated.length) {
    console.log(`\u270f\ufe0f  Updated ${updated.length} file(s)`)
  }
  if (!created.length && !updated.length) {
    console.log('\u2139\ufe0f  All files are up to date')
  }
  if (userModified.length) {
    console.log(`\u26a0\ufe0f  Skipped ${userModified.length} user-modified builtin(s):`)
    for (const filePath of userModified) {
      console.log(`   - ${path.relative(projectDir, filePath)}`)
    }
  }

  return 0
}

async function appsCommand(args) {
  if (!args.length || ['help', '--help', '-h'].includes(args[0])) {
    await runAppCommand({ command: 'help', args: [], rootDir: projectDir, helpPrefix: 'gamedev apps' })
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

  return runAppCommand({ command, args: commandArgs, rootDir: projectDir, helpPrefix: 'gamedev apps' })
}

async function scriptsCommand(args) {
  if (!args.length || ['help', '--help', '-h'].includes(args[0])) {
    await runScriptCommand({ command: 'help', args: [], rootDir: projectDir, helpPrefix: 'gamedev scripts' })
    return 0
  }

  const command = args[0]
  const commandArgs = args.slice(1)
  return runScriptCommand({ command, args: commandArgs, rootDir: projectDir, helpPrefix: 'gamedev scripts' })
}

async function modsCommand(args) {
  if (!args.length || ['help', '--help', '-h'].includes(args[0])) {
    await runModsCommand({ command: 'help', args: [], rootDir: projectDir, helpPrefix: 'gamedev mods' })
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

  return runModsCommand({ command, args: commandArgs, rootDir: projectDir, helpPrefix: 'gamedev mods' })
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

async function worldCommand(args) {
  if (!args.length || ['help', '--help', '-h'].includes(args[0])) {
    printHelp()
    return 0
  }

  const action = args[0]

  if (action === 'export' || action === 'import') {
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

    let server
    try {
      server = await connectAdminServer({ worldUrl, adminCode: env.ADMIN_CODE, rootDir: projectDir })
      if (action === 'export') {
        const includeBuiltScripts = args.includes('--include-built-scripts')
        await server.exportWorldToDisk(undefined, { includeBuiltScripts })
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

function printHelp() {
  console.log(`
Gamedev CLI

Usage:
  gamedev <command> [options]

Commands:
  init                      Scaffold a new world project in the current folder
  update                    Update SDK boilerplate files (preserves user modifications)
  dev                       Start the world (local or remote) + app-server sync
  app-server                Start app-server sync only (no world server)
  apps <command>            Manage apps (create, list, deploy, update, rollback, status)
  mods <command>            Manage mods (deploy)
  scripts <command>         Script migration helpers (migrate)
  world export              Export world.json + apps/assets from the world (module sources included; use --include-built-scripts for legacy apps)
  world import              Import local apps + world.json into the world
  help                      Show this help

Options:
  --target <name>           Use .lobby/targets.json entry (applies to dev/app-server/apps)
`)
}

async function main() {
  const updatePromise = checkForUpdates().catch(() => {})
  const [command, ...args] = process.argv.slice(2)
  let result

  switch (command) {
    case 'init':
      result = await initCommand(args)
      break
    case 'update':
      result = await updateCommand()
      break
    case 'dev':
      result = await startCommand(args)
      break
    case 'app-server':
      result = await appServerCommand(args)
      break
    case 'apps':
      result = await appsCommand(args)
      break
    case 'scripts':
      result = await scriptsCommand(args)
      break
    case 'mods':
      result = await modsCommand(args)
      break
    case 'world':
      result = await worldCommand(args)
      break
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      printHelp()
      result = 0
      break
    default:
      console.error(`Error: Unknown command: ${command}`)
      printHelp()
      result = 1
      break
  }

  if (typeof result === 'number') {
    await updatePromise
  }
  return result
}

main()
  .then(exitCode => {
    if (typeof exitCode === 'number') process.exit(exitCode)
  })
  .catch(error => {
    console.error('Error: CLI Error:', error?.message || error)
    process.exit(1)
  })
