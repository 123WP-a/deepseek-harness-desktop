const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { sha256File, computeRuntimeFingerprints, recordStagedFingerprints, verifyStagedFingerprints } = require('../update-integrity.js')

function makeStaged() {
  const dir = path.join(os.tmpdir(), 'dsh-uichk-' + Date.now() + '-' + Math.random().toString(36).slice(2))
  const pkg = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0' }))
  fs.writeFileSync(path.join(pkg, 'lib', 'index.js'), 'export const one = 1\n')
  fs.writeFileSync(path.join(pkg, 'lib', 'bin.js'), 'console.log("bin")')
  return dir
}

const staged = makeStaged()
try {
  // fingerprint determinism
  const a = sha256File(path.join(staged, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  const b = sha256File(path.join(staged, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  assert.strictEqual(a, b, 'sha256 deterministic')
  assert.match(a, /^[0-9a-f]{64}$/, 'hex length')

  // record then verify ok
  const fps = recordStagedFingerprints(staged, staged)
  assert.ok(Object.keys(fps).length === 3, 'three fingerprints')
  assert.strictEqual(verifyStagedFingerprints(staged, staged).ok, true, 'verify ok after record')

  // tamper -> mismatch
  fs.appendFileSync(path.join(staged, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '//tamper')
  const tampered = verifyStagedFingerprints(staged, staged)
  assert.strictEqual(tampered.ok, false, 'tamper detected')
  assert.ok(tampered.reason.includes('mismatch'), 'reason mentions mismatch')

  // missing marker
  fs.rmSync(path.join(staged, '.runtime-checksums.json'), { force: true })
  assert.strictEqual(verifyStagedFingerprints(staged, staged).ok, false, 'missing marker fails closed')
  assert.strictEqual(verifyStagedFingerprints(staged, staged).reason, 'missing checksum marker')
  console.log('update-integrity tests: PASS')
} finally {
  fs.rmSync(staged, { recursive: true, force: true })
}
