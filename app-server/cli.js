#!/usr/bin/env node

import { runAppCommand } from './commands.js'
import { parseTargetArgs } from './targets.js'

async function main() {
  let command
  let args = []
  try {
    const parsed = parseTargetArgs(process.argv.slice(2))
    command = parsed.args[0]
    args = parsed.args.slice(1)
    if (parsed.target) {
      args.push('--target', parsed.target)
    }
  } catch (err) {
    console.error(`❌ ${err?.message || err}`)
    process.exit(1)
  }
  const exitCode = await runAppCommand({ command, args, helpPrefix: 'gamedev apps' })
  process.exit(exitCode)
}

main().catch(error => {
  console.error('❌ CLI Error:', error?.message || error)
  process.exit(1)
})
