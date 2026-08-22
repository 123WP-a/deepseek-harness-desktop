// DeepSeek Harness desktop shell — main process.
//
// Design goals:
//  1. Click-to-launch: the app starts the dsh web server itself; nothing else
//     needs to be running first.
//  2. No connection-refused page: the window is created only after the server
//     has printed its readiness line AND answered an HTTP 200 on the same URL.
//     If the server fails to start, an error dialog shows the server log
//     instead of a dead/blank window.
//  3. No port conflicts: the server is spawned with --port 0 so the OS assigns
//     a free port; the readiness line reports the actual bound URL.
//  4. Clean shutdown: closing the window (or quitting the app) terminates the
//     server process tree.

const { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const http = require('node:http')
const https = require('node:https')
const crypto = require('node:crypto')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const { startAppearanceSync } = require('./appearance.js')

// Headless smoke runs may execute in a confined environment where the default
// %APPDATA% userData is unwritable; keep smoke state in a writable temp dir
// (the app dir may be read-only inside an asar when packaged).
if (process.env.DSH_DESKTOP_SMOKE === '1') {
  app.setPath('userData', path.join(os.tmpdir(), 'dsh-desktop-smoke-userdata'))
}

// ---------------------------------------------------------------------------
// Runtime resolution
// ---------------------------------------------------------------------------

// In the packaged layout the runtime closure lives at resources/runtime; in
// the dev layout it lives at desktop/runtime next to this file.
function runtimeRoot() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'runtime')
  return path.join(__dirname, 'runtime')
}

/** Read the version field of a dsh package.json; null when unreadable. */
function dshVersionOf(pkgDir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

/**
 * Candidate directories that may contain @deepseek-ai/dsh, best-first.
 * Covers any npm/pnpm/cnpm global prefix — resolved via the `dsh` PATH shim
 * and `npm root -g`, not just the three hardcoded legacy locations — so an
 * updated global install is always picked up regardless of where it lives.
 */
function dshSearchRoots() {
  const roots = []
  const push = (dir) => { if (dir && !roots.includes(dir)) roots.push(dir) }

  // 1. Explicit override for exotic setups.
  push(process.env.DSH_DESKTOP_GLOBAL_ROOT)

  // 2. Wherever the `dsh` launcher shim lives on PATH: its sibling
  //    node_modules is that package manager's global root.
  const pathEnv = process.env.PATH || ''
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : ['']
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue
    const hasShim = exts.some((ext) => fs.existsSync(path.join(dir, `dsh${ext}`)))
      || fs.existsSync(path.join(dir, 'dsh'))
    if (hasShim) push(path.join(dir, 'node_modules'))
  }

  // 3. Legacy hardcoded locations (cover standard installs without spawning).
  if (process.env.APPDATA) push(path.join(process.env.APPDATA, 'npm', 'node_modules'))
  if (process.env.ProgramFiles) push(path.join(process.env.ProgramFiles, 'nodejs', 'node_modules'))
  if (process.env.LOCALAPPDATA) push(path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node_modules'))

  // 4. Ask npm itself (authoritative for exotic prefixes; slow, so last).
  try {
    const res = spawnSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      shell: process.platform === 'win32',
    })
    if (res.status === 0 && typeof res.stdout === 'string') push(res.stdout.trim())
  } catch {
    // npm missing or slow — the remaining candidates still apply.
  }

  return roots
}

/** Cached global root holding @deepseek-ai/dsh (undefined = not resolved yet). */
let cachedDshRoot = undefined

/** The user-installed dsh (global npm): { bin, pkgDir, version } or null. */
function installedDshInfo() {
  const tryRoot = (root) => {
    const pkgDir = path.join(root, '@deepseek-ai', 'dsh')
    const bin = path.join(pkgDir, 'lib', 'bin.js')
    if (!fs.existsSync(bin)) return null
    // Version is read fresh on every call: a global update swaps the file
    // contents under the same path, and the auto-update loop watches for that.
    return { bin, pkgDir, version: dshVersionOf(pkgDir) }
  }
  if (cachedDshRoot !== undefined) {
    const hit = tryRoot(cachedDshRoot)
    if (hit !== null) return hit
    cachedDshRoot = undefined // root vanished (uninstalled) — re-resolve below
  }
  for (const root of dshSearchRoots()) {
    const hit = tryRoot(root)
    if (hit !== null) {
      cachedDshRoot = root
      return hit
    }
  }
  return null
}

// Prefer the user-installed dsh (global npm) so the desktop always matches the
// dsh version the user runs/updates. The bundled runtime is only a fallback.
function installedDshBin() {
  const installed = installedDshInfo()
  return installed !== null ? installed.bin : null
}

function serverBin() {
  const installed = installedDshBin()
  if (installed !== null) return installed
  return path.join(
    runtimeRoot(),
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js',
  )
}

/** dsh version baked into the packaged fallback runtime (or null). */
function bundledDshVersion() {
  return dshVersionOf(path.join(runtimeRoot(), 'node_modules', '@deepseek-ai', 'dsh'))
}

/**
 * Whether this dsh build's `web` command understands --no-open.
 *
 * Newer dsh (0.1.1-rc line) hands the web URL to the default browser on boot
 * (openBrowser defaults to true). The desktop window IS the browser surface,
 * so the desktop passes --no-open when supported to avoid a second copy of
 * the UI popping up in a browser tab. Older builds (bundled 0.1.0-rc fallback)
 * reject unknown flags AND lack the auto-open behavior entirely, so skipping
 * the flag there is both required and harmless. Cached in memory and in
 * userData/no-open-cache.json (keyed by path+size+mtime, so a dsh upgrade
 * invalidates the entry naturally; the first launch after an upgrade pays one
 * `--help` probe again).
 */
