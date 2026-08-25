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

const { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell, Notification, Tray, Menu, powerSaveBlocker, globalShortcut } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const { startAppearanceSync } = require('./appearance.js')
const { createLineConsumer } = require('./line-stream.js')
const { applyProfileSafeMode, restoreProfileSafeMode } = require('./safe-mode.js')
const { checkForUpdate, installDshUpdate } = require('./update.js')
const { parseDesktopEvent, makeDesktopNotifier } = require('./notifier.js')
const { readSetting } = require('./settings-reader.js')

/** Sink for the structured desktop-event protocol; falls back to a log line. */
const desktopNotifier = makeDesktopNotifier({ Notification, log: (message) => serverStderr.push(message) })

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

// Prefer the user-installed dsh (global npm) so the desktop always matches the
// dsh version the user runs/updates. The bundled runtime is only a fallback.
function installedDshBin() {
  const candidates = []
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  }
  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, 'nodejs', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
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

// ---------------------------------------------------------------------------
// Safe mode - one launch with every third-party plugin entry disabled
// ---------------------------------------------------------------------------

/** Profile the desktop shell boots (matches `dsh web`'s default profile). */
const DESKTOP_PROFILE = process.env.DSH_DESKTOP_PROFILE || 'web'

function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
}

/** Marker whose presence makes the next server spawn boot in safe mode. */
function safeModeMarkerPath() {
  return path.join(app.getPath('userData'), 'safe-mode.flag')
}



/**
 * Mark the next spawn as a safe-mode launch (third-party entries disabled
 * via a generated --patch overlay) and restart the server tree. The marker
 * clears once that launch opens its window, so the launch after next is
 * normal again.
 */
function requestSafeModeRelaunch() {
  try {
    fs.writeFileSync(safeModeMarkerPath(), new Date().toISOString() + '\n')
  } catch (error) {
    dialog.showErrorBox('DeepSeek Harness - safe mode', `Cannot write the safe-mode marker:\n${String(error)}`)
    return
  }
  killServerTree()
  relaunchServer()
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let serverProcess = null
let serverStderr = []
const MAX_STDERR_LINES = 200
/** A partial stdout line longer than this (no newline yet) is dropped, not buffered forever. */
const MAX_PENDING_LINE_BYTES = 64 * 1024

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
  // The web subcommand rejects launcher-level --patch, so safe mode works by
  // temporarily extending the profile's own patch layer (backup + restore).
  // --no-open: the desktop owns its window; the server must not open a browser tab.
  const args = ['--expose-internals', bin, 'web', '--port', '0', '--no-open']
  if (fs.existsSync(safeModeMarkerPath())) {
    const applied = applyProfileSafeMode({ dshHome: dshHome(), profile: DESKTOP_PROFILE, runtimeRoot: runtimeRoot(), log: serverStderr })
    if (!applied) {
      // Nothing to disable or application failed: launch normally this time.
      fs.rmSync(safeModeMarkerPath(), { force: true })
    }
  }
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
  // Consume server stdout line by line (see line-stream.js) instead of
  // accumulating every byte, which grew memory on long-lived servers.
  const stdoutLines = createLineConsumer(handleServerLine, MAX_PENDING_LINE_BYTES)
  child.stdout.on('data', (chunk) => stdoutLines.push(chunk.toString()))
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

/**
 * Handle one complete stdout line from the server process.
 * Recognizes the readiness line (anchored, so a LAN-suffix URL cannot
 * shadow the local one) and the reserved structured desktop-event
 * protocol prefix; anything else is ordinary server chatter.
 * @param {string} line
 */
function handleServerLine(line) {
  const ready = line.match(/^dsh web: (http:\/\/\S+)/)
  if (ready !== null) {
    onServerReady(ready[1])
    return
  }
  if (line.indexOf('dsh desktop-event:') === 0) {
    // Tasks-edge events drive the close guard directly; everything else goes
    // through the strict notifier path (OS notification).
    try {
      const raw = JSON.parse(line.slice('dsh desktop-event: '.length))
      if (raw !== null && typeof raw === 'object' && raw.type === 'tasks') {
        closeGuardActive = raw.active === true
        syncAttentionState()
        return
      }
    } catch {}
    const event = parseDesktopEvent(line)
    if (event !== null) desktopNotifier(event)
  }
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
    buttons: ['Relaunch', 'Relaunch in safe mode', 'Quit'],
    defaultId: 0,
    cancelId: 2,
  })
  if (choice === 1) requestSafeModeRelaunch()
  else if (choice === 0) relaunchServer()
  else app.quit()
}

