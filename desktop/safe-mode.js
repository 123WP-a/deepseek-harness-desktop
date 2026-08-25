// Safe-mode helpers: enumerate configured plugin entry ids from every
// profile bundle layer plus the profile user patch, then disable everything
// the installation-owned bundles do not define (allowlist). The `web`
// subcommand rejects launcher-level --patch, so safe mode applies the disable
// rows by temporarily extending the profile's own cordis.patch.yml (backup +
// restore), which the Loader always applies.

const fs = require('node:fs')
const path = require('node:path')
const { resolveYaml } = require('./yaml-loader.js')

/** Official bundles whose patch layers define non-disableable core entries. */
const OFFICIAL_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/** Backup of the user patch layer, written before a safe-mode launch. */
const SAFE_MODE_BACKUP_SUFFIX = '.safe-backup'

/**
 * A js-yaml schema accepting the server `!!js` tag WITHOUT evaluating it.
 * Safe mode needs entry ids, never config values, so evaluating user-patch
 * expressions here would be pointless and a hazard.
 * @param {object} yamlLib
 * @returns {object|null}
 */
function resolveYamlSchema(yamlLib) {
  try {
    const jsType = new yamlLib.Type('tag:yaml.org,2002:js', { kind: 'scalar', resolve: () => true, construct: (value) => value })
    return new yamlLib.Schema({ include: [yamlLib.DEFAULT_SCHEMA], implicit: [], explicit: [jsType] })
  } catch {
    return null
  }
}

/**
 * Collect entry ids from one parsed patch document: top-level rows plus
 * every row inside an `insert` group (the base layer shape).
 * @param {unknown} doc
 * @param {Set<string>} into
 */
function collectPatchIds(doc, into) {
  if (!Array.isArray(doc)) return
  for (const row of doc) {
    if (row === null || typeof row !== 'object') continue
    const rows = Array.isArray(row.insert) && row.insert.length > 0 ? row.insert : [row]
    for (const entry of rows) {
      if (entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && entry.id !== '') into.add(entry.id)
    }
  }
}

/**
 * Fold one patch file entry ids into `ids`; missing files are simply "no
 * layer", unparsable ones record a warning through `log`.
 * @param {string} file
 * @param {Set<string>} ids
 * @param {string[]} log
 */
function collectPatchFileIds(file, ids, log) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return
  }
  const yamlLib = resolveYaml()
  if (yamlLib === null) { log.push('safe-mode: js-yaml unavailable, cannot parse patch layers'); return }
  try {
    const schema = resolveYamlSchema(yamlLib)
    collectPatchIds(schema === null ? yamlLib.load(raw) : yamlLib.load(raw, { schema }), ids)
  } catch (error) {
    log.push(`safe-mode: failed to parse ${file}: ${String(error)}`)
  }
}

/** First existing package directory for a bundle name across the anchors. */
function findBundleDir(packageName, roots) {
  for (const dir of roots) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
  }
  return null
}

/**
 * Compute the allowlist disable rows (D1 decision): every configured entry id
 * the installation-owned bundles do not define.
 * @param {{ dshHome: string, profile: string, runtimeRoot: string, log: string[] }} opts
 * @returns {Array<{id: string, disabled: true}>} disable rows; empty when nothing to disable.
 */
function computeDisableRows(opts) {
  const { dshHome, profile, runtimeRoot, log } = opts
  const yamlLib = resolveYaml()
  if (yamlLib === null || resolveYamlSchema(yamlLib) === null) {
    log.push('safe-mode: js-yaml or its !!js schema unavailable; cannot enumerate patch layers')
    return []
  }
  const bundleRoots = (packageName) => [
    path.join(runtimeRoot, 'node_modules', packageName),
    path.join(dshHome, 'profiles', profile, 'node_modules', packageName),
    path.join(dshHome, 'profiles', 'node_modules', packageName),
  ]
  const manifestPath = path.join(dshHome, 'profiles', profile, 'package.json')
  let bundles = []
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    bundles = manifest?.dsh?.profile?.bundles ?? []
  } catch (error) {
    log.push(`safe-mode: cannot read profile manifest ${manifestPath}: ${String(error)}`)
  }
  const officialIds = new Set()
  const allIds = new Set()
  for (const packageName of bundles) {
    const dir = findBundleDir(packageName, bundleRoots(packageName))
    if (dir === null) continue
    let declared
    try {
      declared = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))?.dsh?.bundle?.patch
    } catch {
      declared = undefined
    }
    if (typeof declared !== 'string') continue
    const target = OFFICIAL_BUNDLES.includes(packageName) ? officialIds : allIds
    collectPatchFileIds(path.join(dir, declared), target, log)
  }
  collectPatchFileIds(path.join(dshHome, 'profiles', profile, 'cordis.patch.yml'), allIds, log)
  for (const id of officialIds) allIds.add(id)
  return [...allIds]
    .filter((id) => !officialIds.has(id))
    .map((id) => ({ id, disabled: true }))
}