const noOpenSupportCache = new Map()
let noOpenDiskCacheLoaded = false

/** On-disk cache path (userData/no-open-cache.json), or null before ready. */
function noOpenCacheFile() {
  try {
    return path.join(app.getPath('userData'), 'no-open-cache.json')
  } catch {
    return null
  }
}

/** Load persisted entries once; keys are `bin|mtimeMs|size`, so a dsh upgrade invalidates them naturally. */
function loadNoOpenDiskCache() {
  if (noOpenDiskCacheLoaded) return
  noOpenDiskCacheLoaded = true
  try {
    const file = noOpenCacheFile()
    if (file === null || !fs.existsSync(file)) return
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'boolean') noOpenSupportCache.set(key, value)
    }
  } catch {
    // Corrupt cache: ignore it and recompute below.
  }
}

/** Persist the in-memory map; best effort only. */
function saveNoOpenDiskCache() {
  try {
    const file = noOpenCacheFile()
    if (file === null) return
    const entries = {}
    for (const [key, value] of noOpenSupportCache) entries[key] = value
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(entries), 'utf8')
  } catch {
    // Cache write failures must never affect startup.
  }
}

function supportsNoOpen(bin) {
  loadNoOpenDiskCache()
  let stat = null
  try { stat = fs.statSync(bin) } catch { /* missing bin: fall back to path-only key */ }
  const key = stat !== null ? `${bin}|${stat.mtimeMs}|${stat.size}` : bin
  const cached = noOpenSupportCache.get(key)
  if (cached !== undefined) return cached
  let supported = false
  try {
    const res = spawnSync(process.execPath, ['--expose-internals', bin, 'web', '--help'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
    })
    supported = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.includes('--no-open')
  } catch {
    supported = false
  }
  noOpenSupportCache.set(key, supported)
  saveNoOpenDiskCache()
  return supported
}

// ---------------------------------------------------------------------------
// Auto-update — keep the desktop on the newest released dsh
// ---------------------------------------------------------------------------
//
// Behavior (opt out with DSH_DESKTOP_NO_AUTO_UPDATE=1):
//  1. Shortly after launch, then every 6h, query the configured npm registry
//     for the latest @deepseek-ai/dsh version.
//  2. When the registry has a newer version than the one this session runs,
//     install it globally (`npm install -g`) automatically.
//  3. A running server keeps its already-loaded modules, so applying an
//     update needs a restart: a one-click "Relaunch" dialog appears. The same
//     dialog fires when the global install changes underneath us (e.g. the
//     user ran `npm i -g @deepseek-ai/dsh` themselves).
//
// Failures (offline, npm errors) are logged and retried on the next tick;
// they never block startup nor crash the app.

const UPDATE_FIRST_CHECK_MS = 30_000
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const LOCAL_VERSION_POLL_MS = 60_000
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000
/** npm dist-tag to follow: rc prereleases ship on `next`, stable ones on `latest`. */
const UPDATE_CHANNEL = process.env.DSH_DESKTOP_UPDATE_CHANNEL || 'next'

// --- Desktop shell self-update (GitHub Releases) ---
const SELF_UPDATE_REPO = process.env.DSH_DESKTOP_SELF_UPDATE_REPO || '123WP-a/deepseek-harness-desktop'
const SELF_UPDATE_FIRST_CHECK_MS = 60_000
const SELF_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const SELF_UPDATE_DOWNLOAD_TIMEOUT_MS = 120_000
let selfUpdateTimer = null

/** Registry override: wins over the machine's `npm config get registry` when set. */
const REGISTRY_OVERRIDE = process.env.DSH_DESKTOP_REGISTRY || null
/** 'auto' installs silently then prompts restart; 'notify' asks before installing. */
const UPDATE_MODE = process.env.DSH_DESKTOP_UPDATE_MODE === 'notify' ? 'notify' : 'auto'

/** dsh version this desktop session launched with (null = unknown). */
let launchedDshVersion = null
let cachedRegistryUrl = null
let updateCheckTimer = null
let localVersionTimer = null
let installInFlight = false
let promptedForVersion = null

/** Semver comparison good enough for x.y.z[-pre.N] release tags. */
function compareVersions(a, b) {
  const parse = (value) => {
    const match = String(value).trim().replace(/^v/, '')
      .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.\-]+))?/)
    if (!match) return null
    return { major: +match[1], minor: +match[2], patch: +match[3], pre: match[4] ? match[4].split('.') : [] }
  }
  const left = parse(a)
  const right = parse(b)
  if (left === null || right === null) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1 // release > prerelease of same core
  if (right.pre.length === 0) return -1
  const length = Math.max(left.pre.length, right.pre.length)
  for (let index = 0; index < length; index++) {
    const x = left.pre[index]
    const y = right.pre[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) {
      if (+x !== +y) return +x < +y ? -1 : 1
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1 // numeric identifiers sort lower
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/** The npm registry this machine is configured to use (cached). */
/** Trim trailing slashes; keep only http(s) URLs. Returns null otherwise. */
function normalizeRegistryUrl(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/\/+$/, '')
  return /^https?:\/\//.test(trimmed) && trimmed.length > 'https://'.length ? trimmed : null
}

function npmRegistry() {
  if (cachedRegistryUrl !== null) return cachedRegistryUrl
  const override = normalizeRegistryUrl(REGISTRY_OVERRIDE)
  if (override !== null) {
    cachedRegistryUrl = override
    return cachedRegistryUrl
  }
  try {
    const res = spawnSync('npm', ['config', 'get', 'registry'], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      shell: process.platform === 'win32',
    })
    if (res.status === 0 && typeof res.stdout === 'string') {
      const value = res.stdout.trim()
      if (/^https?:\/\//.test(value)) cachedRegistryUrl = value
    }
  } catch {
    // fall through to the default below
  }
  cachedRegistryUrl ??= 'https://registry.npmjs.org/'
  return cachedRegistryUrl
}

/** GET a JSON document; resolves null on any failure (never throws). */
function fetchJson(url, timeoutMs, extraHeaders) {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => { if (!settled) { settled = true; resolve(value) } }
    try {
      const transport = url.startsWith('http:') ? http : https
      const req = transport.get(url, { timeout: timeoutMs, headers: { accept: 'application/json', ...(extraHeaders ?? {}) } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); done(null); return }
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          try { done(JSON.parse(data)) } catch { done(null) }
        })
        res.on('error', () => done(null))
      })
      req.on('error', () => done(null))
      req.on('timeout', () => { req.destroy(); done(null) })
    } catch {
      done(null)
    }
  })
}

