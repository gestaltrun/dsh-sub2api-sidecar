/**
 * `dsh-sub2api-sidecar` — the DeepSeek Harness bundle that supervises a local
 * Sub2API sidecar and bootstraps its dual credentials.
 *
 * The function plugin mounts with `inject: ['subprocess', 'credentials',
 * 'settings']`, resolves the entry config once, and — when enabled — starts
 * the whole chain inside one effect whose disposer stops it again: portable
 * PostgreSQL (initdb once, pg_ctl start/stop), the pack's redis-server (or a
 * configured skip/external endpoint), the pinned sub2api binary in
 * `RUN_MODE=simple` bound to 127.0.0.1, the `/health` poll, the idempotent
 * dual-key bootstrap (`admin-` management key and `sk-` composite inference
 * key stored through the credentials seam), and the hand-declared composite
 * route written into the `llm-pi-ai` settings namespace.
 *
 * Failures fail loud: an unhealthy sidecar never registers a provider, never
 * writes llm-pi-ai, and surfaces the reason. `dispose` stops the process trees
 * and keeps `data/` intact; keys are reused, not reissued, on later boots.
 *
 * @module dsh-sub2api-sidecar
 */

import { resolveConfig } from './config.ts'
import type { RawSidecarConfig } from './config.ts'
import { Supervisor } from './supervisor.ts'
import type { LoggerLike, Seams } from './seam.ts'

/** The plugin's Cordis name. */
export const name = 'dsh-sub2api-sidecar'

/**
 * Required service seams. The Loader blocks until all three exist, so a
 * composition missing any of them fails at load instead of mid-boot.
 */
export const inject = ['subprocess', 'credentials', 'settings'] as const

export { Config } from './config.ts'
export type { RawSidecarConfig, SidecarConfig } from './config.ts'

/**
 * Minimal shape of the Cordis context this plugin uses. The real context
 * satisfies it structurally; the tests provide an equivalent stub.
 */
export interface PluginContext extends Seams {
  /**
   * Register one effect whose disposer runs when the owning fiber unloads.
   * @param execute - body returning the (possibly async) disposer.
   * @returns the effect disposer; awaiting it settles teardown.
   */
  effect(execute: () => () => unknown): () => unknown
  /** The host logger. */
  logger: LoggerLike
}

/**
 * Plugin entry: start the supervised sidecar chain and register its teardown.
 * @param ctx - the host context providing the injected seams.
 * @param config - the validated entry config.
 * @returns when the chain is up (or immediately when `enabled: false`).
 * @throws when any startup step fails; the chain is stopped before rethrowing.
 */
export async function apply(ctx: PluginContext, config: RawSidecarConfig): Promise<void> {
  const resolved = resolveConfig(config, process.env)
  if (!resolved.enabled) {
    ctx.logger.info('dsh-sub2api-sidecar: disabled by config; staying inert')
    return
  }
  const { supervisor, release } = Supervisor.acquire({ config: resolved, seams: ctx })
  ctx.effect(() => () => release())
  try {
    await supervisor.start()
  } catch (error) {
    // The fiber may already be unwinding, and dispose tolerates double
    // release; swallow only the release outcome, then surface the boot error.
    await release().catch(() => {})
    throw error
  }
}
