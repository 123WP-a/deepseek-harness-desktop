// dsh runtime auto-update for the desktop shell.
//
// The desktop shell ships a bundled dsh server runtime. This module checks the
// npm registry for a newer @deepseek-ai/dsh on the configured dist-tag,
// installs the new closure into a per-user staging directory, and marks it
// ready so the next launch can activate it before spawning the server.
//
// The staged update is applied at startup (never while the server is running):
// a running server may have files open inside the active runtime directory, and
// renaming that directory out from under it is unsafe on Windows.

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const https = require('node:https')
const path = require('node:path')

const PACKAGE_NAME = '@deepseek-ai/dsh'
const DEFAULT_CHANNEL = 'next'
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const COMPLETE_MARKER = '.dsh-update-complete.json'

/**
 * Read the dsh version installed inside a runtime closure.
 * @param {string} runtimeRoot - directory containing node_modules/@deepseek-ai/dsh.
 * @returns {string} the installed version.
 */
function readInstalledVersion(runtimeRoot) {
  const manifestPath = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const raw = fs.readFileSync(manifestPath, 'utf8')
  const manifest = JSON.parse(raw)
  if (typeof manifest.version !== 'string') {
    throw new Error(`dsh manifest at ${manifestPath} has no version`)
  }
  return manifest.version
}

/** Split a semver string into comparable fields, or null when malformed. */
function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version)
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** Compare two semver prerelease field lists. */
function comparePrerelease(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftField = left[index]
    const rightField = right[index]
    if (leftField === undefined) return -1
    if (rightField === undefined) return 1
    if (leftField === rightField) continue
    const leftNumeric = /^\d+$/.test(leftField)
    const rightNumeric = /^\d+$/.test(rightField)
    if (leftNumeric && rightNumeric) return Number(leftField) - Number(rightField)
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftField < rightField ? -1 : 1
  }
  return 0
}

/** Compare two semver strings by semver precedence. */
function compareVersions(left, right) {
  const leftParsed = parseVersion(left)
  const rightParsed = parseVersion(right)
  if (leftParsed === null || rightParsed === null) return left.localeCompare(right)
  if (leftParsed.major !== rightParsed.major) return leftParsed.major - rightParsed.major
  if (leftParsed.minor !== rightParsed.minor) return leftParsed.minor - rightParsed.minor
  if (leftParsed.patch !== rightParsed.patch) return leftParsed.patch - rightParsed.patch
  if (leftParsed.prerelease.length === 0 && rightParsed.prerelease.length === 0) return 0
  if (leftParsed.prerelease.length === 0) return 1
  if (rightParsed.prerelease.length === 0) return -1
  return comparePrerelease(leftParsed.prerelease, rightParsed.prerelease)
}

/** Fetch a JSON document over HTTPS with a timeout. */
function fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { accept: 'application/json' },
      timeout: timeoutMs,
    }, (response) => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`registry request failed: HTTP ${String(response.statusCode)}`))
          return
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) {
          reject(error)
        }
      })
    })
    request.on('timeout', () => request.destroy(new Error('registry request timed out')))
    request.on('error', reject)
  })
}

/**
 * Fetch the version a dist-tag currently points at for @deepseek-ai/dsh.
 * @returns {Promise<string>} the version.
 */
async function fetchDistTagVersion({ channel = DEFAULT_CHANNEL, registry = DEFAULT_REGISTRY, timeoutMs = 10_000 } = {}) {
  const base = registry.replace(/\/+$/, '')
  const url = `${base}/${encodeURIComponent(PACKAGE_NAME)}`
  const packument = await fetchJson(url, timeoutMs)
  const version = packument && packument['dist-tags'] && packument['dist-tags'][channel]
  if (typeof version !== 'string') {
    throw new Error(`npm dist-tag ${channel} not found for ${PACKAGE_NAME}`)
  }
  return version
}

/**
 * Check whether a newer dsh version is available for the active runtime.
 * @returns {Promise<{currentVersion: string, latestVersion: string, updateAvailable: boolean}>}
 */