/** `npm install -g @deepseek-ai/dsh@<version>`; resolves { ok, log }. */
/**
 * Remember which dsh version we are upgrading FROM so a problematic new
 * release can be rolled back with one command:
 * `npm i -g @deepseek-ai/dsh@<previous>` (the desktop's local-version watcher
 * then offers the restart).
 */
function recordPreviousDshVersion(previous) {
  try {
    if (previous === null || previous === undefined) return
    const file = path.join(app.getPath('userData'), 'dsh-previous-version.json')
    fs.writeFileSync(file, JSON.stringify({ previous, recordedAt: new Date().toISOString() }, null, 2), 'utf8')
  } catch {
    // Best effort only; never block the update flow.
  }
}

function installGlobally(version) {
  return new Promise((resolve) => {
    if (installInFlight) { resolve({ ok: false, log: 'install already in flight' }); return }
    installInFlight = true
    let output = ''
    const child = spawn('npm', ['install', '-g', `@deepseek-ai/dsh@${version}`, '--registry', npmRegistry()], {
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
    }, INSTALL_TIMEOUT_MS)
    child.stdout?.on('data', (chunk) => { output += chunk.toString() })
    child.stderr?.on('data', (chunk) => { output += chunk.toString() })
    child.on('error', (error) => {
      clearTimeout(timer)
      installInFlight = false
      resolve({ ok: false, log: String(error) + '\n' + output.slice(-2000) })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      installInFlight = false
      resolve({ ok: code === 0, log: output.slice(-2000) })
    })
  })
}

function relaunchToUpdate() {
  app.relaunch()
  app.quit()
}

/** One-click "restart to apply" dialog; deduplicated per target version. */
function promptRestart(version) {
  if (promptedForVersion === version) return
  promptedForVersion = version
  const options = {
    type: 'info',
    title: 'DeepSeek Harness — 更新就绪',
    message: `dsh ${version} 已安装（当前运行 ${launchedDshVersion ?? '未知'}）`,
    detail: '重启 DeepSeek Harness 后生效。正在运行的任务会被终止，会话数据不受影响。',
    buttons: ['立即重启', '稍后'],
    defaultId: 0,
    cancelId: 1,
  }
  const show = () => {
    const box = window !== null
      ? dialog.showMessageBox(window, options)
      : dialog.showMessageBox(options)
    box.then(({ response }) => { if (response === 0) relaunchToUpdate() }).catch(() => {})
  }
  if (window !== null) show()
  else app.whenReady().then(show).catch(() => {})
}

async function checkForUpdateOnce() {
  if (process.env.DSH_DESKTOP_NO_AUTO_UPDATE === '1') return
  // Resolve the configured dist-tag via the small dist-tags document rather
  // than /latest: rc prereleases ship on `next`, so for a desktop following
  // prereleases the `latest` pointer may never move. Falls back to `latest`
  // when the configured tag is missing.
  const base = npmRegistry().replace(/\/+$/, '')
  const tags = await fetchJson(`${base}/-/package/${encodeURIComponent('@deepseek-ai/dsh')}/dist-tags`, 8000)
  const latest = tags !== null && typeof tags === 'object'
    ? (typeof tags[UPDATE_CHANNEL] === 'string' ? tags[UPDATE_CHANNEL]
      : typeof tags.latest === 'string' ? tags.latest : null)
    : null
  if (latest === null) return
  const installed = installedDshInfo()
  const current = installed?.version ?? bundledDshVersion()
  if (current !== null && compareVersions(latest, current) <= 0) return
  console.log(`[auto-update] registry has ${latest} > ${current ?? 'none'} (mode: ${UPDATE_MODE})`)
  // Record the version we are leaving behind (see recordPreviousDshVersion).
  recordPreviousDshVersion(current)
  if (UPDATE_MODE === 'notify') {
    const answer = await dialog.showMessageBox({
      type: 'info',
      buttons: [`升级到 ${latest}`, '稍后'],
      defaultId: 0,
      cancelId: 1,
      message: `发现 dsh 新版本 ${latest}`,
      detail: `当前版本 ${current ?? '未知'}。升级在后台安装，完成后会提示重启。`,
    })
    if (answer.response !== 0) return
  }
  const result = await installGlobally(latest)
  if (!result.ok) {
    console.warn('[auto-update] global install failed:\n' + result.log)
    return
  }
  const updated = installedDshInfo()
  if (updated !== null && compareVersions(updated.version ?? '0.0.0', launchedDshVersion ?? '0.0.0') > 0) {
    promptRestart(updated.version)
  }
}

