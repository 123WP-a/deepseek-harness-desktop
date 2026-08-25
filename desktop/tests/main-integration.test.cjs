const assert = require('node:assert')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const Module = require('node:module')

const desktopDir = path.join(__dirname, '..')
const tmpUserData = path.join(os.tmpdir(), 'dsh-desktop-int-ud-' + Date.now())
const tmpTrayHome = path.join(os.tmpdir(), 'dsh-desktop-int-home-' + Date.now())
  const tmpSafeHome = path.join(os.tmpdir(), 'dsh-desktop-int-safe-' + Date.now())
fs.mkdirSync(tmpUserData, { recursive: true }); fs.mkdirSync(tmpTrayHome, { recursive: true }); fs.mkdirSync(path.join(tmpSafeHome, 'profiles', 'web'), { recursive: true })
  fs.writeFileSync(path.join(tmpSafeHome, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'p', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }))
  fs.writeFileSync(path.join(tmpSafeHome, 'profiles', 'web', 'cordis.patch.yml'), '- id: probe-x\n  name: \'probe-x\'\n')
fs.writeFileSync(path.join(tmpTrayHome, 'settings.yaml'), 'desktop:\n  closeBehavior: tray\n')

const captured = { args: null, closeGuardHandler: null, windowCloseHandlers: [], dialogCount: 0, readyLines: [], notif: null, notifShown: 0, hideCount: 0, pbStart: 0, pbStop: 0, progress: -1, progressCount: 0, loginItem: null, scRegister: 0, scUnreg: 0, httpUrls: [], npmArgs: null, packumentHits: 0 }
const origLog = console.log
console.log = (...a) => { captured.readyLines.push(a.join(' ')); origLog.apply(console, a) }

class FakeBrowserWindow {
  constructor() {
    this.isMaximized = () => false
    this.webContents = {
      getURL: () => 'http://127.0.0.1:3999/',
      on: () => {},
      insertCSS: () => {},
      executeJavaScript: () => Promise.resolve(),
      send: () => {},
      setWindowOpenHandler: () => {},
    }
  }
  setMenuBarVisibility() {}
  setTitle() {}
  loadURL() {}
  close() {}
  destroy() {}
  onMaximizedChange() {}
  hide() { captured.hideCount++ }
  setProgressBar(v) { captured.progress = v; captured.progressCount++ }
  show() {}
  focus() {}
  on(ev, cb) { if (ev === 'close') captured.windowCloseHandlers.push(cb) }
}

function makeElectron() {
  const Notif = class { constructor(opts) { captured.notif = opts } show() { captured.notifShown++ } }; Notif.isSupported = () => true
  return {
    app: {
      isPackaged: false,
      getAppPath: () => desktopDir,
      getPath: () => tmpUserData,
      setPath: () => {},
      requestSingleInstanceLock: () => true,
      quit: () => {},
      setName: () => {},
      setLoginItemSettings: (opts) => { captured.loginItem = opts },
      on: () => {},
      whenReady: () => Promise.resolve(),
    },
    Notification: Notif,
    Tray: class { constructor() {} setToolTip() {} setContextMenu() {} on() {} },
    Menu: { buildFromTemplate: () => ({}) },
    BrowserWindow: FakeBrowserWindow,
    dialog: {
      showMessageBoxSync: () => { captured.dialogCount++; return 0 },
      showMessageBox: () => Promise.resolve({ response: 0 }),
      showErrorBox: () => {},
    },
    ipcMain: { on: (ch, cb) => { if (ch === 'dsh-desktop:set-close-guard') captured.closeGuardHandler = cb }, handle: () => Promise.resolve(false) },
    nativeTheme: { shouldUseDarkColors: false, on: () => {}, themeSource: '' },
    shell: { openExternal: () => Promise.resolve() },
    powerSaveBlocker: { start: () => { captured.pbStart++; return 1 }, stop: () => { captured.pbStop++ } },
    globalShortcut: { register: () => { captured.scRegister++; return true }, unregisterAll: () => { captured.scUnreg++ } },
  }
}

