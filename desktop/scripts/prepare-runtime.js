// Prepares desktop/runtime: a self-contained closure of the dsh server runtime
// (@deepseek-ai/dsh and its full dependency tree, including the web frontend
// dist). The Electron shell spawns `dsh web` from this closure.
//
// Strategy: if a working closure already exists on this machine (a prior
// desktop build, or the npx cache the CLI runs from), it is copied verbatim —
// that is the exact runtime the Web GUI is already served from. Otherwise npm
// installs the published package with --ignore-scripts (the sandbox blocks npm
// from spawning install scripts such as @google/genai's preinstall; the closure
// needs no lifecycle scripts, only the packages themselves).
//
// Idempotent: an existing closure is kept unless --force is passed.

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const RUNTIME = path.join(ROOT, 'runtime')
const DSH_VERSION = process.env.DSH_DESKTOP_VERSION || '0.1.0-rc.6'

// Candidate source closures, in preference order. Each must contain
// node_modules/@deepseek-ai/dsh/lib/bin.js.
function candidateSources() {
  const env = process.env.DSH_DESKTOP_RUNTIME_SOURCE
  const candidates = []
  if (env) candidates.push(env)
  candidates.push(
    // The npm npx cache the `dsh` CLI currently runs from, if present.
    path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx'),
  )
  return candidates
}

function findExistingClosure() {
  for (const source of candidateSources()) {
    if (!fs.existsSync(source)) continue
    if (source.endsWith('_npx') || fs.statSync(source).isDirectory() && !source.endsWith('node_modules')) {
      // npx cache: probe each hash-named entry for a dsh closure.
      const entries = fs.existsSync(source)
        ? fs.readdirSync(source).map(name => path.join(source, name)).filter(entry => fs.statSync(entry).isDirectory())
        : []
      for (const entry of entries) {
        const bin = path.join(entry, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
        if (fs.existsSync(bin)) return path.join(entry, 'node_modules')
      }
      continue
    }
    const bin = path.join(source, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (fs.existsSync(bin)) return path.join(source, 'node_modules')
  }
  return undefined
}

function main() {
  const target = path.join(RUNTIME, 'node_modules')
  const bin = path.join(target, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (fs.existsSync(bin) && !process.argv.includes('--force')) {
    console.log(`Runtime already prepared at ${RUNTIME} (${DSH_VERSION}). Pass --force to refresh.`)
    return
  }

  fs.rmSync(RUNTIME, { recursive: true, force: true })
  fs.mkdirSync(RUNTIME, { recursive: true })
  fs.writeFileSync(
    path.join(RUNTIME, 'package.json'),
    JSON.stringify({ name: 'dsh-desktop-runtime', private: true, version: '0.0.0' }, null, 2) + '\n',
  )

  const existing = findExistingClosure()
  if (existing !== undefined) {
    console.log(`Copying runtime closure from ${existing} ...`)
    fs.cpSync(existing, target, { recursive: true })
  } else {
    console.log(`No existing closure found; npm-installing @deepseek-ai/dsh@${DSH_VERSION} ...`)
    const npmCache = process.env.DSH_DESKTOP_NPM_CACHE || path.join(ROOT, '..', '.npm-cache')
    execFileSync('npm', [
      'install',
      '--prefix', RUNTIME,
      `@deepseek-ai/dsh@${DSH_VERSION}`,
      '--cache', npmCache,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ], { stdio: 'inherit' })
  }

  if (!fs.existsSync(bin)) {
    throw new Error(`Runtime closure incomplete: ${bin} is missing`)
  }
  console.log('Runtime ready.')
}

main()
