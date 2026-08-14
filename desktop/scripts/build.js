// DeepSeek Harness desktop build — assembles a self-contained app folder.
//
// Layout produced under desktop/dist/DeepSeek Harness/:
//   DeepSeek Harness.exe        renamed Electron binary (double-click to launch)
//   resources/app/              this shell: main.js + package.json
//   resources/runtime/          the dsh server runtime closure (npm-installed)
//
// The app folder is self-contained: the exe embeds the Electron runtime, and
// the server closure ships inside resources/runtime. Nothing else needs to be
// installed on the target machine.

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
  // 1. Electron binary distribution (already downloaded by npm postinstall).
  const electronDist = path.join(ROOT, 'node_modules', 'electron', 'dist')
  if (!fs.existsSync(path.join(electronDist, 'electron.exe'))) {
    throw new Error(
      'Electron distribution not found. Run: npm install --prefix desktop',
    )
  }

  // 2. The dsh server runtime closure (npm-installed @deepseek-ai/dsh + deps).
  const runtimeNodeModules = path.join(ROOT, 'runtime', 'node_modules')
  if (!fs.existsSync(path.join(runtimeNodeModules, '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
    throw new Error(
      'Server runtime closure not found. Run: node scripts/prepare-runtime.js',
    )
  }

  rmrf(APP_DIR)
  fs.mkdirSync(path.join(APP_DIR, 'resources', 'app'), { recursive: true })

  // 3. The renamed executable — the click target.
  copy(electronDist, APP_DIR)
  fs.renameSync(
    path.join(APP_DIR, 'electron.exe'),
    path.join(APP_DIR, `${APP_NAME}.exe`),
  )

  // 4. This shell (main.js + package.json) as the packaged app entry.
  copy(path.join(ROOT, 'main.js'), path.join(APP_DIR, 'resources', 'app', 'main.js'))
  copy(path.join(ROOT, 'appearance.js'), path.join(APP_DIR, 'resources', 'app', 'appearance.js'))
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const appManifest = {
    name: manifest.name,
    version: manifest.version,
    main: 'main.js',
    private: true,
  }
  fs.writeFileSync(
    path.join(APP_DIR, 'resources', 'app', 'package.json'),
    JSON.stringify(appManifest, null, 2) + '\n',
  )

  // 4b. The official black DeepSeek Harness icon, next to the exe for the
  // desktop shortcut (IconLocation) and for the window icon.
  const icon = path.join(ROOT, 'assets', 'deepseek.ico')
  if (fs.existsSync(icon)) {
    copy(icon, path.join(APP_DIR, 'deepseek.ico'))
  } else {
    console.warn('deepseek.ico not found; run: node scripts/make-icon.js (needs sharp)')
  }

  // 5. The server runtime closure.
  copy(runtimeNodeModules, path.join(APP_DIR, 'resources', 'runtime', 'node_modules'))

  console.log(`Built ${APP_DIR}`)
  console.log(`Double-click ${path.join(APP_DIR, `${APP_NAME}.exe`)} to launch.`)
}

main()