/**
 * Build the safe-mode overlay artifact (kept for diagnostics/tests): the same
 * rows as {@link computeDisableRows}, written as a JSON document.
 * @param {{ dshHome: string, profile: string, runtimeRoot: string, overlayPath: string, log: string[] }} opts
 * @returns {string|null} the overlay file path, or null when it cannot be written.
 */
function buildSafeModeOverlay(opts) {
  const { overlayPath, log } = opts
  const rows = computeDisableRows(opts)
  try {
    fs.writeFileSync(overlayPath, JSON.stringify(rows, null, 2) + '\n')
    return overlayPath
  } catch (error) {
    log.push(`safe-mode: cannot write overlay: ${String(error)}`)
    return null
  }
}

/** Absolute path of the profile's user patch layer. */
function profilePatchPath(dshHome, profile) {
  return path.join(dshHome, 'profiles', profile, 'cordis.patch.yml')
}

/** Absolute path of the safe-mode backup of the user patch layer. */
function profilePatchBackupPath(dshHome, profile) {
  return profilePatchPath(dshHome, profile) + SAFE_MODE_BACKUP_SUFFIX
}

/**
 * Apply safe mode for one launch: back up the profile's cordis.patch.yml and
 * append the allowlist disable rows. Idempotent: when a backup already
 * exists, the previous safe-mode application is still in place and nothing
 * changes.
 * @param {{ dshHome: string, profile: string, runtimeRoot: string, log: string[] }} opts
 * @returns {boolean} true when a safe-mode patch is in place (nothing to
 *   disable also returns false — there is nothing safe mode would change).
 */
function applyProfileSafeMode(opts) {
  const { dshHome, profile, log } = opts
  const patch = profilePatchPath(dshHome, profile)
  const backup = profilePatchBackupPath(dshHome, profile)
  if (fs.existsSync(backup)) return true
  const rows = computeDisableRows(opts)
  if (rows.length === 0) {
    log.push('safe-mode: nothing to disable; launching normally')
    return false
  }
  let current = ''
  try {
    current = fs.readFileSync(patch, 'utf8')
  } catch (error) {
    log.push(`safe-mode: cannot read ${patch}: ${String(error)}`)
    return false
  }
  const rowsText = rows.map((row) => `- id: ${row.id}\n  disabled: true`).join('\n') + '\n'
  const appended = current + (current.endsWith('\n') ? '' : '\n') + rowsText
  try {
    fs.writeFileSync(backup, current)
    fs.writeFileSync(patch, appended)
    log.push(`safe-mode: disabled ${rows.length} third-party entries for this launch`)
    return true
  } catch (error) {
    log.push(`safe-mode: cannot write safe-mode patch: ${String(error)}`)
    try { fs.rmSync(backup, { force: true }) } catch { /* best effort */ }
    return false
  }
}

/**
 * Restore the user patch layer after a safe-mode launch opened its window.
 * No-op when no backup exists (normal launch).
 * @param {{ dshHome: string, profile: string }} opts
 * @returns {boolean} true when a backup was restored.
 */
function restoreProfileSafeMode(opts) {
  const { dshHome, profile } = opts
  const patch = profilePatchPath(dshHome, profile)
  const backup = profilePatchBackupPath(dshHome, profile)
  if (!fs.existsSync(backup)) return false
  try {
    fs.renameSync(backup, patch)
    return true
  } catch {
    return false
  }
}

module.exports = {
  buildSafeModeOverlay, computeDisableRows, collectPatchIds, resolveYamlSchema,
  applyProfileSafeMode, restoreProfileSafeMode, profilePatchPath, profilePatchBackupPath,
}
