import { describe, expect, it, vi } from 'vitest'
import { applyApprovalEvent } from '../src/desktop-events.ts'

describe('desktop-events', () => {
  it('emits one desktop-event line per approval/asked and ignores other events', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      applyApprovalEvent({ type: 'approval/asked', data: { id: 'a1', toolName: 'tool-bash', reason: 'needs shell' } } as never)
      applyApprovalEvent({ type: 'turn/end', data: { turn: 1 } } as never)
      expect(log).toHaveBeenCalledTimes(1)
      const line = log.mock.calls[0]?.[0] as string
      expect(line).toContain('dsh desktop-event: ')
      expect(line).toContain('Approval needed: tool-bash')
      expect(line).toContain('needs shell')
    } finally {
      log.mockRestore()
    }
  })
})
