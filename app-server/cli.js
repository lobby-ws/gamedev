#!/usr/bin/env node

import { runAppCommand } from './commands.js'

async function main() {
  const [command, ...args] = process.argv.slice(2)
  const exitCode = await runAppCommand({ command, args, helpPrefix: 'hyperfy' })
  process.exit(exitCode)
}

main().catch(error => {
  console.error('❌ CLI Error:', error?.message || error)
  process.exit(1)
})
