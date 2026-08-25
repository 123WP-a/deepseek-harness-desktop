/**
 * Approval-notification observer for the web surface: watches the live
 * session event stream and forwards every `approval/asked` audit event as
 * one structured desktop-event line, which the desktop shell parses into OS
 * notifications (`dsh desktop-event: {json}` stdout protocol).
 *
 * The observer reads the audit stream instead of the `approval/request`
 * waterfall, so its position relative to composed answerers cannot
 * short-circuit or reorder the decision chain.
 * @module @deepseek-ai/dsh-web-app/desktop-events
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'

/** Plugin identity for Loader rows. */
export const name = 'desktop-events'

/**
 * Emit one desktop-event line for an `approval/asked` session event; other
 * events are ignored.
 * @param event - a session event from the live stream.
 */
export function applyApprovalEvent(event: SessionEvent): void {
  if (event.type !== 'approval/asked') return
  console.log(`dsh desktop-event: ${JSON.stringify({
    type: 'approval',
    title: `Approval needed: ${event.data.toolName}`,
    body: event.data.reason ?? '',
  })}`)
}

/**
 * Subscribe to the live session-event stream and forward approval asks.
 * @param ctx - Cordis context with the session seam mounted.
 */
export function apply(ctx: Context): void {
  ctx.on('session/event', (_session, event) => { applyApprovalEvent(event) }, { global: true })
}
