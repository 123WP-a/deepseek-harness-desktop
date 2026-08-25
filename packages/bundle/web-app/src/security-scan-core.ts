/**
 * Security pre-install scanning for third-party plugin packages: static
 * checks over an unpacked package directory (executables, obfuscation
 * density, credential-access + outbound-network combos, env/key files)
 * with a rolled-up verdict. v1 scans LOCAL directories only; npm/git
 * fetching and registry dependency audit are deferred (see the bundle
 * README limitations).
 * @module @deepseek-ai/dsh-web-app/security-scan-core
 */

import fs from 'node:fs'
import path from 'node:path'

/** Finding severity levels, ordered by escalation. */
export type FindingLevel = 'warn' | 'high'

/** One scan finding. */
export interface ScanFinding {
  level: FindingLevel
  kind: 'executable' | 'obfuscation' | 'secret-outbound' | 'env-file' | 'hardcoded-key'
  file?: string
  detail: string
}

/** Rolled-up scan report for one package directory. */
export interface ScanReport {
  rootDir: string
  filesScanned: number
  verdict: 'clean' | 'warning' | 'high'
  findings: ScanFinding[]
  dependencies: string[]
}

/** Extensions considered scripts for content scans. */
const SCRIPT_EXTS = new Set(['.js', '.cjs', '.mjs'])
/** Extensions treated as executables/binaries worth flagging. */
const EXECUTABLE_EXTS = new Set(['.exe', '.dll', '.bat', '.cmd', '.ps1', '.msi', '.apk', '.jar', '.bin', '.node'])
/** Directories never descended into. */
const SKIP_DIRS = new Set(['node_modules', '.git'])
/** Byte ceiling per content-scanned file; larger files are truncated for scanning. */
const MAX_SCAN_BYTES = 512 * 1024
/** File-count ceiling; runaway trees stop collecting further files. */
const MAX_FILES = 5000
/** Obfuscation indicators counted per script file. */
const OBFUSCATION_PATTERNS: RegExp[] = [
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
  /\batob\s*\(/,
  /Buffer\.from\([^)]*'base64'/,
]
/** Credential-access indicator. */
const CREDENTIAL_PATTERN = /(DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|API[_-]?KEY|\.credentials)/i
/** Outbound-network indicator. */
const OUTBOUND_PATTERN = /(fetch\s*\(|axios|XMLHttpRequest|https?:\/\/|net\.connect|http\.request)/i
/** Key-shaped literal, best effort. */
const KEY_LITERAL_PATTERN = /sk-[A-Za-z0-9]{16,}|[A-Fa-f0-9]{40,}/
/** A script file is flagged when its obfuscation hits reach this count. */
const OBFUSCATION_FLAG_COUNT = 3

/** Collect candidate files under rootDir, bounded and skip-list aware. */
function collectFiles(rootDir: string, log: string[]): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    if (files.length >= MAX_FILES) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      log.push(`cannot read ${dir}: ${String(error)}`)
      return
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full)
        continue
      }
      if (entry.isFile()) files.push(full)
    }
  }
  walk(rootDir)
  return files
}

/** Read up to MAX_SCAN_BYTES of a file for pattern scans; null when unreadable. */
function readHead(file: string): string | null {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(MAX_SCAN_BYTES)
      const read = fs.readSync(fd, buf, 0, MAX_SCAN_BYTES, 0)
      return buf.toString('utf8', 0, read)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

/**
 * Statically scan one unpacked plugin package directory and roll findings
 * up into a verdict. Never throws: unreadable paths become logged warnings.
 * @param rootDir - absolute directory of the unpacked package.
 * @param log - sink for operational warnings (unreadable paths, etc.).
 * @returns the rolled-up scan report for the directory.
 */
export function scanPackageDir(rootDir: string, log: string[] = []): ScanReport {
  const findings: ScanFinding[] = []
  let dependencies: string[] = []
  try {
    const raw = fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')
    const manifest = JSON.parse(raw) as Record<string, unknown> | null
    const declared = manifest !== null && typeof manifest === 'object' ? manifest.dependencies : undefined
    if (declared !== null && typeof declared === 'object') dependencies = Object.keys(declared)
  } catch { /* manifest optional for the scan itself */ }
  const files = collectFiles(rootDir, log)
  for (const file of files) {
    const rel = path.relative(rootDir, file)
    const ext = path.extname(file).toLowerCase()
    if (EXECUTABLE_EXTS.has(ext)) {
      findings.push({ level: ext === '.node' ? 'warn' : 'high', kind: 'executable', file: rel, detail: `executable/binary artifact (${ext})` })
    }
    if (!SCRIPT_EXTS.has(ext)) continue
    const text = readHead(file)
    if (text === null) continue
    let obfuscationHits = 0
    for (const pattern of OBFUSCATION_PATTERNS) {
      const matches = text.match(new RegExp(pattern.source, 'g'))
      if (matches !== null) obfuscationHits += matches.length
    }
    if (obfuscationHits >= OBFUSCATION_FLAG_COUNT) {
      findings.push({ level: 'high', kind: 'obfuscation', file: rel, detail: `obfuscation indicators x${obfuscationHits}` })
    }
    const hasCredential = CREDENTIAL_PATTERN.test(text)
    const hasOutbound = OUTBOUND_PATTERN.test(text)
    if (hasCredential && hasOutbound) {
      findings.push({ level: 'high', kind: 'secret-outbound', file: rel, detail: 'credential access combined with outbound network usage' })
    }
    if (KEY_LITERAL_PATTERN.test(text)) {
      findings.push({ level: 'warn', kind: 'hardcoded-key', file: rel, detail: 'key-shaped literal present' })
    }
  }
  for (const file of files) {
    if (path.basename(file) === '.env') {
      findings.push({ level: 'warn', kind: 'env-file', file: path.relative(rootDir, file), detail: '.env file shipped inside the package' })
    }
  }
  const verdict = findings.some(f => f.level === 'high') ? 'high' : findings.length > 0 ? 'warning' : 'clean'
  return { rootDir, filesScanned: files.length, verdict, findings, dependencies }
}

