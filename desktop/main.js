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

const { app, BrowserWindow, dialog, nativeTheme } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const http = require('node:http')
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

function serverBin() {
  return path.join(
    runtimeRoot(),
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js',
  )
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
  // ELECTRON_RUN_AS_NODE reuses this very executable as a plain Node runtime,
  // so no separate Node install is needed. --expose-internals is required by
  // the harness's config-HMR watcher (cordis-plugin-hmr).
  const child = spawn(process.execPath, ['--expose-internals', bin, 'web', '--port', '0'], {
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

function openWindow(url) {
  const iconPath = windowIcon()
  window = new BrowserWindow({
    width: 1400,
    height: 900,
    title: APP_TITLE,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    // Match the harness Appearance setting while the page loads: dark theme
    // gets a dark background, so there is no white flash before the page
    // paints its own background.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111111' : '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  window.setMenuBarVisibility(false)
  window.setTitle(APP_TITLE)
  // Lock the title bar name: the served page's <title> must not rename the
  // window (it would desync from the desktop shortcut name).
  window.on('page-title-updated', (event) => {
    event.preventDefault()
    window.setTitle(APP_TITLE)
  })
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
  app.setName(APP_TITLE)
  app.setAppUserModelId('ai.deepseek.harness.desktop')

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
      spawnServer()
    } catch (error) {
      dialog.showErrorBox('DeepSeek Harness — start failed', String(error))
      app.quit()
    }
  })

  app.on('window-all-closed', () => {
    killServerTree()
    app.quit()
  })

  app.on('before-quit', () => {
    stopAppearanceSync()
    killServerTree()
  })
}
