/** Read-only tool-call audit trail registered into Web Plugins settings. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { en, zh } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.toolAudit'

/** Services required for the Settings registration. */
export const inject = ['slots', 'locale']

/** Contribute the audit tab to the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-tool-audit: dictionaries')

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.toolAudit',
    id: 'audit',
    order: 30,
    label: () => '审计日志',
    locale: NS,
    inject: () => ({}),
    // TODO(W3): render audit records fetched from /api/tool-audit/query
  }, PlaceholderAuditPanel))
}

/** Placeholder until the full table component is implemented. */
function PlaceholderAuditPanel(): null { return null }
