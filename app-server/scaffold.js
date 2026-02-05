import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import { BUILTIN_APP_TEMPLATES, SCENE_TEMPLATE } from './templates/builtins.js'
import { WorldManifest } from './WorldManifest.js'
import { uuid } from './utils.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATES_DIR = path.join(__dirname, 'templates')
const DOCS_TEMPLATE_DIR = path.join(__dirname, '..', 'docs')
const SCRIPTS_TEMPLATE_DIR = path.join(TEMPLATES_DIR, 'scripts')
const README_TEMPLATE = path.join(TEMPLATES_DIR, 'README.md')
const CLAUDE_MD_TEMPLATE = path.join(TEMPLATES_DIR, 'claude', 'CLAUDE.md')
const CLAUDE_SKILL_TEMPLATE = path.join(TEMPLATES_DIR, 'claude', 'skills', 'hyperfy-app-scripting', 'SKILL.md')
const AGENTS_MD_TEMPLATE = path.join(TEMPLATES_DIR, 'openai', 'AGENTS.md')
const CURSOR_RULES_TEMPLATE = path.join(TEMPLATES_DIR, 'cursor', 'rules.md')

const DEFAULT_GITIGNORE = `# Dependencies
node_modules/

# Build output
dist/

# Local env files
.env*
!.env.example

# Local world state
.lobby/*
!.lobby/
!.lobby/targets.example.json

# Claude local settings
.claude/settings.local.json

# OS junk
.DS_Store
`

const DEFAULT_NVMRC = '22.11.0\n'

const DEFAULT_TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    lib: ['ES2022', 'DOM'],
    strict: false,
    noEmit: true,
    skipLibCheck: true,
    types: ['gamedev'],
  },
  include: ['apps/**/*', 'shared/**/*'],
}

function normalizePackageName(name, fallback) {
  const raw = (name || '').trim() || (fallback || '').trim()
  const base = raw || 'lobby-world'
  const scopeMatch = base.startsWith('@') ? base.split('/') : null
  if (scopeMatch && scopeMatch.length === 2) {
    const scope = scopeMatch[0].toLowerCase().replace(/[^a-z0-9._-]+/g, '')
    const pkg = scopeMatch[1]
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
    if (scope && pkg) return `${scope}/${pkg}`
  }
  const normalized = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || 'lobby-world'
}

function buildPackageJson({ packageName, sdkName, sdkVersion }) {
  const resolvedVersion = sdkVersion || resolveSdkVersion()
  const devDependencies = {
    [sdkName]: resolvedVersion ? `^${resolvedVersion}` : 'latest',
    typescript: '^5.6.3',
  }
  const pkg = {
    name: packageName,
    version: '0.0.0',
    private: true,
    type: 'module',
    scripts: {
      init: 'gamedev init',
      help: 'gamedev help',
      dev: 'gamedev dev',
      'apps:new': 'gamedev apps new',
      build: 'gamedev apps build --all',
      'deploy:fly': 'bash scripts/fly-deploy.sh',
      'deploy:app': 'gamedev apps deploy',
      update: 'npm i gamedev@latest && gamedev update',
      'update:engine': 'bash scripts/update-engine.sh',
      typecheck: 'tsc --noEmit',
      'hyp:extract': 'node scripts/extract-hyp.mjs',
    },
    devDependencies,
  }
  return JSON.stringify(pkg, null, 2) + '\n'
}

function resolveSdkVersion() {
  const pkgPath = path.join(__dirname, '..', 'package.json')
  try {
    const raw = fs.readFileSync(pkgPath, 'utf8')
    const parsed = JSON.parse(raw)
    return typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : null
  } catch {
    return null
  }
}

function buildEnvExample() {
  return `# Hyperfy project environment (example)
# Run "gamedev dev" to generate a local .env automatically.
WORLD_URL=http://localhost:3000
WORLD_ID=local-your-world-id
ADMIN_CODE=your-admin-code

# World server
PORT=3000
JWT_SECRET=your-jwt-secret
SAVE_INTERVAL=60
PUBLIC_PLAYER_COLLISION=false
PUBLIC_MAX_UPLOAD_SIZE=12
PUBLIC_WS_URL=ws://localhost:3000/ws
PUBLIC_API_URL=http://localhost:3000/api

# Assets
ASSETS=local
ASSETS_BASE_URL=http://localhost:3000/assets
ASSETS_S3_URI=

# Database
DB_URI=local
DB_SCHEMA=

# Cleanup
CLEAN=true

# LiveKit (voice chat)
LIVEKIT_WS_URL=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=

# Hooks to connect to a local app dev server
PUBLIC_DEV_SERVER=false
`
}

