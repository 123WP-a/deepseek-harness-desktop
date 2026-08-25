/** Package-owned invariant companion. @module @deepseek-ai/dsh-client-ui-tool-audit/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-tool-audit'

/** Cordis companion plugin name. */
export const name = 'client-ui-tool-audit-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: read-only Settings contribution with no owned events. */
const install: InvariantInstaller = () => {}

/** Register this package invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
