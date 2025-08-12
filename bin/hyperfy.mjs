#!/usr/bin/env node
import 'dotenv-flow/config'

// Start the Hyperfy server with current process.env
import { server } from '../index.node.js'

await server()