function buildTargetsExample() {
  return (
    JSON.stringify(
      {
        dev: {
          worldUrl: 'http://localhost:3000',
          worldId: 'local-your-world-id',
          adminCode: 'your-admin-code',
        },
        prod: {
          worldUrl: 'https://world.example.com',
          worldId: 'prod-world-id',
          adminCode: 'your-admin-code',
          confirm: true,
        },
      },
      null,
      2
    ) + '\n'
  )
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

function writeFileWithPolicy(filePath, content, { force, writeFile, report }) {
  const exists = fs.existsSync(filePath)
  if (exists && !force) {
    report?.skipped.push(filePath)
    return 'skipped'
  }
  if (exists) {
    const current = readText(filePath)
    const next = Buffer.isBuffer(content) ? content.toString('utf8') : content
    if (current === next) {
      report?.skipped.push(filePath)
      return 'skipped'
    }
  }
  ensureDir(path.dirname(filePath))
  const writer = writeFile || ((target, data) => fs.writeFileSync(target, data, 'utf8'))
  writer(filePath, content)
  const list = exists ? report?.updated : report?.created
  list?.push(filePath)
  return exists ? 'updated' : 'created'
}

function copyDirWithPolicy(srcDir, destDir, { force, writeFile, report }) {
  if (!fs.existsSync(srcDir)) return
  const entries = fs.readdirSync(srcDir, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name)
    const destPath = path.join(destDir, entry.name)
    if (entry.isDirectory()) {
      copyDirWithPolicy(srcPath, destPath, { force, writeFile, report })
      continue
    }
    if (!entry.isFile()) continue
    const buffer = fs.readFileSync(srcPath)
    writeFileWithPolicy(destPath, buffer, { force, writeFile, report })
  }
}

function resolveBuiltinScriptPath(filename) {
  const buildPath = path.join(__dirname, '..', 'build', 'world', 'assets', filename)
  if (fs.existsSync(buildPath)) return buildPath
  const srcPath = path.join(__dirname, '..', 'src', 'world', 'assets', filename)
  if (fs.existsSync(srcPath)) return srcPath
  return null
}

function resolveBuiltinAssetPath(filename) {
  const buildPath = path.join(__dirname, '..', 'build', 'world', 'assets', filename)
  if (fs.existsSync(buildPath)) return buildPath
  const srcPath = path.join(__dirname, '..', 'src', 'world', 'assets', filename)
  if (fs.existsSync(srcPath)) return srcPath
  return null
}

function collectAssetFilenames(value, out) {
  if (!out) out = new Set()
  if (typeof value === 'string') {
    if (value.startsWith('asset://')) {
      out.add(value.slice('asset://'.length))
    } else if (value.startsWith('assets/')) {
      out.add(value.slice('assets/'.length))
    }
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectAssetFilenames(item, out)
    }
    return out
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      collectAssetFilenames(item, out)
    }
  }
  return out
}

