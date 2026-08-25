/** Audit panel copy. */
export const en = {
  tab: 'Audit',
  empty: 'No audit records.',
  error: 'Failed to load audit data',
} as const

export const zh = {
  tab: '审计日志',
  empty: '暂无审计记录。',
  error: '加载审计数据失败',
} as const

export type ToolAuditLocaleKey = keyof typeof en
