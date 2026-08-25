/**
 * Tool consumer wrapping {@link scanPackageDir}: registers the
 * `plugin_security_scan` model-invocable utility on `ctx.tools` and mirrors
 * high-risk verdicts onto the desktop-event channel as OS notifications.
 * @module @deepseek-ai/dsh-web-app/security-scan
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { scanPackageDir } from './security-scan-core.ts'

export * from './security-scan-core.ts'

/** Loader row identity for the tool plugin half. */
export const name = 'tool-security-scan'
export const inject = ['tools']

/**
 * Register the `plugin_security_scan` tool on `ctx.tools`: a model-invocable
 * utility that statically checks an unpacked plugin directory and reports a
 * verdict. A high-risk result is mirrored onto the desktop-event channel so
 * the desktop shell raises an OS notification.
 * @param ctx - registrant context carrying the tool registry.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'plugin_security_scan',
    description: 'Statically scan an unpacked plugin package directory before installing it:'
      + ' flags executables/binaries, obfuscation density, credential-access combined with outbound'
      + ' network usage, shipped .env files, and key-shaped literals; returns a rolled-up verdict'
      + ' (clean | warning | high) with per-finding details. Local directories only.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Absolute directory of the unpacked plugin package to scan.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          verdict: { type: 'string', required: true, enum: ['clean', 'warning', 'high'] },
          findingCount: { type: 'integer', required: true },
          filesScanned: { type: 'integer', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    execute(args) {
      const log: string[] = []
      const report = scanPackageDir(args.path, log)
      if (report.verdict === 'high') {
        console.log(`dsh desktop-event: ${JSON.stringify({ type: 'scan', title: 'Plugin security scan: HIGH RISK', body: report.rootDir })}`)
      }
      const lines = log.map(line => `note: ${line}`)
      const byKind = new Map<string, number>()
      for (const f of report.findings) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1)
      lines.push(`verdict: ${report.verdict} (${report.filesScanned} files scanned)`)
      for (const [kind, count] of byKind) lines.push(`${kind}: ${count}`)
      for (const f of report.findings) lines.push(`[${f.level}] ${f.kind}${f.file ? ' @ ' + f.file : ''} - ${f.detail}`)
      if (report.dependencies.length > 0) lines.push(`dependencies (${report.dependencies.length}): ${report.dependencies.join(', ')}`)
      return Promise.resolve({
        verdict: report.verdict,
        findingCount: report.findings.length,
        filesScanned: report.filesScanned,
        summary: lines.join('\n'),
      })
    },
  }))
}
