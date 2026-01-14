#!/usr/bin/env node

import { main as directMain, DirectAppServer } from './direct.js'
import { applyTargetEnv, parseTargetArgs, resolveTarget } from './targets.js'

export { DirectAppServer }

export async function main() {
  try {
    const parsed = parseTargetArgs(process.argv.slice(2))
    if (parsed.target) {
      const target = resolveTarget(process.cwd(), parsed.target)
      applyTargetEnv(target)
    }
  } catch (err) {
    console.error(`❌ ${err?.message || err}`)
    process.exit(1)
  }
  await directMain()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
