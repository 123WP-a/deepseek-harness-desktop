/**
 * Read typed values from the harness settings document ($DSH_HOME/settings.yaml)
 * for desktop-shell decisions that mirror user preferences (theme, close
 * behavior). Reads only; the server owns the file through its settings
 * provider. YAML parsing falls back to the default when unavailable.
 */

const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { resolveYaml } = require('./yaml-loader.js')

function resolveDshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh')
}

/** @returns {string} absolute settings document path. */
function settingsPath() {
  return path.join(resolveDshHome(), 'settings.yaml')
}

/**
 * Read one setting by dotted keys, falling back on any failure.
 * @param {string[]} keys
 * @param {unknown} fallback
 * @returns {unknown}
 */
function readSetting(keys, fallback) {
  const yamlLib = resolveYaml()
  if (yamlLib === null) return fallback
  try {
    const doc = yamlLib.load(fs.readFileSync(settingsPath(), 'utf8'))
    let current = doc
    for (const key of keys) {
      if (current === null || typeof current !== 'object') return fallback
      current = current[key]
    }
    return current === undefined ? fallback : current
  } catch {
    return fallback
  }
}

module.exports = { resolveDshHome, settingsPath, readSetting }