function startAutoUpdate() {
  if (process.env.DSH_DESKTOP_SMOKE === '1') return
  if (process.env.DSH_DESKTOP_NO_AUTO_UPDATE === '1') return
  // Local watch: picks up manual `npm i -g` upgrades without waiting for the
  // next registry tick.
  localVersionTimer = setInterval(() => {
    const installed = installedDshInfo()
    if (
      installed !== null
      && compareVersions(installed.version ?? '0.0.0', launchedDshVersion ?? '0.0.0') > 0
    ) {
      promptRestart(installed.version)
    }
  }, LOCAL_VERSION_POLL_MS)
  updateCheckTimer = setTimeout(() => {
    void checkForUpdateOnce()
    updateCheckTimer = setInterval(() => { void checkForUpdateOnce() }, UPDATE_CHECK_INTERVAL_MS)
  }, UPDATE_FIRST_CHECK_MS)
}

function stopAutoUpdate() {
  if (updateCheckTimer !== null) {
    clearTimeout(updateCheckTimer)
    clearInterval(updateCheckTimer)
    updateCheckTimer = null
  }
  if (localVersionTimer !== null) {
    clearInterval(localVersionTimer)
    localVersionTimer = null
  }
}

// --- Desktop shell self-update via GitHub Releases ---
//
// The dsh updater above keeps the runtime fresh; this one updates the desktop
// shell itself. A release must carry two assets: `app.asar` and a
// `SHA256SUMS` file (`<hex>  app.asar`). The staged download is hash-verified
// before anything touches the live archive. Windows keeps the running asar
// locked, so the actual swap is performed by a detached cmd helper that waits
// for this exact process to exit, backs up the old archive, moves the new one
// in, and relaunches the app.

function selfUpdateResourcesDir() {
  return path.dirname(app.getAppPath())
}

/** GET a binary body following up to 5 redirects; resolves Buffer or null. */
function downloadToBuffer(url, timeoutMs, depth = 0) {
  return new Promise((resolve) => {
    if (depth > 5) { resolve(null); return }
    try {
      const req = https.get(url, { timeout: timeoutMs, headers: { 'user-agent': 'deepseek-harness-desktop' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          downloadToBuffer(new URL(res.headers.location, url).toString(), timeoutMs, depth + 1).then(resolve)
          return
        }
        if (res.statusCode !== 200) { res.resume(); resolve(null); return }
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve(Buffer.concat(chunks)))
        res.on('error', () => resolve(null))
      })
      req.on('error', () => resolve(null))
      req.on('timeout', () => { req.destroy(); resolve(null) })
    } catch {
      resolve(null)
    }
  })
}

/** Expected sha256 for `app.asar` parsed out of a SHA256SUMS document. */
function expectedSha256FromSums(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?app\.asar\s*$/.exec(line.trim())
    if (match) return match[1].toLowerCase()
  }
  return null
}

/**
 * Minimal structural sanity check on a downloaded asar: the two-level pickle
 * framing (u32 4 / regionLen / paddedStringSize / jsonLen) plus a JSON header
 * naming exactly our entry files. Guards against truncated, corrupt or
 * hostile non-asar payloads before they are staged next to the live archive.
 */
function looksLikeAppAsar(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 20) return false
    if (buf.readUInt32LE(0) !== 4) return false
    const headerSize = buf.readUInt32LE(12)
    if (headerSize < 2 || headerSize > 16 * 1024 * 1024) return false
    if (16 + headerSize > buf.length) return false
    const header = JSON.parse(buf.slice(16, 16 + headerSize).toString('utf8'))
    const files = header?.files ?? {}
    return ['main.js', 'package.json', 'appearance.js', 'preload.js'].every((name) => name in files)
  } catch {
    return false
  }
}

async function checkSelfUpdateOnce() {
  if (process.env.DSH_DESKTOP_SMOKE === '1') return
  if (process.env.DSH_DESKTOP_NO_SELF_UPDATE === '1') return
  const localVersion = app.getVersion()
  const release = await fetchJson(
    `https://api.github.com/repos/${SELF_UPDATE_REPO}/releases/latest`,
    10_000,
    { 'user-agent': 'deepseek-harness-desktop' },
  )
  if (release === null || typeof release.tag_name !== 'string') return
  const remoteVersion = release.tag_name.replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+/.test(remoteVersion)) return
  if (compareVersions(localVersion, remoteVersion) >= 0) return
  const assets = Array.isArray(release.assets) ? release.assets : []
  const asarAsset = assets.find((a) => a && a.name === 'app.asar')
  const sumsAsset = assets.find((a) => a && a.name === 'SHA256SUMS')
  if (
    !asarAsset || !sumsAsset
    || typeof asarAsset.browser_download_url !== 'string'
    || typeof sumsAsset.browser_download_url !== 'string'
  ) return
  const [asarBuf, sumsBuf] = await Promise.all([
    downloadToBuffer(asarAsset.browser_download_url, SELF_UPDATE_DOWNLOAD_TIMEOUT_MS),
    downloadToBuffer(sumsAsset.browser_download_url, SELF_UPDATE_DOWNLOAD_TIMEOUT_MS),
  ])
  if (asarBuf === null || sumsBuf === null || asarBuf.length < 1024) return
  const expected = expectedSha256FromSums(sumsBuf.toString('utf8'))
  const actual = crypto.createHash('sha256').update(asarBuf).digest('hex')
  if (expected === null || expected !== actual) return
  // Second integrity gate: the payload must parse as OUR app archive, not
  // merely match a (same-source) hash file.
  if (!looksLikeAppAsar(asarBuf)) return
  fs.writeFileSync(path.join(selfUpdateResourcesDir(), 'app.asar.new-selfupdate'), asarBuf)
  const answer = await dialog.showMessageBox({
    type: 'info',
    buttons: ['立即重启安装', '稍后'],
    defaultId: 0,
    cancelId: 1,
    message: `桌面端新版本 ${remoteVersion} 已就绪（已校验 SHA256）`,
    detail: `当前版本 ${localVersion}。安装会退出并自动重启桌面端。`,
  })
  if (answer.response !== 0) return
  applySelfUpdate(remoteVersion)
}