function fresh() {
  return {
    spawn: (exe, args) => {
      if (args.some((a) => String(a).includes('@deepseek-ai/dsh@'))) {
        captured.npmArgs = args
        const prefixIdx = args.indexOf('--prefix')
        const target = prefixIdx >= 0 ? String(args[prefixIdx + 1]) : ''
        const pkgArg = args.find((a) => String(a).startsWith('@deepseek-ai/dsh@'))
        const version = String(pkgArg).split('@').pop()
        try {
          const pkgDir = path.join(target, 'node_modules', '@deepseek-ai', 'dsh')
          fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true })
          fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
          fs.writeFileSync(path.join(pkgDir, 'lib', 'index.js'), 'export {}')
          fs.writeFileSync(path.join(pkgDir, 'lib', 'bin.js'), '// staged bin')
        } catch {}
        const cbs = {}
        const child = { pid: 4321, exitCode: null, signalCode: null, stdout: { on: () => {} }, stderr: { on: () => {} }, on: (ev, cb) => { cbs[ev] = cb } }
        setImmediate(() => { child.exitCode = 0; if (cbs.exit) cbs.exit(0, null) })
        return child
      }
      captured.args = args
      const child = { pid: 12345, exitCode: null, signalCode: null }
      child.stdout = { on: (ev, cb) => { if (ev === 'data') setImmediate(() => cb('dsh web: http://127.0.0.1:3999\ndsh desktop-event: {\"type\":\"tasks\",\"active\":true}\ndsh desktop-event: {\"type\":\"notify\",\"title\":\"Task done\",\"body\":\"ok\"}\n')) } }
      child.stderr = { on: () => {} }
      child.on = () => {}
      return child
    },
    spawnSync: () => ({ status: 0 }),
  }
}

const fakeHttp = {
  get: (url, opts, cb) => { captured.httpUrls.push(String(url));
    const req = { on: (ev, fn) => { if (ev === 'error') req._onErr = fn }, destroy: () => {} }
    if (String(url).includes(':1')) setImmediate(() => { if (req._onErr) req._onErr(new Error('conn refused')) }); else if (String(url).includes('%2F') || String(url).includes('%2f')) { captured.packumentHits++; const body = JSON.stringify({ 'dist-tags': { next: '9.9.9' } }); const res = { statusCode: 200, resume: () => {}, on: (ev, fn) => { if (ev === 'data') setImmediate(() => fn(Buffer.from(body))); if (ev === 'end') setImmediate(() => fn()) }, destroy: () => {} }; setImmediate(() => cb(res)) }
    else { const res = { statusCode: 200, resume: () => {}, on: () => {}, destroy: () => {} }; setImmediate(() => cb(res)) }
    return req
  }
}

function install() {
  const orig = Module._load
  Module._load = function (request) {
    if (request === 'electron') return makeElectron()
    if (request === 'node:child_process' || request === 'child_process') return fresh()
    if (request === 'node:http' || request === 'http' || request === 'node:https' || request === 'https') return fakeHttp
    return orig.apply(this, arguments)
  }
}
const mainPath = path.resolve(desktopDir, 'main.js')

