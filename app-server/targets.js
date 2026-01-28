import fs from 'fs'
import path from 'path'

const TARGETS_FILE = path.join('.lobby', 'targets.json')

export function parseTargetArgs(args = []) {
  let target = null
  const rest = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--target') {
      const next = args[i + 1]
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --target')
      }
      target = next
      i += 1
      continue
    }
    if (arg.startsWith('--target=')) {
      target = arg.slice('--target='.length)
      continue
    }
    rest.push(arg)
  }
  return { target, args: rest }
}

export function readTargets(rootDir) {
  const filePath = path.join(rootDir, TARGETS_FILE)
  if (!fs.existsSync(filePath)) return null
  const raw = fs.readFileSync(filePath, 'utf8')
  let data
  try {
    data = JSON.parse(raw)
  } catch (err) {
    throw new Error(`Invalid JSON in ${filePath}`)
  }
  if (!data || typeof data !== 'object') {
    throw new Error(`Invalid targets config in ${filePath}`)
  }
  return data
}

export function resolveTarget(rootDir, name) {
  if (!name) return null
  const targets = readTargets(rootDir)
  if (!targets) {
    throw new Error(`Missing ${path.join(rootDir, TARGETS_FILE)}`)
  }
  const target = targets[name]
  if (!target || typeof target !== 'object') {
    throw new Error(`Unknown target "${name}" in ${path.join(rootDir, TARGETS_FILE)}`)
  }
  if (!target.worldUrl || !target.worldId) {
    throw new Error(`Target "${name}" must include worldUrl and worldId`)
  }
  return { ...target, name }
}

export function applyTargetEnv(target) {
  if (!target || typeof target !== 'object') return
  if (typeof target.name === 'string') process.env.HYPERFY_TARGET = target.name
  if (typeof target.worldUrl === 'string') process.env.WORLD_URL = target.worldUrl
  if (typeof target.worldId === 'string') process.env.WORLD_ID = target.worldId
  if (typeof target.adminCode === 'string') process.env.ADMIN_CODE = target.adminCode
  if (target.confirm === true || target.requireConfirm === true || target.requiresConfirm === true) {
    process.env.HYPERFY_TARGET_CONFIRM = 'true'
  }
}