async function checkForUpdate({ runtimeRoot, channel = DEFAULT_CHANNEL, registry = DEFAULT_REGISTRY, timeoutMs } = {}) {
  const currentVersion = readInstalledVersion(runtimeRoot)
  const latestVersion = await fetchDistTagVersion({ channel, registry, timeoutMs })
  return {
    currentVersion,
    latestVersion,
    updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
  }
}

/** Resolve the npm invocation for this platform. */
function npmInvocation() {
  const configured = process.env.DSH_DESKTOP_NPM || 'npm'
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', configured],
    }
  }
  return { command: configured, args: [] }
}

/** Run npm, capturing stdout/stderr, and resolve on exit code 0. */
function runNpm(args, env) {
  return new Promise((resolve, reject) => {
    const invocation = npmInvocation()
    const child = spawn(invocation.command, [...invocation.args, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(new Error(`npm exited with code ${String(code)}: ${stderr || stdout}`))
    })
  })
}

/**
 * Install a specific dsh version into a fresh staging directory.
 * @returns {Promise<string>} the installed version.
 */
async function installDshUpdate({ version, targetDir, cacheDir, registry = DEFAULT_REGISTRY }) {
  fs.rmSync(targetDir, { recursive: true, force: true })
  fs.mkdirSync(targetDir, { recursive: true })
  fs.writeFileSync(
    path.join(targetDir, 'package.json'),
    JSON.stringify({ name: 'dsh-desktop-runtime-next', private: true, version: '0.0.0' }, null, 2) + '\n',
  )
  await runNpm([
    'install',
    '--prefix', targetDir,
    '--no-save',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--cache', cacheDir,
    `${PACKAGE_NAME}@${version}`,
  ], {
    npm_config_registry: registry,
    npm_config_cache: cacheDir,
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  })
  const bin = path.join(targetDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!fs.existsSync(bin)) {
    throw new Error(`installed runtime missing ${bin}`)
  }
  const installedVersion = readInstalledVersion(targetDir)
  if (installedVersion !== version) {
    throw new Error(`expected dsh ${version}, installed ${installedVersion}`)
  }
  fs.writeFileSync(
    path.join(targetDir, COMPLETE_MARKER),
    JSON.stringify({ version, installedAt: new Date().toISOString() }, null, 2) + '\n',
  )
  return installedVersion
}

/**
 * Read the version of a completed staged update, or undefined when the staging
 * directory has no valid completed install.
 * @param {string} pendingDir - staging directory.
 * @returns {string|undefined}
 */
function pendingUpdateVersion(pendingDir) {
  const markerPath = path.join(pendingDir, COMPLETE_MARKER)
  if (!fs.existsSync(markerPath)) return undefined
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
    if (typeof marker.version !== 'string') return undefined
    const bin = path.join(pendingDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (!fs.existsSync(bin)) return undefined
    return marker.version
  } catch {
    return undefined
  }
}

/** Delete an incomplete or stale staging directory. */
function clearPendingUpdate(pendingDir) {
  fs.rmSync(pendingDir, { recursive: true, force: true })
}

/**
 * Activate a completed staged update before the server starts.
 * @param {string} pendingDir - completed staging directory.
 * @param {string} activeDir - per-user active runtime directory.
 * @returns {string|undefined} the activated version, or undefined when no valid pending update exists.
 */
function activatePendingUpdate(pendingDir, activeDir) {
  const version = pendingUpdateVersion(pendingDir)
  if (version === undefined) return undefined
  const oldDir = `${activeDir}-old`
  fs.rmSync(oldDir, { recursive: true, force: true })
  if (fs.existsSync(activeDir)) fs.renameSync(activeDir, oldDir)
  fs.renameSync(pendingDir, activeDir)
  fs.rmSync(oldDir, { recursive: true, force: true })
  return version
}

module.exports = {
  readInstalledVersion,
  compareVersions,
  fetchDistTagVersion,
  checkForUpdate,
  installDshUpdate,
  pendingUpdateVersion,
  clearPendingUpdate,
  activatePendingUpdate,
}