/**
 * Stage a detached cmd helper that waits for this exact process to exit,
 * backs up the running archive, swaps in the verified one, and relaunches.
 * ASCII-only content on purpose: cmd parses it under the OEM codepage.
 */
function applySelfUpdate(version) {
  try {
    const resDir = selfUpdateResourcesDir()
    const script = [
      '@echo off',
      ':wait',
      `tasklist /FI "PID eq ${process.pid}" | find /I "${process.pid}" >nul && (timeout /t 1 /nobreak >nul & goto wait)`,
      `copy /y "${path.join(resDir, 'app.asar')}" "${path.join(resDir, `app.asar.bak-selfupdate-${version}`)}" >nul`,
      `move /y "${path.join(resDir, 'app.asar.new-selfupdate')}" "${path.join(resDir, 'app.asar')}" >nul`,
      `start "" "${process.execPath}"`,
    ].join('\r\n')
    const helper = path.join(resDir, 'apply-self-update.cmd')
    fs.writeFileSync(helper, script, 'utf8')
    const child = spawn('cmd', ['/c', helper], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    app.quit()
  } catch {
    // Swallow: keeping the current version running is always safe.
  }
}

function startSelfUpdate() {
  if (process.env.DSH_DESKTOP_SMOKE === '1') return
  if (process.env.DSH_DESKTOP_NO_SELF_UPDATE === '1') return
  selfUpdateTimer = setTimeout(() => {
    void checkSelfUpdateOnce()
    selfUpdateTimer = setInterval(() => { void checkSelfUpdateOnce() }, SELF_UPDATE_CHECK_INTERVAL_MS)
  }, SELF_UPDATE_FIRST_CHECK_MS)
}

function stopSelfUpdate() {
  if (selfUpdateTimer !== null) {
    clearTimeout(selfUpdateTimer)
    clearInterval(selfUpdateTimer)
    selfUpdateTimer = null
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let serverProcess = null
let serverStderr = []
const MAX_STDERR_LINES = 200

function killServerTree() {
  if (serverProcess === null || serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
    serverProcess = null
    return
  }
  // Windows: taskkill /T terminates the whole process tree (the harness may
  // spawn shells/workers as children). POSIX: SIGTERM lets the tree shut down.
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(serverProcess.pid), '/T', '/F'], { windowsHide: true })
  } else {
    try { process.kill(-serverProcess.pid, 'SIGTERM') } catch { /* already gone */ }
  }
  serverProcess = null
}

function spawnServer() {
  const bin = serverBin()
  if (!fs.existsSync(bin)) {
    throw new Error(
      `dsh server entry not found at ${bin}\n\n`
      + 'The bundled runtime is missing. Rebuild the desktop app with: node scripts/build.js',
    )
  }
  // Remember which dsh version this session launched with; the auto-update
  // loop compares against it to decide when a restart is worth prompting.
  const installed = installedDshInfo()
  launchedDshVersion = installed?.version ?? bundledDshVersion()
  // ELECTRON_RUN_AS_NODE reuses this very executable as a plain Node runtime,
  // so no separate Node install is needed. --expose-internals is required by
  // the harness's config-HMR watcher (cordis-plugin-hmr). --no-open keeps the
  // spawned server from handing its URL to the default browser: the desktop
  // window itself is that surface (only passed when the build supports it).
  const args = ['--expose-internals', bin, 'web', '--port', '0']
  if (supportsNoOpen(bin)) args.push('--no-open')
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  serverProcess = child
  serverStderr = []
  let stdout = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
    const match = stdout.match(/dsh web: (http:\/\/[^\s]+)/)
    if (match) onServerReady(match[1])
  })
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString()
    serverStderr.push(text)
    if (serverStderr.length > MAX_STDERR_LINES) serverStderr.shift()
  })
  child.on('exit', (code, signal) => {
    // The window is open: the server died underneath us. If the window never
    // opened, showServerError handles the failure path via the timeout.
    if (window !== null) onServerDied(code, signal)
    serverProcess = null
  })
  return child
}

// ---------------------------------------------------------------------------
// Readiness gating — the "no connection refused" guarantee
// ---------------------------------------------------------------------------

const READINESS_TIMEOUT_MS = 90_000

function waitForHttp(url, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const probe = () => {
      const req = http.get(url, { timeout: 3000 }, (res) => {
        res.resume()
        if (res.statusCode >= 200 && res.statusCode < 500) {
          resolve(true)
          return
        }
        retry()
      })
      req.on('error', retry)
      req.on('timeout', () => { req.destroy(); retry() })
      function retry() {
        if (Date.now() > deadline) { resolve(false); return }
        setTimeout(probe, 400)
      }
    }
    probe()
  })
}

function onServerReady(url) {
  if (window !== null) return // already opened
  waitForHttp(url, READINESS_TIMEOUT_MS).then((ok) => {
    if (window !== null) return
    if (ok) {
      // Headless smoke test: DSH_DESKTOP_SMOKE=1 prints the ready URL and
      // exits instead of opening a window, so CI can verify the full
      // spawn→readiness→serve path without a display.
      if (process.env.DSH_DESKTOP_SMOKE === '1') {
        console.log(`DSH_DESKTOP_READY ${url}`)
        killServerTree()
        app.quit()
        return
      }
      openWindow(url)
    } else {
      showServerError(
        `Server answered the readiness line but never served HTTP 200 at ${url}.`,
      )
    }
  })
}

