/**
 * Active-task observer for the web surface: mirrors "any background job is
 * running or stopping" onto the desktop-event channel as a `tasks` event, so
 * the desktop shell raises or holds its exit-confirmation guard accordingly.
 * Goals are out of scope for v1 — they carry no live server-side signal (a
 * client projection and a Remote gateway). See the bundle README limits.
 * @module @deepseek-ai/dsh-web-app/tasks-active
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-jobs'

/** Loader row identity. */
export const name = 'tasks-active'
export const inject = ['jobs']

/**
 * True when any background job is running or stopping.
 * @param snapshots - the current job registry snapshot.
 * @returns true when at least one snapshot is running or stopping.
 */
export function tasksActiveFrom(snapshots: readonly JobSnapshot[]): boolean {
  return snapshots.some(job => job.status === 'running' || job.status === 'stopping')
}

/**
 * Subscribe to job registry changes and emit a `tasks` desktop-event line
 * exactly when the active flag flips.
 * @param ctx - Cordis context with the jobs seam mounted.
 */
export function apply(ctx: Context): void {
  let active = false
  const emit = (next: boolean): void => {
    console.log(`dsh desktop-event: ${JSON.stringify({ type: 'tasks', active: next })}`)
  }
  // The inject callback receives an augmented context (jobsCtx.jobs is the
  // JobRegistry); its returned disposer is collected by the context scope and
  // run on unload (HMR-safe).
  ctx.inject(['jobs'], (jobsCtx) => {
    const reconcile = (): void => {
      const next = tasksActiveFrom(jobsCtx.jobs.list())
      if (next !== active) {
        active = next
        emit(next)
      }
    }
    reconcile()
    return jobsCtx.jobs.onJobsChanged(() => { reconcile() })
  })
}
