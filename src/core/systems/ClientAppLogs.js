import { System } from './System'

export const MAX_APP_LOG_ENTRIES = 20

const MAX_LOG_ARGS = 8
const MAX_LOG_ARG_LENGTH = 400
const MAX_LOG_MESSAGE_LENGTH = 1200
const allowedLevels = new Set(['log', 'warn', 'error', 'time', 'timeEnd'])

function normalizeAppId(appId) {
  if (typeof appId !== 'string') return null
  const value = appId.trim()
  return value || null
}

function truncateString(value, maxLength) {
  if (typeof value !== 'string') return ''
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}...`
}

function serializeLogArg(value) {
  if (typeof value === 'string') return truncateString(value, MAX_LOG_ARG_LENGTH)
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'symbol') return truncateString(value.toString(), MAX_LOG_ARG_LENGTH)
  if (typeof value === 'function') {
    const name = value.name || 'anonymous'
    return `[Function ${name}]`
  }
  if (value instanceof Error) {
    const detail = value.stack || `${value.name || 'Error'}: ${value.message || ''}`
    return truncateString(detail, MAX_LOG_ARG_LENGTH)
  }
  try {
    return truncateString(JSON.stringify(value), MAX_LOG_ARG_LENGTH)
  } catch {
    return truncateString(String(value), MAX_LOG_ARG_LENGTH)
  }
}

function normalizeLimit(limit) {
  if (!Number.isFinite(limit)) return MAX_APP_LOG_ENTRIES
  return Math.max(0, Math.min(MAX_APP_LOG_ENTRIES, Math.floor(limit)))
}

export class ClientAppLogs extends System {
  constructor(world) {
    super(world)
    this.logsByAppId = new Map()
  }

  capture(appId, level, args = []) {
    const normalizedAppId = normalizeAppId(appId)
    if (!normalizedAppId) return null
    const normalizedLevel = allowedLevels.has(level) ? level : 'log'
    const normalizedArgs = Array.isArray(args) ? args.slice(0, MAX_LOG_ARGS).map(serializeLogArg) : []
    const entry = {
      timestamp: new Date().toISOString(),
      level: normalizedLevel,
      args: normalizedArgs,
      message: truncateString(normalizedArgs.join(' '), MAX_LOG_MESSAGE_LENGTH),
    }
    let buffer = this.logsByAppId.get(normalizedAppId)
    if (!buffer) {
      buffer = []
      this.logsByAppId.set(normalizedAppId, buffer)
    }
    buffer.push(entry)
    if (buffer.length > MAX_APP_LOG_ENTRIES) {
      buffer.splice(0, buffer.length - MAX_APP_LOG_ENTRIES)
    }
    return entry
  }

  getEntries(appId, limit = MAX_APP_LOG_ENTRIES) {
    const normalizedAppId = normalizeAppId(appId)
    if (!normalizedAppId) return []
    const buffer = this.logsByAppId.get(normalizedAppId)
    if (!buffer?.length) return []
    const count = normalizeLimit(limit)
    if (count <= 0) return []
    const snapshot = count >= buffer.length ? buffer : buffer.slice(buffer.length - count)
    return snapshot.map(entry => ({
      ...entry,
      args: [...entry.args],
    }))
  }

  clearEntries(appId) {
    const normalizedAppId = normalizeAppId(appId)
    if (!normalizedAppId) return
    this.logsByAppId.delete(normalizedAppId)
  }

  destroy() {
    this.logsByAppId.clear()
  }
}