async function run() {
  process.env.DSH_DESKTOP_SMOKE = '1'
  process.env.DSH_WEB_URL = 'http://127.0.0.1:1'
  process.env.DSH_DESKTOP_TEST_HOOK = '1'
  process.env.DSH_DESKTOP_UPDATE_DELAY_MS = '10'
  process.env.DSH_HOME = tmpSafeHome
  fs.writeFileSync(path.join(tmpUserData, 'safe-mode.flag'), Date.now() + '\n')
  install()
  require(mainPath)
  await new Promise((r) => setTimeout(r, 500))
  assert.ok(captured.args !== null, 'spawn called')
  assert.strictEqual(captured.args[2], 'web', 'subcommand web')
  assert.ok(captured.args.includes('--no-open'), 'no-open flag')
  assert.ok(!captured.args.includes('--patch'), 'no launcher --patch (web rejects it)')
  const safePatch = path.join(tmpSafeHome, 'profiles', 'web', 'cordis.patch.yml')
  assert.ok(fs.existsSync(safePatch + '.safe-backup'), 'safe-mode backup written')
  assert.ok(fs.readFileSync(safePatch, 'utf8').includes('disabled: true'), 'disable rows appended to user patch')
  const ready = captured.readyLines.find((l) => l.includes('DSH_DESKTOP_READY'))
  assert.ok(ready, 'readiness printed')
  assert.ok(captured.notifShown >= 1, 'OS notification from desktop-event line')
  assert.strictEqual(captured.notif.title, 'Task done', 'notification title')
  assert.ok(globalThis.__dshGuard().closeGuardActive === true, 'close guard active from tasks line')
  assert.strictEqual(globalThis.__dshGuard().userRequestedQuit, false)
  console.log('C RUN1 (safe-mode wiring + readiness + notification + tasks-guard): PASS')

  delete process.env.DSH_DESKTOP_SMOKE
  process.env.DSH_WEB_URL = 'http://127.0.0.1:3080'
  process.env.DSH_HOME = tmpTrayHome
  captured.args = null; captured.windowCloseHandlers = []; captured.closeGuardHandler = null; captured.dialogCount = 0; captured.hideCount = 0; captured.pbStart = 0; captured.pbStop = 0; captured.progress = -1; captured.progressCount = 0; captured.scRegister = 0; captured.npmArgs = null; captured.packumentHits = 0
  process.env.DSH_DESKTOP_UPDATE_DELAY_MS = '10'
  delete require.cache[require.resolve(mainPath)]
  install()
  require(mainPath)
  await new Promise((r) => setTimeout(r, 300))
  assert.ok(captured.closeGuardHandler !== null)
  assert.ok(captured.windowCloseHandlers.length > 0)
  captured.closeGuardHandler(null, false)
  let prevented = false
  captured.windowCloseHandlers[0]({ preventDefault: () => { prevented = true } })
  assert.strictEqual(prevented, true, 'tray mode: close prevented')
  assert.ok(captured.hideCount >= 1, 'tray mode: window hidden')
  fs.writeFileSync(path.join(tmpTrayHome, 'settings.yaml'), 'desktop: {}\n')
  prevented = false
  captured.windowCloseHandlers[0]({ preventDefault: () => { prevented = true } })
  assert.strictEqual(prevented, false, 'quit mode: close not prevented')
  // M3: autostart + global shortcut + attention state (powersave + taskbar progress)
  assert.ok(captured.loginItem !== null && captured.loginItem.openAtLogin === false, 'autostart read from settings defaults to off')
  assert.ok(captured.scRegister >= 1, 'global summon hotkey registered')
  captured.closeGuardHandler(null, true)
  assert.ok(captured.pbStart >= 1, 'powerSaveBlocker started while task active')
  assert.strictEqual(captured.progress, 2, 'taskbar indeterminate while task active')
  captured.closeGuardHandler(null, false)
  assert.ok(captured.pbStop >= 1, 'powerSaveBlocker stopped when idle')
  assert.strictEqual(captured.progress, -1, 'taskbar progress cleared when idle')
  // M3/S11: wired auto-update — packument fetched, npm stages pinned version
  await new Promise((r2) => setTimeout(r2, 120))
  console.log('DEBUG guard=', JSON.stringify(globalThis.__dshGuard ? globalThis.__dshGuard() : null))
  assert.ok(captured.packumentHits >= 1, 'packument fetched; guard=' + JSON.stringify(globalThis.__dshGuard ? globalThis.__dshGuard() : 'no-hook'))
  assert.ok(captured.npmArgs !== null, 'npm staging invoked')
  assert.ok(captured.npmArgs.some((a) => String(a) === '@deepseek-ai/dsh@9.9.9'), 'pins latest version')
  assert.ok(captured.notif !== null && String(captured.notif.title).includes('dsh'), 'staged notification shown')
  console.log('C RUN2 (close-guard + tray closeBehavior): PASS')
}

run().then(() => { console.log = origLog; console.log('C main-integration: PASS'); process.exit(0) }).catch((err) => { console.log = origLog; console.error('C FAIL:', err); process.exit(1) })
