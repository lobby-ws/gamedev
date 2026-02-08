import { System } from './System'

const DEFAULT_LOG_LIMIT = 20
const MAX_LOG_ARGS = 12
const MAX_ARG_LENGTH = 300
const MAX_MESSAGE_LENGTH = 1200

function truncate(value, maxLength) {
  if (typeof value !== 'string') return ''
  if (value.length <= maxLength) return value
  if (maxLength <= 3) return value.slice(0, maxLength)
  return `${value.slice(0, maxLength - 3)}...`
}

function safeStringify(value) {
  const seen = new WeakSet()
  try {
    return JSON.stringify(value, (key, item) => {
      if (typeof item === 'bigint') return `${item}n`
      if (typeof item === 'symbol') return item.toString()
      if (typeof item === 'function') return `[Function${item.name ? ` ${item.name}` : ''}]`
      if (item instanceof Error) {
        return {
          name: item.name,
          message: item.message,
          stack: item.stack,
        }
      }
      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[Circular]'
        seen.add(item)
      }
      return item
    })
  } catch (err) {
    return ''
  }
}

function formatArg(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'undefined') return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'symbol') return value.toString()
  if (value instanceof Error) {
    const name = value.name || 'Error'
    return value.message ? `${name}: ${value.message}` : name
  }
  if (typeof value === 'function') {
    return `[Function${value.name ? ` ${value.name}` : ''}]`
  }
  if (typeof value === 'object') {
    const json = safeStringify(value)
    if (json) return json
  }
  try {
    return String(value)
  } catch (err) {
    return '[unserializable]'
  }
}

function normalizeArgs(args) {
  const list = Array.isArray(args) ? args.slice(0, MAX_LOG_ARGS) : []
  return list.map(value => truncate(formatArg(value), MAX_ARG_LENGTH))
}

function normalizeLevel(level) {
  if (level === 'warn' || level === 'error' || level === 'time' || level === 'timeEnd') return level
  return 'log'
}

function normalizeTimerLabel(label) {
  if (typeof label !== 'string') return 'default'
  const trimmed = label.trim()
  if (!trimmed) return 'default'
  return truncate(trimmed, MAX_ARG_LENGTH)
}

function normalizeTimestamp(timestamp) {
  if (typeof timestamp === 'string' && timestamp) return timestamp
  return new Date().toISOString()
}

export class ServerAppLogs extends System {
  constructor(world) {
    super(world)
    this.limit = DEFAULT_LOG_LIMIT
    this.buffers = new Map()
    this.timersByApp = new Map()
  }

  record(appId, entry = {}) {
    if (typeof appId !== 'string' || !appId) return
    const args = normalizeArgs(entry.args)
    const message =
      typeof entry.message === 'string'
        ? truncate(entry.message, MAX_MESSAGE_LENGTH)
        : truncate(args.join(' '), MAX_MESSAGE_LENGTH)
    const item = {
      timestamp: normalizeTimestamp(entry.timestamp),
      level: normalizeLevel(entry.level),
      args,
      message,
    }
    if (typeof entry.label === 'string' && entry.label) {
      item.label = normalizeTimerLabel(entry.label)
    }
    if (Number.isFinite(entry.durationMs)) {
      item.durationMs = Math.max(0, Math.round(entry.durationMs))
    }
    let buffer = this.buffers.get(appId)
    if (!buffer) {
      buffer = []
      this.buffers.set(appId, buffer)
    }
    buffer.push(item)
    if (buffer.length > this.limit) {
      buffer.splice(0, buffer.length - this.limit)
    }
  }

  getRecent(appId, limit = this.limit) {
    if (typeof appId !== 'string' || !appId) return []
    const buffer = this.buffers.get(appId)
    if (!buffer || !buffer.length) return []
    let max = Number.isFinite(limit) ? Math.floor(limit) : this.limit
    if (max < 0) max = 0
    if (max > this.limit) max = this.limit
    if (!max) return []
    const start = Math.max(buffer.length - max, 0)
    return buffer.slice(start).map(entry => ({
      ...entry,
      args: Array.isArray(entry.args) ? [...entry.args] : [],
    }))
  }

  startTimer(appId, label) {
    if (typeof appId !== 'string' || !appId) return
    const timerLabel = normalizeTimerLabel(label)
    let timers = this.timersByApp.get(appId)
    if (!timers) {
      timers = new Map()
      this.timersByApp.set(appId, timers)
    }
    timers.set(timerLabel, Date.now())
  }

  endTimer(appId, label) {
    if (typeof appId !== 'string' || !appId) return null
    const timerLabel = normalizeTimerLabel(label)
    const timers = this.timersByApp.get(appId)
    if (!timers) return null
    const start = timers.get(timerLabel)
    if (!Number.isFinite(start)) return null
    timers.delete(timerLabel)
    if (!timers.size) {
      this.timersByApp.delete(appId)
    }
    const durationMs = Date.now() - start
    return Number.isFinite(durationMs) ? Math.max(0, durationMs) : null
  }

  clearApp(appId) {
    if (typeof appId !== 'string' || !appId) return
    this.buffers.delete(appId)
    this.timersByApp.delete(appId)
  }

  destroy() {
    this.buffers.clear()
    this.timersByApp.clear()
  }
}
