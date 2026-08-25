// Appearance sync: keep the Electron window's native theme (title bar, frame,
// scrollbars, prefers-color-scheme) in lockstep with the Web UI's Appearance
// setting, which the harness persists at $DSH_HOME/settings.yaml under
// `ui-theme.preference` ('light' | 'dark' | 'system').
//
// The server child (dsh web) owns that file through its settings provider; we
// only READ it and watch for external edits, so a change made in the Web UI's
// settings page applies to the window immediately.
//
// Requires js-yaml: available inside the bundled runtime closure (and in the
// dev layout's node_modules). Falls back to 'system' when the file, section,
// or parser is unavailable.

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { nativeTheme } = require('electron')

let yaml = null

/**
 * Resolve js-yaml from the same closures the server uses: the bundled runtime
 * (resources/runtime when packaged, desktop/runtime in dev), then this dev
 * layout's own node_modules. A missing parser is not fatal — callers fall
 * back to their defaults.
 * @returns {object|null} the js-yaml module, or null when unavailable.
 */
function resolveYaml() {
  if (yaml !== null) return yaml
  try {
    const runtimeModules = require('electron').app.isPackaged
      ? path.join(require('electron').app.getAppPath(), '..', 'runtime', 'node_modules')
      : path.join(__dirname, 'runtime', 'node_modules')
    yaml = require(require.resolve('js-yaml', { paths: [runtimeModules, path.join(__dirname, 'node_modules')] }))
  } catch {
    yaml = null
  }
  return yaml
}

/** The harness home the settings document lives in (mirrors the server's default). */
function settingsPath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh')
  return path.join(home, 'settings.yaml')
}

/** Read `ui-theme.preference` from the settings document; defaults to 'system'. */
function readPreference() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8')
    if (yaml === null) return 'system'
    const doc = yaml.load(raw)
    const preference = doc && typeof doc === 'object' ? doc['ui-theme']?.['preference'] : undefined
    return preference === 'light' || preference === 'dark' || preference === 'system' ? preference : 'system'
  } catch {
    return 'system' // missing file, unreadable, or invalid YAML — keep the OS default
  }
}

let lastApplied = null

/** Apply the persisted preference to Electron's native theme (idempotent). */
function applyPreference() {
  const preference = readPreference()
  if (preference === lastApplied) return
  lastApplied = preference
  try {
    nativeTheme.themeSource = preference
  } catch {
    // nativeTheme may not be ready before app ready in some versions; the
    // initial apply is also issued from app.whenReady, so this is defensive.
  }
}

let watcher = null

/**
 * Start syncing the window theme with the settings document.
 *
 * The server's settings provider rewrites the file atomically (write-temp +
 * rename), so a watch on the file itself misses the replacement on Windows.
 * Watch the containing directory instead and filter by basename: directory
 * watches deliver both the rename and the follow-up change events.
 * @returns a disposer that stops watching.
 */
function startAppearanceSync() {
  applyPreference()
  const file = settingsPath()
  try {
    watcher = fs.watch(path.dirname(file), (_event, filename) => {
      if (filename !== null && path.basename(String(filename)) === path.basename(file)) {
        applyPreference()
      }
    })
  } catch {
    // Directory absent or watch unsupported (e.g. network home): the polling
    // fallback below still keeps the window in sync.
  }
  // Belt and braces: poll every 2s so a missed watch event (or a home on a
  // filesystem without reliable directory events) never leaves the window
  // theme stale. Idempotent apply makes the cost negligible.
  const poll = setInterval(applyPreference, 2000)
  return () => {
    clearInterval(poll)
    if (watcher !== null) {
      try { watcher.close() } catch { /* already closed */ }
      watcher = null
    }
  }
}

module.exports = { startAppearanceSync, applyPreference, resolveYaml }
