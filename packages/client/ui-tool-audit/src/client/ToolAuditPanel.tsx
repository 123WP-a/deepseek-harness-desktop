import { useEffect, useState } from 'react'

/** One audit record as returned by the query endpoint. */
export interface AuditRecord {
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

/** Injected fetch function; the apply closure provides it. */
export type ToolAuditQuery = (params: string) => Promise<{ ok: boolean; count: number; events: AuditRecord[] }>

/** Inject face for the audit panel. */
export interface ToolAuditPanelInjected {
  query: ToolAuditQuery
}

/**
 * Read-only audit trail panel: filterable table of recent tool calls.
 * @param props - the four standard slot shares (only inject is used).
 */
export function ToolAuditPanel(props: ToolAuditPanelInjected & { t: (key: string) => string }): React.ReactElement {
  const [records, setRecords] = useState<AuditRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [failedOnly, setFailedOnly] = useState(false)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const params = new URLSearchParams()
    if (failedOnly) params.set('failed', '1')
    params.set('limit', '200')
    props.query(params.toString())
      .then((data) => { if (!cancelled) setRecords(data.events ?? []) })
      .catch((err) => { if (!cancelled) setError(String(err)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [failedOnly])

  if (loading) return <div>{props.t('loading')}</div>
  if (error) return <div>{error}</div>

  return (
    <table>
      <thead><tr><th>{'Time'}</th><th>{'Tool'}</th><th>{'Status'}</th></tr></thead>
      <tbody>
        {records.map((r, i) => (
          <tr key={i}>
            <td>{new Date(r.ts).toLocaleString()}</td>
            <td>{r.tool ?? r.phase}</td>
            <td>{r.ok === false ? '✗' : r.phase === 'result' ? '✓' : '…'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
