#!/usr/bin/env node

import readline from 'readline'
import { main as directMain, DirectAppServer } from './direct.js'
import { applyTargetEnv, parseTargetArgs, resolveTarget } from './targets.js'

export { DirectAppServer }

async function confirmAction(prompt) {
  if (!process.stdin.isTTY) return false
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise(resolve => rl.question(prompt, resolve))
  rl.close()
  const normalized = (answer || '').trim().toLowerCase()
  return normalized === 'y' || normalized === 'yes'
}

function shouldConfirmContinuousSync(target) {
  if (target?.confirm === true || target?.requireConfirm === true || target?.requiresConfirm === true) {
    return true
  }
  const targetName = (target?.name || process.env.HYPERFY_TARGET || '').toLowerCase()
  if (targetName === 'prod' || targetName === 'production') return true
  return process.env.HYPERFY_TARGET_CONFIRM === 'true'
}

export async function main() {
  let target = null
  try {
    const parsed = parseTargetArgs(process.argv.slice(2))
    if (parsed.target) {
      target = resolveTarget(process.cwd(), parsed.target)
      applyTargetEnv(target)
    }
  } catch (err) {
    console.error(`❌ ${err?.message || err}`)
    process.exit(1)
  }
  if (shouldConfirmContinuousSync(target)) {
    const label = target?.name || process.env.HYPERFY_TARGET || 'prod'
    const ok = await confirmAction(
      `Start continuous sync for "${label}"? This can overwrite world state. (y/N): `
    )
    if (!ok) {
      console.log('Sync cancelled')
      process.exit(1)
    }
  }
  await directMain()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