function onServerDied(code, signal) {
  if (window === null) {
    showServerError(`The dsh server exited before the window could open (code ${code ?? signal}).`)
    return
  }
  const choice = dialog.showMessageBoxSync(window, {
    type: 'error',
    title: 'DeepSeek Harness — server stopped',
    message: 'The DeepSeek Harness server stopped unexpectedly.',
    detail: `Exit code: ${code ?? signal}\n\n${serverStderr.slice(-30).join('')}`,
    buttons: ['Relaunch', 'Quit'],
    defaultId: 0,
    cancelId: 1,
  })
  if (choice === 0) relaunchServer()
  else app.quit()
}

function showServerError(detail) {
  const message = 'DeepSeek Harness could not start its local server.\n\n' + detail
  const choice = dialog.showMessageBoxSync({
    type: 'error',
    title: 'DeepSeek Harness — start failed',
    message,
    detail: serverStderr.slice(-60).join(''),
    buttons: ['Retry', 'Quit'],
    defaultId: 0,
    cancelId: 1,
  })
  if (choice === 0) relaunchServer()
  else app.quit()
}

function relaunchServer() {
  try {
    spawnServer()
  } catch (error) {
    dialog.showErrorBox('DeepSeek Harness — start failed', String(error))
    app.quit()
  }
}

function safeSpawnServer() {
  try {
    spawnServer()
  } catch (error) {
    dialog.showErrorBox('DeepSeek Harness — start failed', String(error))
    app.quit()
  }
}

// If a dsh web server is already listening on the default URL (e.g. another
// dsh web / this profile is already running), reuse it instead of spawning a
// second server. A second server on the same profile would fail to boot
// (task-board ledger lock), so attaching is both faster and conflict-free.
/** Where we remember the last dsh web URL this shell spawned/attached to. */
function lastSessionFile() {
  try {
    return path.join(app.getPath('userData'), 'dsh-last-session.json')
  } catch {
    return null
  }
}

function saveLastSessionUrl(url) {
  try {
    const file = lastSessionFile()
    if (file === null || typeof url !== 'string') return
    fs.writeFileSync(file, JSON.stringify({ url, savedAt: new Date().toISOString() }), 'utf8')
  } catch {
    // Best effort; reuse is an optimization, never a requirement.
  }
}

/** Last remembered loopback dsh URL, or null when absent/unshaped. */
function readLastSessionUrl() {
  try {
    const file = lastSessionFile()
    if (file === null || !fs.existsSync(file)) return null
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const url = typeof parsed?.url === 'string' ? parsed.url : null
    return url !== null && /^http:\/\/127\.0\.0\.1:\d+$/.test(url) ? url : null
  } catch {
    return null
  }
}

/**
 * Resolve true when `url` answers within timeoutMs AND the body identifies as
 * our dsh web UI. The identity check keeps a stale remembered port that has
 * since been taken by another local app from being mistaken for dsh.
 */
function probeDshWeb(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => { if (!settled) { settled = true; resolve(value) } }
    try {
      const transport = url.startsWith('http:') ? http : https
      const req = transport.get(url, { timeout: timeoutMs }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 500) { res.resume(); done(false); return }
        let body = ''
        let bytes = 0
        res.on('data', (chunk) => { bytes += chunk.length; if (bytes <= 65536) body += chunk.toString() })
        res.on('end', () => done(/deepseek|harness|dsh/i.test(body)))
        res.on('error', () => done(false))
      })
      req.on('error', () => done(false))
      req.on('timeout', () => { req.destroy(); done(false) })
    } catch {
      done(false)
    }
  })
}

function tryOpenExistingServer() {
  if (window !== null) return
  // Probe order: explicit override → last session's port (covers random-port
  // servers from a previous desktop run) → conventional 3080.
  const candidates = []
  if (process.env.DSH_WEB_URL) candidates.push(process.env.DSH_WEB_URL)
  const saved = readLastSessionUrl()
  if (saved && !candidates.includes(saved)) candidates.push(saved)
  const fallback = 'http://127.0.0.1:3080'
  if (!candidates.includes(fallback)) candidates.push(fallback)

  let index = 0
  const tryNext = () => {
    if (window !== null) return
    if (index >= candidates.length) { safeSpawnServer(); return }
    const url = candidates[index++]
    probeDshWeb(url, 1500).then((ok) => {
      if (ok) {
        console.log(`[reuse] attaching to existing dsh web at ${url}`)
        openWindow(url)
      } else {
        tryNext()
      }
    })
  }
  tryNext()
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

let window = null
/** Disposer for the settings-file watcher; assigned after app ready. */
let stopAppearanceSync = () => {}

// The window icon must match the desktop shortcut icon: the same official
// deepseek.ico. Packaged builds place it next to the exe (build.js copies it
// to the app root); dev builds keep it under desktop/assets/.
function windowIcon() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, '..', 'deepseek.ico')
  }
  return path.join(__dirname, 'assets', 'deepseek.ico')
}

/** Fixed window/app name — never let the page title or anything else change it. */
const APP_TITLE = 'DeepSeek Harness'

function titleBarColors() {
  const dark = nativeTheme.shouldUseDarkColors
  return {
    color: dark ? '#111111' : '#ffffff',
    symbolColor: dark ? '#ffffff' : '#1a1a1a',
  }
}

