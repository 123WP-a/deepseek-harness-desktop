// DeepSeek Harness desktop build — assembles a self-contained app folder.
//
// Layout produced under desktop/dist/DeepSeek Harness/:
//   DeepSeek Harness.exe        Electron binary with the DeepSeek icon embedded
//   resources/app.asar          this shell (main.js + appearance.js + package.json)
//   resources/runtime/          the dsh server runtime closure (npm-installed)
//   deepseek.ico                official icon, next to the exe for the shortcut
//
// The folder is built by electron-builder (win dir target): it embeds the
// official icon into the exe — the taskbar and pinned-icon source — which a
// plain rename of electron.exe cannot do. The app folder is self-contained:
// the exe embeds the Electron runtime, and the server closure ships inside
// resources/runtime. Nothing else needs to be installed on the target machine.

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const APP_NAME = 'DeepSeek Harness'
const APP_DIR = path.join(DIST, APP_NAME)

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true })
}

function copy(src, dest) {
  fs.cpSync(src, dest, { recursive: true })
}

function main() {
  // 1. The dsh server runtime closure (npm-installed @deepseek-ai/dsh + deps).
  const runtimeNodeModules = path.join(ROOT, 'runtime', 'node_modules')
  if (!fs.existsSync(path.join(runtimeNodeModules, '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
    throw new Error(
      'Server runtime closure not found. Run: node scripts/prepare-runtime.js',
    )
  }

  // 2. The official icon (embedded into the exe + kept next to it).
  const icon = path.join(ROOT, 'assets', 'deepseek.ico')
  if (!fs.existsSync(icon)) {
    throw new Error('deepseek.ico not found. Run: node scripts/make-icon.js (needs sharp)')
  }

  // 3. electron-builder win dir target: packages main.js + appearance.js into
  // app.asar, embeds the icon into DeepSeek Harness.exe, and copies the
  // runtime closure into resources/runtime. The window icon (BrowserWindow)
  // and the taskbar/pinned icon (exe resource) then both come from the same
  // deepseek.ico, matching the desktop shortcut.
  const builderCli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js')
  if (!fs.existsSync(builderCli)) {
    throw new Error('electron-builder not installed. Run: npm install --prefix desktop')
  }
  execFileSync(process.execPath, [
    builderCli,
    '--win', 'dir',
    '--config', 'electron-builder.config.cjs',
  ], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR
        ?? 'https://npmmirror.com/mirrors/electron-builder-binaries/',
    },
  })

  // 4. Copy the builder output to the canonical app folder (win-unpacked is
  // electron-builder's intermediate location; dist/DeepSeek Harness is the
  // stable path the desktop shortcut points at).
  const unpacked = path.join(DIST, 'installer', 'win-unpacked')
  rmrf(APP_DIR)
  copy(unpacked, APP_DIR)

  // 4b. The server runtime closure. Copied here rather than via electron-
  // builder's extraResources: that mechanism skips node_modules trees, so
  // the 246MB runtime closure would silently vanish from the build.
  copy(runtimeNodeModules, path.join(APP_DIR, 'resources', 'runtime', 'node_modules'))

  // 5. Keep the icon next to the exe for the desktop shortcut's IconLocation.
  copy(icon, path.join(APP_DIR, 'deepseek.ico'))

  console.log(`Built ${APP_DIR}`)
  console.log(`Double-click ${path.join(APP_DIR, `${APP_NAME}.exe`)} to launch.`)
}

main()
