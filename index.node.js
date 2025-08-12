// Node entrypoint for library consumers
// - Exposes `server` to start the Hyperfy world server in-process
// - Re-exports `createNodeClientWorld` for headless/node clients

export async function server(env = {}) {
  if (env && typeof env === 'object') {
    Object.assign(process.env, env)
  }
  // Dynamically import the built server entry which boots the server via TLA
  await import('./build/index.js')
}

export { createNodeClientWorld } from './src/core/createNodeClientWorld.js'
export { System } from './src/core/systems/System.js'
export { storage } from './src/core/storage.js'


