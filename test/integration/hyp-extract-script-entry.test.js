import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { exportApp } from '../../src/core/extras/appTools.js'
import { createTempDir, getRepoRoot } from './helpers.js'

if (!globalThis.File) {
  globalThis.File = File
}

async function runNodeScript(scriptPath, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })

    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(new Error(`script failed (exit ${code})\n${stdout}\n${stderr}`.trim()))
    })
  })
}

test('extract-hyp rewrites single hashed script entry to index.js', async () => {
  const repoRoot = getRepoRoot()
  const projectDir = await createTempDir('hyperfy-extract-hyp-')
  const files = new Map()
  const addFile = (url, contents, name, type) => {
    const file = new File([contents], name, { type })
    files.set(url, file)
    return file
  }

  const hashedEntry = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.js'
  const scriptUrl = 'asset://entry.js'
  addFile(scriptUrl, 'app.on("update", () => {})\n', 'entry.js', 'text/javascript')

  const blueprint = {
    id: 'bp-extract-hashed',
    name: 'ExtractHashedEntry',
    script: scriptUrl,
    scriptEntry: hashedEntry,
    scriptFormat: 'module',
    scriptFiles: {
      [hashedEntry]: scriptUrl,
    },
    props: {},
    preload: false,
    public: false,
    locked: false,
    frozen: false,
    unique: false,
    scene: false,
    disabled: false,
  }

  const resolveFile = url => {
    const file = files.get(url)
    if (!file) throw new Error(`missing file: ${url}`)
    return file
  }

  const hypFile = await exportApp(blueprint, resolveFile)
  const hypPath = path.join(projectDir, 'source.hyp')
  await fs.writeFile(hypPath, Buffer.from(await hypFile.arrayBuffer()))

  const extractScript = path.join(repoRoot, 'app-server', 'templates', 'scripts', 'extract-hyp.mjs')
  await runNodeScript(extractScript, [hypPath, '--project', projectDir], repoRoot)

  const appDir = path.join(projectDir, 'apps', 'ExtractHashedEntry')
  const indexPath = path.join(appDir, 'index.js')
  await fs.access(indexPath)
  await assert.rejects(fs.access(path.join(appDir, hashedEntry)))

  const configPath = path.join(appDir, 'ExtractHashedEntry.json')
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'))
  assert.ok(!Object.prototype.hasOwnProperty.call(config, 'scriptEntry'))
})