function injectDesktopTitlebar(webContents) {
  // Reserve a 32px top band so the custom title bar never covers dsh / web-ui
  // buttons: the whole app is pushed down by the band. The band is styled with
  // official dsh tokens and carries the window controls on the right.
  const css = [
    'html,body{height:100%;}',
    'body{padding-top:32px;box-sizing:border-box;}',
    '#dsh-desktop-titlebar{position:fixed;top:0;left:0;right:0;height:32px;',
    'display:flex;align-items:center;justify-content:space-between;',
    'background:var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1, #111111));',
    'color:var(--dsw-alias-label-primary, #eeeeee);',
    'border-bottom:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06));',
    '-webkit-app-region:drag;z-index:2147483000;user-select:none;}',
    '#dsh-desktop-titlebar .dsh-dt-title{font-size:12px;font-weight:600;padding-left:12px;',
    'color:var(--dsw-alias-label-secondary, #999999);letter-spacing:0.02em;}',
    '#dsh-desktop-titlebar .dsh-dt-buttons{display:flex;height:100%;-webkit-app-region:no-drag;}',
    '#dsh-desktop-titlebar .dsh-dt-btn{width:46px;height:100%;border:none;background:transparent;',
    'color:var(--dsw-alias-label-primary, #eeeeee);display:flex;align-items:center;justify-content:center;',
    'cursor:default;padding:0;}',
    '#dsh-desktop-titlebar .dsh-dt-btn:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.08));}',
    '#dsh-desktop-titlebar .dsh-dt-close:hover{background:var(--dsw-alias-state-error-primary, #e81123);color:#ffffff;}',
    '#dsh-desktop-titlebar .dsh-dt-btn svg{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:1.2;}',
  ].join('')
  webContents.insertCSS(css)
  const js = `(() => {
    if (document.getElementById('dsh-desktop-titlebar')) return;
    const bar = document.createElement('div');
    bar.id = 'dsh-desktop-titlebar';
    const title = document.createElement('span');
    title.className = 'dsh-dt-title';
    title.textContent = 'DeepSeek Harness';
    const buttons = document.createElement('div');
    buttons.className = 'dsh-dt-buttons';
    buttons.innerHTML =
      '<button class="dsh-dt-btn" data-action="minimize" aria-label="Minimize"><svg viewBox="0 0 12 12"><path d="M1 6h10"/></svg></button>' +
      '<button class="dsh-dt-btn dsh-dt-maximize" data-action="maximize" aria-label="Maximize"><svg viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" rx="0.5"/></svg></button>' +
      '<button class="dsh-dt-btn dsh-dt-close" data-action="close" aria-label="Close"><svg viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8"/></svg></button>';
    bar.appendChild(title);
    bar.appendChild(buttons);
    document.body.appendChild(bar);
    const setMaxIcon = (max) => {
      const b = document.querySelector('.dsh-dt-maximize');
      if (!b) return;
      b.innerHTML = max
        ? '<svg viewBox="0 0 12 12"><path d="M3.5 1.5h7v7M1.5 3.5h7v7"/></svg>'
        : '<svg viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" rx="0.5"/></svg>';
    };
    bar.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-action]');
      if (!btn || !window.desktopWindow) return;
      const action = btn.dataset.action;
      if (action === 'minimize') window.desktopWindow.minimize();
      else if (action === 'maximize') window.desktopWindow.toggleMaximize();
      else if (action === 'close') window.desktopWindow.close();
    });
    if (window.desktopWindow && window.desktopWindow.isMaximized) {
      window.desktopWindow.isMaximized().then(setMaxIcon).catch(() => {});
      window.desktopWindow.onMaximizedChange(setMaxIcon);
    }
  })()`
  webContents.executeJavaScript(js).catch(() => {})
  // Some web-ui plugins render fixed buttons at the very top-right corner
  // (e.g. dsh-better-sidebar's expand toggles). Those ignore body padding, so
  // push any fixed top-right element below the 32px title-bar band. Geometry
  // based, version-agnostic: future plugins with fixed top-right controls are
  // handled automatically without touching plugin code.
  const shiftJs = `(() => {
    const BAND = 32;
    const RIGHT_MARGIN = 220;
    // Only small top-right CONTROL clusters get pushed below the band.
    // Large surfaces (frosted side panels, translucent toolbars rendered by
    // skin-center themes with backdrop-filter) must keep their geometry, or
    // the translucent window frame develops a 32px gap under the title bar.
    const CONTROL_MAX_HEIGHT = 96;
    const shift = () => {
      for (const el of document.querySelectorAll('body *')) {
        if (el.id === 'dsh-desktop-titlebar') continue;
        if (el.closest && el.closest('#dsh-desktop-titlebar')) continue;
        if (el.dataset && el.dataset.dshDtShifted === 'true') continue;
        let r;
        try { r = el.getBoundingClientRect(); } catch { continue; }
        if (!r || r.width <= 0 || r.height <= 0) continue;
        if (r.top >= BAND || r.right <= window.innerWidth - RIGHT_MARGIN) continue;
        // Control clusters only — never large translucent surfaces.
        if (r.height > CONTROL_MAX_HEIGHT) continue;
        const s = getComputedStyle(el);
        // Fixed overlays AND absolute controls inside them both need the push:
        // dsh-better-sidebar mounts a fullscreen fixed host layer
        // ([data-dsh-panel-host]) with its top-right toggle cluster absolutely
        // positioned inside (.nArs4W_toggleCluster, top:3px right:10px).
        // Accepting only 'fixed' left those absolute buttons under the
        // title-bar band whenever their fullscreen parent was (correctly)
        // skipped by the isFullscreenLayer check below.
        if (s.position !== 'fixed' && s.position !== 'absolute') continue;
        // Skip background/fullscreen fixed layers (skin wallpaper, scrim,
        // backdrop blur, fullscreen overlays): they are not top-right buttons
        // and must not be pushed down by the title-bar band.
        const z = Number(s.zIndex);
        if (Number.isFinite(z) && z < 0) continue;
        const isFullscreenLayer =
          r.width >= window.innerWidth - 1 &&
          r.height >= window.innerHeight - 1;
        if (isFullscreenLayer) continue;
        el.dataset.dshDtShifted = 'true';
        el.style.setProperty('top', (Math.round(r.top + BAND)) + 'px', 'important');
      }
    };
    shift();
    setInterval(shift, 800);
    window.addEventListener('resize', shift);
  })()`
  webContents.executeJavaScript(shiftJs).catch(() => {})
}