function showServerError(detail) {
  const message = 'DeepSeek Harness could not start its local server.\n\n' + detail
  const choice = dialog.showMessageBoxSync({
    type: 'error',
    title: 'DeepSeek Harness — start failed',
    message,
    detail: serverStderr.slice(-60).join(''),
    buttons: ['Retry', 'Relaunch in safe mode', 'Quit'],
    defaultId: 0,
    cancelId: 2,
  })
  if (choice === 1) requestSafeModeRelaunch()
  else if (choice === 0) relaunchServer()
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
function tryOpenExistingServer() {
  if (window !== null) return
  const url = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
  const req = http.get(url, { timeout: 1500 }, (res) => {
    res.resume()
    if (res.statusCode >= 200 && res.statusCode < 500) {
      openWindow(url)
    } else {
      safeSpawnServer()
    }
  })
  req.on('error', () => safeSpawnServer())
  req.on('timeout', () => {
    req.destroy()
    safeSpawnServer()
  })
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

let window = null
/** Set by the page while background work is running; closing then asks first. */
let closeGuardActive = false
/** True once the user asked to really quit (tray Quit), unblocking close/quit. */
let userRequestedQuit = false

if (process.env.DSH_DESKTOP_TEST_HOOK === '1') {
  globalThis.__dshGuard = () => ({ closeGuardActive, userRequestedQuit, errTail: serverStderr.slice(-4), updateStarted: updateCheckStarted })
}

/** Active powerSaveBlocker token, or 0 while idle. */
let preservationId = 0

/** Reflect `closeGuardActive` onto OS presence: prevent system sleep while work is running, and drive the taskbar progress to indeterminate (or clear it). */
function syncAttentionState() {
  if (window === null) return
  if (closeGuardActive && preservationId === 0) {
    preservationId = powerSaveBlocker.start('prevent-app-suspension')
  } else if (!closeGuardActive && preservationId !== 0) {
    try { powerSaveBlocker.stop(preservationId) } catch { /* already stopped */ }
    preservationId = 0
  }
  window.setProgressBar(closeGuardActive ? 2 : -1)
}

/** Apply the persisted `desktop.autostart` preference to the OS login item. */
function applyAutostart() {
  try {
    const enable = readSetting(['desktop', 'autostart'], false) === true
    if (typeof app.setLoginItemSettings === 'function') app.setLoginItemSettings({ openAtLogin: enable })
  } catch (error) {
    serverStderr.push(`desktop autostart unavailable: ${String(error)}`)
  }
}

/**
 * Wire the documented auto-update flow for real: once per app run, shortly
 * after the first window opens, check the configured dist-tag and stage a
 * newer dsh into the per-user staging directory (fingerprints recorded;
 * verified at activation). Channel/registry come from settings with env
 * fallbacks. Failures are logged, never fatal.
 */
let updateCheckStarted = false
function scheduleUpdateCheck() {
  if (process.env.DSH_DESKTOP_SMOKE === '1') return
  if (process.env.DSH_DESKTOP_DISABLE_UPDATE === '1') return
  if (updateCheckStarted) return
  updateCheckStarted = true
  const delayMs = Number(process.env.DSH_DESKTOP_UPDATE_DELAY_MS || '15000')
  const timer = setTimeout(() => {
    runUpdateCheck().catch((error) => serverStderr.push(`desktop update check failed: ${String(error)}`))
  }, Math.max(0, delayMs))
  if (typeof timer.unref === 'function') timer.unref()
}

/** Check dist-tag; stage a newer dsh; notify via desktop-event when staged. */
async function runUpdateCheck() {
  const channel = String(readSetting(['desktop', 'updateChannel'], process.env.DSH_DESKTOP_UPDATE_CHANNEL || 'next'))
  const registry = String(readSetting(['desktop', 'updateRegistry'], process.env.DSH_DESKTOP_REGISTRY || 'https://registry.npmjs.org'))
  const stagingDir = path.join(app.getPath('userData'), 'runtime-next')
  const cacheDir = path.join(app.getPath('userData'), 'npm-cache')
  const status = await checkForUpdate({ runtimeRoot: runtimeRoot(), channel, registry })
  if (!status.updateAvailable) {
    serverStderr.push(`desktop update: dsh ${status.currentVersion} is up to date (${channel})`)
    return
  }
  const version = await installDshUpdate({ version: status.latestVersion, targetDir: stagingDir, cacheDir, registry })
  desktopNotifier({ type: 'notify', title: 'dsh 更新已暂存', body: `dsh ${version} 已下载；下次启动校验通过后应用` })
}

/** Register a global summon-hotkey for the main window; skipped in smoke mode. */
function registerGlobalShortcuts() {
  if (process.env.DSH_DESKTOP_SMOKE === '1') return
  try {
    globalShortcut.register('CommandOrControl+Shift+H', () => {
      if (window === null) return
      window.show()
      window.focus()
    })
  } catch (error) {
    serverStderr.push(`desktop global shortcut unavailable: ${String(error)}`)
  }
}
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
    const shift = () => {
      for (const el of document.querySelectorAll('body *')) {
        if (el.id === 'dsh-desktop-titlebar') continue;
        if (el.closest && el.closest('#dsh-desktop-titlebar')) continue;
        if (el.dataset && el.dataset.dshDtShifted === 'true') continue;
        let r;
        try { r = el.getBoundingClientRect(); } catch { continue; }
        if (!r || r.width <= 0 || r.height <= 0) continue;
        if (r.top >= BAND || r.right <= window.innerWidth - RIGHT_MARGIN) continue;
        const s = getComputedStyle(el);
        if (s.position !== 'fixed') continue;
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

// ---------------------------------------------------------------------------
// Navigation containment - external http(s) links belong to the OS browser
// ---------------------------------------------------------------------------

/** Origin of the served dsh UI, or null before the first successful load. */
function selfOrigin() {
  if (window === null) return null
  try {
    return new URL(window.webContents.getURL()).origin
  } catch {
    return null
  }
}

/** Whether a URL belongs to the local dsh server this window renders. */
function isSelfUrl(url) {
  const origin = selfOrigin()
  if (origin === null) return false
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}

/** True for plain web links; other schemes (file:, custom protocols) never open. */
function isExternalHttpUrl(url) {
  return /^https?:\/\//i.test(url)
}

/**
 * Decide one window.open request from the page.
 * Same-origin popups render in-app; staged blank popups are allowed because
 * plugins open about:blank first and assign location afterwards (xterm OSC
 * link handlers do exactly this) - those get a will-navigate guard attached
 * in did-create-window. Every other http(s) URL goes to the default browser;
 * non-http(s) schemes are denied outright.
 * @param {string} url - the requested popup URL ('' when staged blank).
 * @returns {object} Electron window-open handler result.
 */
function windowOpenDecision(url) {
  if (url === '' || url === 'about:blank') {
    return {
      action: 'allow',
      overrideBrowserWindowOptions: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    }
  }
  if (isSelfUrl(url)) return { action: 'allow' }
  if (isExternalHttpUrl(url)) {
    void shell.openExternal(url).catch(() => {})
  }
  return { action: 'deny' }
}

/** User preference: close quits the app (default) or hides to tray-resident mode. */
function channelHint() { return String(readSetting(['desktop', 'updateChannel'], process.env.DSH_DESKTOP_UPDATE_CHANNEL || 'next')) }

function readCloseBehavior() {
  const value = readSetting(['desktop', 'closeBehavior'], 'quit')
  return value === 'tray' ? 'tray' : 'quit'
}

let tray = null

/** Create the system-tray presence (icon + Show/Quit menu); skipped in smoke mode. */
function createTray() {
  if (process.env.DSH_DESKTOP_SMOKE === '1') return
  const icon = windowIcon()
  if (!fs.existsSync(icon)) return
  try {
    tray = new Tray(icon)
    tray.setToolTip(APP_TITLE)
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show window', click: () => { if (window !== null) { window.show(); window.focus() } } },
      { type: 'separator' },
      { label: 'Quit', click: () => { userRequestedQuit = true; app.quit() } },
    ]))
    tray.on('click', () => { if (window !== null) { window.show(); window.focus() } })
  } catch (error) {
    serverStderr.push(`desktop tray unavailable: ${String(error)}`)
  }
}

function openWindow(url) {
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
  // External links must never replace the app view or open unsandboxed
  // windows. See windowOpenDecision for the policy; staged blank popups get
  // their eventual external navigation bounced to the system browser.
  window.webContents.setWindowOpenHandler((details) => windowOpenDecision(details.url ?? ''))
  window.webContents.on('did-create-window', (childWindow) => {
    childWindow.webContents.on('will-navigate', (event, url) => {
      if (isSelfUrl(url)) return
      event.preventDefault()
      if (isExternalHttpUrl(url)) void shell.openExternal(url).catch(() => {})
      childWindow.close()
    })
  })
  // Belt and braces: a top-level main-window navigation away from the local
  // server bounces to the browser instead of replacing the app.
  window.webContents.on('will-navigate', (event, url) => {
    if (isSelfUrl(url)) return
    event.preventDefault()
    if (isExternalHttpUrl(url)) void shell.openExternal(url).catch(() => {})
  })
  // Exit protection: while the page reports active background work
  // (goals, jobs), closing the window asks first instead of killing the
  // server tree underneath them.
  ipcMain.on('dsh-desktop:set-close-guard', (_event, active) => {
    closeGuardActive = active === true
    syncAttentionState()
  })
  window.on('close', (event) => {
    if (userRequestedQuit) return
    // Tray-resident mode: hide instead of closing, so the server and any
    // background daemon-loop plugins keep running.
    if (readCloseBehavior() === 'tray') {
      event.preventDefault()
      window.hide()
      return
    }
    if (!closeGuardActive) return
    event.preventDefault()
    const choice = dialog.showMessageBoxSync(window, {
      type: 'warning',
      title: 'DeepSeek Harness - tasks running',
      message: 'Background tasks are still running.',
      detail: 'Closing now terminates the server process tree and every running job.',
      buttons: ['Close anyway', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    })
    if (choice === 0) {
      closeGuardActive = false
      userRequestedQuit = true
      window.destroy()
    }
  })

  // One-shot semantics: this launch opened its window under the safe-mode
  // patch, so restore the user patch layer and clear the marker - the next
  // launch returns to the normal plugin set. A crash afterwards lands back
  // in the error dialog, which offers safe mode again.
  restoreProfileSafeMode({ dshHome: dshHome(), profile: DESKTOP_PROFILE })
  try {
    fs.rmSync(safeModeMarkerPath(), { force: true })
  } catch { /* best effort; a stale marker just repeats safe mode */ }

  scheduleUpdateCheck()

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
      window.show()
      window.focus()
    }
  })

  app.whenReady().then(() => {
    // Sync the window's native theme with the Web UI Appearance setting
    // before any window exists; the watcher keeps it live as the user edits
    // settings in the page.
    stopAppearanceSync = startAppearanceSync()
    createTray()
    applyAutostart()
    registerGlobalShortcuts()
    syncAttentionState()
    try {
      tryOpenExistingServer()
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
    try { if (preservationId !== 0) powerSaveBlocker.stop(preservationId) } catch {}
    try { globalShortcut.unregisterAll() } catch {}
  })
}