function toLocalAssetUrls(value) {
  if (typeof value === 'string') {
    if (value.startsWith('asset://')) {
      return `assets/${value.slice('asset://'.length)}`
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map(item => toLocalAssetUrls(item))
  }
  if (value && typeof value === 'object') {
    const next = {}
    for (const [key, item] of Object.entries(value)) {
      next[key] = toLocalAssetUrls(item)
    }
    return next
  }
  return value
}

function readBuiltinScript(template) {
  const scriptPath = resolveBuiltinScriptPath(template.scriptAsset)
  if (!scriptPath) {
    throw new Error(`missing_builtin_script:${template.scriptAsset}`)
  }
  return fs.readFileSync(scriptPath, 'utf8')
}

export function scaffoldBaseProject({
  rootDir,
  packageName,
  sdkName = 'gamedev',
  sdkVersion,
  force = false,
  writeFile,
} = {}) {
  const report = { created: [], updated: [], skipped: [] }
  const fallbackName = path.basename(rootDir || process.cwd())
  const normalizedName = normalizePackageName(packageName, fallbackName)

  writeFileWithPolicy(path.join(rootDir, '.gitignore'), DEFAULT_GITIGNORE, {
    force,
    writeFile,
    report,
  })

  writeFileWithPolicy(path.join(rootDir, '.nvmrc'), DEFAULT_NVMRC, {
    force,
    writeFile,
    report,
  })

  writeFileWithPolicy(
    path.join(rootDir, 'package.json'),
    buildPackageJson({
      packageName: normalizedName,
      sdkName,
      sdkVersion,
    }),
    {
      force,
      writeFile,
      report,
    }
  )

  writeFileWithPolicy(path.join(rootDir, 'tsconfig.json'), JSON.stringify(DEFAULT_TSCONFIG, null, 2) + '\n', {
    force,
    writeFile,
    report,
  })

  writeFileWithPolicy(path.join(rootDir, '.env.example'), buildEnvExample(), {
    force,
    writeFile,
    report,
  })

  writeFileWithPolicy(path.join(rootDir, '.lobby', 'targets.example.json'), buildTargetsExample(), {
    force,
    writeFile,
    report,
  })

  copyDirWithPolicy(DOCS_TEMPLATE_DIR, path.join(rootDir, 'docs'), {
    force,
    writeFile,
    report,
  })

  copyDirWithPolicy(SCRIPTS_TEMPLATE_DIR, path.join(rootDir, 'scripts'), {
    force,
    writeFile,
    report,
  })

  writeFileWithPolicy(path.join(rootDir, 'hyp', '.gitkeep'), '', {
    force,
    writeFile,
    report,
  })

  if (fs.existsSync(README_TEMPLATE)) {
    const readmeContent = readText(README_TEMPLATE)
    if (readmeContent != null) {
      writeFileWithPolicy(
        path.join(rootDir, 'README.md'),
        readmeContent.endsWith('\n') ? readmeContent : `${readmeContent}\n`,
        { force, writeFile, report }
      )
    }
  }

  if (fs.existsSync(CLAUDE_SKILL_TEMPLATE)) {
    const skillContent = readText(CLAUDE_SKILL_TEMPLATE)
    if (skillContent != null) {
      writeFileWithPolicy(
        path.join(rootDir, '.claude', 'skills', 'hyperfy-app-scripting', 'SKILL.md'),
        skillContent.endsWith('\n') ? skillContent : `${skillContent}\n`,
        { force, writeFile, report }
      )
    }
  }

  if (fs.existsSync(CLAUDE_MD_TEMPLATE)) {
    const docContent = readText(CLAUDE_MD_TEMPLATE)
    if (docContent != null) {
      writeFileWithPolicy(path.join(rootDir, 'CLAUDE.md'), docContent.endsWith('\n') ? docContent : `${docContent}\n`, {
        force,
        writeFile,
        report,
      })
    }
  }

  if (fs.existsSync(AGENTS_MD_TEMPLATE)) {
    const agentsContent = readText(AGENTS_MD_TEMPLATE)
    if (agentsContent != null) {
      writeFileWithPolicy(
        path.join(rootDir, 'AGENTS.md'),
        agentsContent.endsWith('\n') ? agentsContent : `${agentsContent}\n`,
        { force, writeFile, report }
      )
    }
  }

  if (fs.existsSync(CURSOR_RULES_TEMPLATE)) {
    const cursorContent = readText(CURSOR_RULES_TEMPLATE)
    if (cursorContent != null) {
      writeFileWithPolicy(
        path.join(rootDir, '.cursor', 'rules.md'),
        cursorContent.endsWith('\n') ? cursorContent : `${cursorContent}\n`,
        { force, writeFile, report }
      )
    }
  }

  return report
}

export function createDefaultManifest() {
  const manifest = new WorldManifest('world.json').createEmpty()
  manifest.entities = [
    {
      id: uuid(),
      blueprint: SCENE_TEMPLATE.fileBase,
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      pinned: false,
      props: {},
      state: {},
    },
  ]
  return manifest
}

export function scaffoldBuiltins({ rootDir, force = false, writeFile } = {}) {
  const report = { created: [], updated: [], skipped: [] }
  const appsDir = path.join(rootDir, 'apps')
  const assetsDir = path.join(rootDir, 'assets')
  ensureDir(appsDir)

  const templates = [...BUILTIN_APP_TEMPLATES, SCENE_TEMPLATE]
  const assetFiles = new Set()

  for (const template of templates) {
    collectAssetFilenames(template.config, assetFiles)
    const appDir = path.join(appsDir, template.appName)
    ensureDir(appDir)

    const blueprintPath = path.join(appDir, `${template.fileBase}.json`)
    if (!fs.existsSync(blueprintPath) || force) {
      const localConfig = toLocalAssetUrls(template.config)
      writeFileWithPolicy(blueprintPath, JSON.stringify(localConfig, null, 2) + '\n', {
        force,
        writeFile,
        report,
      })
    }

    const scriptPath = path.join(appDir, 'index.js')
    if (!fs.existsSync(scriptPath) || force) {
      const script = readBuiltinScript(template)
      writeFileWithPolicy(scriptPath, script, { force, writeFile, report })
    }
  }

  if (assetFiles.size) {
    ensureDir(assetsDir)
    for (const filename of assetFiles) {
      const srcPath = resolveBuiltinAssetPath(filename)
      if (!srcPath) {
        throw new Error(`missing_builtin_asset:${filename}`)
      }
      const destPath = path.join(assetsDir, filename)
      const exists = fs.existsSync(destPath)
      if (exists && !force) {
        report.skipped.push(destPath)
        continue
      }
      const buffer = fs.readFileSync(srcPath)
      if (writeFile) {
        writeFile(destPath, buffer)
      } else {
        ensureDir(path.dirname(destPath))
        fs.writeFileSync(destPath, buffer)
      }
      if (exists) {
        report.updated.push(destPath)
      } else {
        report.created.push(destPath)
      }
    }
  }

  return { report, manifest: createDefaultManifest() }
}

export function writeManifest({ rootDir, manifest, force = false, writeFile } = {}) {
  const report = { created: [], updated: [], skipped: [] }
  writeFileWithPolicy(path.join(rootDir, 'world.json'), JSON.stringify(manifest, null, 2) + '\n', {
    force,
    writeFile,
    report,
  })
  return report
}

export function updateBuiltins({ rootDir, writeFile } = {}) {
  const report = { created: [], updated: [], skipped: [], userModified: [] }
  const appsDir = path.join(rootDir, 'apps')
  const assetsDir = path.join(rootDir, 'assets')
  ensureDir(appsDir)

  const templates = [...BUILTIN_APP_TEMPLATES, SCENE_TEMPLATE]
  const assetFiles = new Set()

  for (const template of templates) {
    collectAssetFilenames(template.config, assetFiles)
    const appDir = path.join(appsDir, template.appName)
    ensureDir(appDir)

    const blueprintPath = path.join(appDir, `${template.fileBase}.json`)
    const sdkBlueprint = JSON.stringify(toLocalAssetUrls(template.config), null, 2) + '\n'
    const userBlueprint = readText(blueprintPath)
    if (userBlueprint === null) {
      writeFileWithPolicy(blueprintPath, sdkBlueprint, { force: true, writeFile, report })
    } else if (userBlueprint === sdkBlueprint) {
      report.skipped.push(blueprintPath)
    } else {
      report.userModified.push(blueprintPath)
    }

    const scriptPath = path.join(appDir, 'index.js')
    const sdkScript = readBuiltinScript(template)
    const userScript = readText(scriptPath)
    if (userScript === null) {
      writeFileWithPolicy(scriptPath, sdkScript, { force: true, writeFile, report })
    } else if (userScript === sdkScript) {
      report.skipped.push(scriptPath)
    } else {
      report.userModified.push(scriptPath)
    }
  }

  if (assetFiles.size) {
    ensureDir(assetsDir)
    for (const filename of assetFiles) {
      const srcPath = resolveBuiltinAssetPath(filename)
      if (!srcPath) {
        throw new Error(`missing_builtin_asset:${filename}`)
      }
      const destPath = path.join(assetsDir, filename)
      const sdkBuffer = fs.readFileSync(srcPath)
      if (!fs.existsSync(destPath)) {
        if (writeFile) {
          writeFile(destPath, sdkBuffer)
        } else {
          ensureDir(path.dirname(destPath))
          fs.writeFileSync(destPath, sdkBuffer)
        }
        report.created.push(destPath)
      } else {
        const userBuffer = fs.readFileSync(destPath)
        if (sdkBuffer.equals(userBuffer)) {
          report.skipped.push(destPath)
        } else {
          report.userModified.push(destPath)
        }
      }
    }
  }

  return report
}
