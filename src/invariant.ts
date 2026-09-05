/**
 * Package-owned invariant companion for `@firefly0621/dsh-always-apply`.
 * @module @firefly0621/dsh-always-apply/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@firefly0621/dsh-always-apply'

/** Cordis companion plugin name. */
export const name = 'rules-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package listens on `system-prompt/assemble` and
 * derives injection from on-disk `.mdc` rules; it owns no durable relation to
 * check beyond that consumer behavior.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
