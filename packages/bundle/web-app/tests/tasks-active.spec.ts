import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, tasksActiveFrom } from '../src/tasks-active.ts'

describe('tasks-active', () => {
  it('computes active from running/stopping snapshots', () => {
    expect(tasksActiveFrom([])).toBe(false)
    expect(tasksActiveFrom([{ status: 'completed' }, { status: 'failed' }] as never)).toBe(false)
    expect(tasksActiveFrom([{ status: 'running' }] as never)).toBe(true)
    expect(tasksActiveFrom([{ status: 'stopping' }] as never)).toBe(true)
  })

  it('emits a tasks desktop-event line only when the flag flips', () => {
    const log: string[] = []
    const orig = console.log
    console.log = (...a) => log.push(a.join(' '))
    try {
      let snapshots: { status: string }[] = []
      let onChange: (() => void) | null = null
      const off = () => {}
      const fakeJobs = { list: () => snapshots, onJobsChanged: (l: () => void) => { onChange = l; return off } }
      const fakeCtx = { inject: (_deps: string[], cb: (_aug: { jobs: unknown }) => void): void => { cb({ jobs: fakeJobs }) } }
      apply(fakeCtx as unknown as Context)
      expect(log).toEqual([])
      snapshots = [{ status: 'running' }]
      onChange!()
      expect(log).toHaveLength(1)
      expect(log[0]).toContain('{"type":"tasks","active":true}')
      onChange!() // no flip: unchanged
      expect(log).toHaveLength(1)
      snapshots = []
      onChange!()
      expect(log).toHaveLength(2)
      expect(log[1]).toContain('"active":false')
    } finally {
      console.log = orig
    }
  })
})
