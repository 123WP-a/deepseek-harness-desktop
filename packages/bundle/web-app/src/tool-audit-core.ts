// Tool-call audit trail core: pure event building, parsing, and filtering.
// No filesystem access here — the IO half lives in tool-audit.ts so this
// module stays independently testable and dependency-free.

/** One parsed tool-call audit record. */
export interface AuditEvent {
  ts: string
  sessionId: string
  phase: 'call' | 'result'
  callId?: string
  tool?: string
  turn?: number
  step?: number
  ok?: boolean
  error?: string | null
}

/** Structural input accepted by {@link auditLineFor} (avoids importing session types). */
export interface SessionEventLike {
  type: string
  data: {
    turn?: number
    step?: number
    callId?: string
    name?: string
    error?: { name: string; code: string }
  }
}

/** Filters accepted by {@link filterAuditEvents}. */
export interface AuditEventFilter {
  /** Substring match (case-insensitive) against the tool name. */
  tool?: string
  /** true = only failed results; omit = all. */
  failed?: boolean
  /** Only events whose ISO timestamp is >= this value. */
  since?: string
  /** Maximum number of events returned (newest first). Default 200, cap 1000. */
  limit?: number
}

/**
 * Build one JSONL audit line for a tool session event, or null for others.
 * Arguments and result content are intentionally never included.
 * @param event - a session event from the live stream.
 * @param sessionId - identifier of the owning session.
 * @returns the JSONL line, or null for non-tool events.
 */
export function auditLineFor(event: SessionEventLike, sessionId: string): string | null {
  const ts = new Date().toISOString()
  if (event.type === 'tool/call') {
    return JSON.stringify({
      ts,
      sessionId,
      phase: 'call',
      callId: event.data.callId,
      tool: event.data.name,
      turn: event.data.turn,
      step: event.data.step,
    })
  }
  if (event.type === 'tool/result') {
    const ok = !event.data.error
    return JSON.stringify({
      ts,
      sessionId,
      phase: 'result',
      ok,
      ...(event.data.error ? { error: event.data.error.code } : {}),
      turn: event.data.turn,
      step: event.data.step,
    })
  }
  return null
}

/**
 * Parse one JSONL audit line back into a record; null when malformed.
 * @param line - a single line from the audit file.
 * @returns the parsed record, or null.
 */
export function parseAuditLine(line: string): AuditEvent | null {
  try {
    const value = JSON.parse(line) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (typeof record.ts !== 'string' || typeof record.sessionId !== 'string') return null
    if (record.phase !== 'call' && record.phase !== 'result') return null
    const out: AuditEvent = {
      ts: record.ts as string,
      sessionId: record.sessionId as string,
      phase: record.phase as 'call' | 'result',
    }
    if (typeof record.callId === 'string') out.callId = record.callId
    if (typeof record.tool === 'string') out.tool = record.tool
    if (typeof record.turn === 'number') out.turn = record.turn
    if (typeof record.step === 'number') out.step = record.step
    if (typeof record.ok === 'boolean') out.ok = record.ok
    if (typeof record.error === 'string') out.error = record.error
    return out
  } catch {
    return null
  }
}

/**
 * Filter parsed events: optional tool substring, failure-only toggle, since
 * timestamp, then newest-first with a bounded limit (default 200, cap 1000).
 * @param events - parsed audit records (any order).
 * @param filter - the active filters.
 * @returns matching events, newest first, at most limit entries.
 */
export function filterAuditEvents(
  events: readonly AuditEvent[],
  filter: AuditEventFilter = {},
): AuditEvent[] {
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000)
  const needle = filter.tool?.toLowerCase()
  const matched = events.filter((event) => {
    if (needle !== undefined && !(event.tool ?? '').toLowerCase().includes(needle.toLowerCase())) return false
    if (filter.failed === true && event.ok !== false) return false
    if (filter.since !== undefined && event.ts < filter.since) return false
    return true
  })
  matched.sort((left, right) => (left.ts < right.ts ? 1 : left.ts > right.ts ? -1 : 0))
  return matched.slice(0, limit)
}
