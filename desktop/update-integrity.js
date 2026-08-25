// Runtime integrity fingerprinting for staged dsh updates (supplier-chain
// hardening, risk R2). The update path records sha256 fingerprints of the
// installed dsh artifacts at staging time; activation verifies them before
// renaming staging into place, so a corrupted or tampered runtime (an
// interrupted npm install, manual edits inside the staging window) is
// refused rather than launched.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

/** Artifacts fingerprinted inside a runtime closure; relative to the dsh package root. */
const ARTIFACTS = ['package.json', 'lib/index.js', 'lib/bin.js']

/** Marker file written beside COMPLETE_MARKER inside the staging dir. */
const CHECKSUM_MARKER = '.runtime-checksums.json'

/**
 * Absolute dsh package directory inside a runtime closure.
 * @param {string} runtimeRoot
 * @returns {string}
 */
function dshPackageDir(runtimeRoot) {
  return path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh')
}

/**
 * SHA-256 hex digest of one file; rejects an empty/unreadable file.
 * @param {string} absPath
 * @returns {string}
 */
function sha256File(absPath) {
  const buffer = fs.readFileSync(absPath)
  if (buffer.length === 0) throw new Error(`cannot fingerprint empty file: ${absPath}`)
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

/**
 * Compute fingerprints for the artifacts of a runtime closure.
 * @param {string} runtimeRoot
 * @returns {Record<string, string>}
 */
function computeRuntimeFingerprints(runtimeRoot) {
  const base = dshPackageDir(runtimeRoot)
  const out = {}
  for (const rel of ARTIFACTS) out[rel] = sha256File(path.join(base, rel))
  return out
}

/**
 * Record fingerprints from a freshly installed runtime into the staging dir.
 * @param {string} runtimeRoot
 * @param {string} stagingDir
 * @returns {Record<string, string>}
 */
function recordStagedFingerprints(runtimeRoot, stagingDir) {
  const fingerprints = computeRuntimeFingerprints(runtimeRoot)
  fs.writeFileSync(path.join(stagingDir, CHECKSUM_MARKER), JSON.stringify(fingerprints, null, 2) + '\n')
  return fingerprints
}

/**
 * Verify a staged runtime against its recorded fingerprints.
 * @param {string} runtimeRoot
 * @param {string} stagingDir
 * @returns {{ok: boolean, reason?: string}}
 */
function verifyStagedFingerprints(runtimeRoot, stagingDir) {
  const markerPath = path.join(stagingDir, CHECKSUM_MARKER)
  if (!fs.existsSync(markerPath)) return { ok: false, reason: 'missing checksum marker' }
  let expected
  try {
    expected = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
  } catch {
    return { ok: false, reason: 'unreadable checksum marker' }
  }
  let actual
  try {
    actual = computeRuntimeFingerprints(runtimeRoot)
  } catch (error) {
    return { ok: false, reason: String((error && error.message) || error) }
  }
  for (const rel of Object.keys(expected)) {
    if (actual[rel] !== expected[rel]) return { ok: false, reason: 'fingerprint mismatch on ' + rel }
  }
  return { ok: true, fingerprints: actual }
}

module.exports = { sha256File, computeRuntimeFingerprints, recordStagedFingerprints, verifyStagedFingerprints }
