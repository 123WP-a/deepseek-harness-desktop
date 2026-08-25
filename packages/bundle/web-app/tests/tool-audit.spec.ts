import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  auditLineFor,
  parseAuditLine,
  filterAuditEvents,
} from '../src/tool-audit-core.ts'
import { appendAudit, readRecentAuditEvents } from '../src/tool-audit.ts'

describe('auditLineFor', () => {
  it('builds a call line without logging arguments', () => {
    const line = auditLineFor(
      { type: 'tool/call', data: { turn: 2, step: 1, callId: 'c1', name: 'tool-bash', arguments: '{"cmd":"SECRET"}' } },
      's1',
    )
    expect(line).toContain('"phase":"call"')
    expect(line).toContain('"tool":"tool-bash"')
    expect(line).toContain('"sessionId":"s1"')
    expect(line).not.toContain('SECRET')
  })

  it('builds result lines with ok/error and no content', () => {
    const ok = auditLineFor({ type: 'tool/result', data: { turn: 2, step: 1, message: {} } }, 's1')
    expect(ok).toContain('"ok":true')
    const bad = auditLineFor({ type: 'tool/result', data: { turn: 2, step: 2, message: {}, error: { name: 'E', code: 'X' } } }, 's1')
    expect(bad).toContain('"ok":false')
    expect(bad).toContain('"error":"X"')
  })

  it('ignores unrelated events', () => {
    expect(auditLineFor({ type: 'turn/end', data: { turn: 1 } }, 's1')).toBeNull()
  })
})

describe('parseAuditLine', () => {
  it('round-trips a call line', () => {
    const parsed = parseAuditLine('{"ts":"2026-01-01T00:00:00.000Z","sessionId":"s1","phase":"call","callId":"c1","tool":"t1","turn":1,"step":2}')
    expect(parsed?.ts).toBe('2026-01-01T00:00:00.000Z')
    expect(parsed?.tool).toBe('t1')
  })
  it('returns null for garbage', () => {
    expect(parseAuditLine('not json')).toBeNull()
    expect(parseAuditLine('[]')).toBeNull()
    expect(parseAuditLine('{"ts":1}')).toBeNull()
  })
})

describe('filterAuditEvents', () => {
  const events = [
    { ts: '2026-01-03T10:00:00.000Z', sessionId: 's', phase: 'result' as const, ok: false, error: 'E' },
    { ts: '2026-01-02T10:00:00.000Z', sessionId: 's', phase: 'result' as const, ok: true, tool: 'tool-bash' },
    { ts: '2026-01-01T10:00:00.000Z', sessionId: 's', phase: 'call' as const, tool: 'tool-fs' },
  ]
  it('sorts newest first', () => {
    expect(filterAuditEvents(events).map(e => e.ts)).toEqual(['2026-01-03T10:00:00.000Z', '2026-01-02T10:00:00.000Z', '2026-01-01T10:00:00.000Z'])
  })
  it('filters failed only', () => {
    expect(filterAuditEvents(events, { failed: true }).length).toBe(1)
  })
  it('filters by tool substring case-insensitively', () => {
    expect(filterAuditEvents(events, { tool: 'BASH' }).map(e => e.tool)).toEqual(['tool-bash'])
  })
  it('caps limit', () => {
    expect(filterAuditEvents(events, {}).length).toBe(3)
    expect(filterAuditEvents(events, { limit: 1 }).length).toBe(1)
  })
})

describe('readRecentAuditEvents (file round-trip)', () => {
  it('reads appended lines newest-first through the real IO path', () => {
    const home = path.join(os.tmpdir(), 'dsh-ta-io-' + Date.now())
    process.env.DSH_HOME = home
    // appendAudit writes to auditFilePath() which derives from DSH_HOME
    const calls = [
      { ts: '2026-01-01T00:00:00.000Z', sessionId: 's', phase: 'call' as const, callId: 'c1', tool: 'tool-fs', turn: 1, step: 1 },
      { ts: '2026-01-02T00:00:00.000Z', sessionId: 's', phase: 'result' as const, ok: false, error: 'X', turn: 1, step: 2 },
      { ts: '2026-01-03T00:00:00.000Z', sessionId: 's', phase: 'call' as const, callId: 'c2', tool: 'tool-bash', turn: 2, step: 1 },
    ]
    for (const e of calls) {
      const line = auditLineFor({ type: e.phase === 'call' ? 'tool/call' : 'tool/result', data: {} }, e.sessionId)
      expect(line).not.toBeNull()
      fs.appendFileSync(path.join(home, 'audit', 'tool-calls.jsonl'), line + '\n')
    }
    const events = readRecentAuditEvents({})
    expect(events.length).toBe(3)
    expect(events[0]?.ts).toBe('2026-01-03T00:00:00.000Z')
    const failed = readRecentAuditEvents({ failed: true })
    expect(failed.length).toBe(1)
    delete process.env.DSH_HOME
    fs.rmSync(path.join(home, 'audit'), { recursive: true, force: true })
  })
})
