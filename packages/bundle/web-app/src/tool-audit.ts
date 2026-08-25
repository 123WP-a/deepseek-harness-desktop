// Tool-call audit trail: filesystem sink + live writer + HTTP query endpoint.
// Pure building/parsing/filtering lives in tool-audit-core.ts.
//
// Privacy by design: arguments and result content are NEVER written — only
// tool name, status, pairing ids, and timestamps.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import {
  auditLineFor,
  parseAuditLine,
  filterAuditEvents,
} from './tool-audit-core.ts'
import type { AuditEvent, AuditEventFilter } from './tool-audit-core.ts'

export * from './tool-audit-core.ts'

/** Loader row identity. */
export const name = 'tool-audit'
export const inject = ['webServer']

/** Audit sink path: $DSH_HOME/audit/tool-calls.jsonl. */
export function auditFilePath(): string {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh')
  return path.join(home, 'audit', 'tool-calls.jsonl')
}

/** Append one line, creating the audit directory on demand. Best-effort. */
function appendAudit(line: string): void {
  const file = auditFilePath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, line + '\n')
  } catch { /* audit is best-effort: never break the session stream */ }
}

/**
 * Read the newest audit events matching an optional filter.
 * @param filter - see {@link filterAuditEvents}.
 * @returns parsed events, newest first, at most filter.limit entries.
 */
export function readRecentAuditEvents(filter: AuditEventFilter = {}): AuditEvent[] {
  const file = auditFilePath()
  if (!fs.existsSync(file)) return []
  const text = fs.readFileSync(file, 'utf8')
  const events: AuditEvent[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const parsed = parseAuditLine(line)
    if (parsed !== null) events.push(parsed)
  }
  return filterAuditEvents(events, filter)
}

/**
 * Wire the audit trail: persist tool-call lifecycle lines and expose a
 * read-only JSON query endpoint for the W3 display surface.
 * @param ctx - Cordis context with the session stream and web server mounted.
 */
export function apply(ctx: Context): void {
  ctx.on('session/event', (session, event) => {
    const maybeId = (session as { id?: unknown }).id
    const sessionId = typeof maybeId === 'string' ? maybeId : 'unknown'
    const line = auditLineFor(event as never, sessionId)
    if (line !== null) appendAudit(line)
  }, { global: true })

  // Read-only JSON endpoint backing the audit panel:
  //   GET /api/tool-audit/query?tool=<substr>&failed=1&since=<iso>&limit=<n>
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/tool-audit/query',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const filter: AuditEventFilter = {}
      const toolParam = url.searchParams.get('tool')
      if (toolParam !== null && toolParam !== '') filter.tool = toolParam
      if (url.searchParams.get('failed') === '1') filter.failed = true
      const sinceParam = url.searchParams.get('since')
      if (sinceParam !== null && sinceParam !== '') filter.since = sinceParam
      const limitParam = url.searchParams.get('limit')
      if (limitParam !== null && limitParam !== '' && !Number.isNaN(Number(limitParam))) filter.limit = Number(limitParam)
      const events = readRecentAuditEvents(filter)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, count: events.length, events }))
    },
  }), 'tool-audit-query route')
}
