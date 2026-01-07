#!/usr/bin/env node

import { main as directMain, DirectAppServer } from './direct.js'

export { DirectAppServer }

export async function main() {
  await directMain()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}

