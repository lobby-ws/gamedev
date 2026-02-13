import { System } from './System'

const MAX_ENTRIES = 500

export class Logs extends System {
  constructor(world) {
    super(world)
    this.entries = []
  }

  add(source, level, args) {
    const entry = {
      id: this.entries.length,
      source,
      level,
      args: args.map(serializeArg),
      timestamp: Date.now(),
    }
    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES)
    }
    this.emit('entry', entry)
  }

  clear() {
    this.entries = []
    this.emit('clear')
  }
}

function serializeArg(arg) {
  if (arg === null) return 'null'
  if (arg === undefined) return 'undefined'
  if (typeof arg === 'string') return arg
  if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg)
  if (arg instanceof Error) {
    return arg.stack || arg.message || String(arg)
  }
  try {
    return JSON.stringify(arg, null, 2)
  } catch {
    return String(arg)
  }
}