function openWindow(url) {
  saveLastSessionUrl(url)
  const iconPath = windowIcon()
  const useNativeTitleBar = process.env.DSH_DESKTOP_NATIVE_TITLEBAR === '1'
  const overlay = titleBarColors()
  const browserOptions = {
    width: 1400,
    height: 900,
    title: APP_TITLE,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: overlay.color,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  }
  if (!useNativeTitleBar) {
    // Frameless integrated window: no native title bar, no native WCO overlay.
    // Window controls are drawn by the injected in-page title bar, so nothing
    // in the page's top-right corner is ever covered.
    browserOptions.titleBarStyle = 'hidden'
  }
  window = new BrowserWindow(browserOptions)
  window.setMenuBarVisibility(false)
  window.setTitle(APP_TITLE)
  // Lock the title bar name: the served page's <title> must not rename the
  // window (it would desync from the desktop shortcut name).
  window.on('page-title-updated', (event) => {
    event.preventDefault()
    window.setTitle(APP_TITLE)
  })
  // --- Runtime hardening (defense in depth; the shell already runs the page
  // with contextIsolation + sandbox and no Node in the renderer) ---
  let allowedOrigin = null
  try { allowedOrigin = new URL(url).origin } catch { /* keep null: deny-by-default */ }
  // Main-frame navigation stays on the served web UI's own origin; any other
  // target (a plugin linking to an external site) is handed to the system
  // browser instead of navigating this window away.
  window.webContents.on('will-navigate', (event, target) => {
    if (allowedOrigin !== null) {
      try {
        if (new URL(target).origin === allowedOrigin) return
      } catch { /* malformed target: fall through to block */ }
    }
    event.preventDefault()
    if (/^https?:\/\//i.test(target)) void shell.openExternal(target)
  })
  // Page-initiated popups never get a same-privilege Electron window:
  // same-origin popups keep the classic in-app window, http(s) elsewhere goes
  // to the system browser, and every other scheme is denied outright.
  window.webContents.setWindowOpenHandler((details) => {
    const target = typeof details?.url === 'string' ? details.url : ''
    // Script-authored tool popups (about:blank canvases written by their
    // opener — dsh-ssh's detachable terminals work this way) stay in-app:
    // they inherit this sandboxed renderer's context and cannot out-privilege
    // it, so denying them would only break plugin features.
    if (target === '' || target === 'about:blank') {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } }
    }
    if (allowedOrigin !== null) {
      try {
        if (new URL(target).origin === allowedOrigin) {
          return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } }
        }
      } catch { /* fall through */ }
    }
    if (/^https?:\/\//i.test(target)) void shell.openExternal(target)
    return { action: 'deny' }
  })
  // The web UI needs none of these today; deny-by-default closes the door on
  // camera/mic/geolocation/notification prompts from page content.
  window.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    console.log(`[security] denied permission request: ${permission}`)
    callback(false)
  })
  if (!useNativeTitleBar) {
    // Window-control IPC for the injected title bar.
    ipcMain.on('dsh-desktop:minimize', () => { if (window !== null) window.minimize() })
    ipcMain.on('dsh-desktop:toggle-maximize', () => {
      if (window === null) return
      if (window.isMaximized()) window.unmaximize()
      else window.maximize()
    })
    ipcMain.on('dsh-desktop:close', () => { if (window !== null) window.close() })
    ipcMain.handle('dsh-desktop:is-maximized', () => window !== null ? window.isMaximized() : false)
    window.on('maximize', () => { if (window !== null) window.webContents.send('dsh-desktop:maximized', true) })
    window.on('unmaximize', () => { if (window !== null) window.webContents.send('dsh-desktop:maximized', false) })

    // The in-page title bar uses official CSS tokens, so it re-themes itself.
    // Re-inject after navigation/theme changes (idempotent).
    nativeTheme.on('updated', () => {
      if (window === null) return
      injectDesktopTitlebar(window.webContents)
    })
    const onDomReady = () => {
      if (window === null) return
      injectDesktopTitlebar(window.webContents)
    }
    window.webContents.on('dom-ready', onDomReady)
    window.webContents.on('did-navigate', onDomReady)
  }
  window.loadURL(url)
  window.on('closed', () => {
    window = null
    killServerTree()
    app.quit()
  })
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// A second click must not start a second server on the same user data.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  // Fixed app identity: the process name, window title, and taskbar group
  // all show "DeepSeek Harness", matching the desktop shortcut name.
  // NOTE: no setAppUserModelId here — an AUMID with no registered display
  // name makes Windows fall back to the generic "Electron" taskbar label;
  // without it the taskbar uses the window title (locked to APP_TITLE below).
  app.setName(APP_TITLE)

  app.on('second-instance', () => {
    if (window !== null) {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
  })

  app.whenReady().then(() => {
    // Sync the window's native theme with the Web UI Appearance setting
    // before any window exists; the watcher keeps it live as the user edits
    // settings in the page.
    stopAppearanceSync = startAppearanceSync()
    try {
      tryOpenExistingServer()
    } catch (error) {
      dialog.showErrorBox('DeepSeek Harness — start failed', String(error))
      app.quit()
    }
    // Keep the desktop on the newest dsh: registry check + auto global
    // install + restart prompt. Failures are non-fatal by design.
    startAutoUpdate()
    // Keep the desktop shell itself fresh via GitHub Releases (hash-verified).
    startSelfUpdate()
  })

  app.on('window-all-closed', () => {
    killServerTree()
    app.quit()
  })

  app.on('before-quit', () => {
    stopAutoUpdate()
    stopSelfUpdate()
    stopAppearanceSync()
    killServerTree()
  })
}
