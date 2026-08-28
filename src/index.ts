/**
 * `dsh-sub2api-sidecar` — the DeepSeek Harness bundle that supervises a local
 * Sub2API sidecar and bootstraps its dual credentials, then serves the two
 * host-half services over the web server seam: the generic injection
 * forwarding plane for the embedded Sub2API admin console and the read-only
 * Host quota snapshot.
 *
 * The function plugin mounts with `inject: ['subprocess', 'credentials',
 * 'settings', 'webServer']`, resolves the entry config once, and — when
 * enabled — starts the whole chain inside one effect whose disposer stops it
 * again: portable PostgreSQL (initdb once, pg_ctl start/stop), the pack's
 * redis-server (or a configured skip/external endpoint), the pinned sub2api
 * binary in `RUN_MODE=simple` bound to 127.0.0.1, the `/health` poll, the
 * idempotent dual-key bootstrap (`admin-` management key and `sk-` composite
 * inference key stored through the credentials seam), and the hand-declared
 * composite route written into the `llm-pi-ai` settings namespace. After a
 * healthy boot it registers the admin proxy prefix
 * (`/plugins/dsh-sub2api/admin` → sidecar `/api/v1/*` with the injected
 * `x-api-key`), the embedded-console passthrough
 * (`/plugins/dsh-sub2api/ui/*` → the sidecar's own Vue console under the
 * host origin), and the quota snapshot route
 * (`/plugins/dsh-sub2api/quota-snapshot`), all admitting only loopback
 * peers with a trusted origin.
 *
 * Failures fail loud: an unhealthy sidecar never registers a provider, never
 * writes llm-pi-ai, and surfaces the reason. `dispose` stops the process
 * trees, unregisters the routes, and stops the poller; keys are reused, not
 * reissued, on later boots.
 *
 * @module dsh-sub2api-sidecar
 */

import { resolveConfig } from './config.ts'
import type { RawSidecarConfig, SidecarConfig } from './config.ts'
import { QuotaSnapshotService, registerQuotaSnapshotRoute } from './quota-snapshot.ts'
import { registerAdminProxy } from './proxy.ts'
import { registerUiProxy } from './ui-proxy.ts'
import { Supervisor } from './supervisor.ts'
import type { LoggerLike, Seams, WebServerService } from './seam.ts'

/** The plugin's Cordis name. */
export const name = 'dsh-sub2api-sidecar'

/**
 * Required service seams. The Loader blocks until all four exist, so a
 * composition missing any of them fails at load instead of mid-boot.
 */
export const inject = ['subprocess', 'credentials', 'settings', 'webServer'] as const

export { Config } from './config.ts'
export type { RawSidecarConfig, SidecarConfig } from './config.ts'
export { ADMIN_PROXY_PREFIX, UPSTREAM_ADMIN_PREFIX, registerAdminProxy } from './proxy.ts'
export type { AdminProxyOptions, SidecarSource } from './proxy.ts'
export { UI_BASE_PATH, UI_PROXY_PREFIX, mapUiPath, registerUiProxy } from './ui-proxy.ts'
export type { UiProxyOptions, UiProxyRegistration } from './ui-proxy.ts'
export { transformUiHtml } from './ui-html.ts'
export { UI_EMBED_SHIM } from './ui-shim.ts'
export { QUOTA_SNAPSHOT_PATH, QuotaSnapshotService, registerQuotaSnapshotRoute } from './quota-snapshot.ts'
export type {
  AccountQuota,
  LocalDerivedQuota,
  QuotaBalance,
  QuotaSnapshot,
  QuotaSnapshotOptions,
  QuotaWindow,
  RemoteProbedQuota,
  SnapshotAccount,
} from './quota-snapshot.ts'
export { admit, isLoopbackAddress, isLoopbackHost, parseAllowedOrigin } from './trust.ts'
export type { AdmissionDecision, RequestFacts, TrustPolicy } from './trust.ts'

/**
 * Minimal shape of the Cordis context this plugin uses. The real context
 * satisfies it structurally; the tests provide an equivalent stub.
 */
export interface PluginContext extends Seams {
  /** The host web server seam (`ctx.webServer`). */
  readonly webServer: WebServerService
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
 * Plugin entry: start the supervised sidecar chain, register its teardown,
 * and mount the two host-half services behind the web server seam.
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
  mountHostServices(ctx, resolved, supervisor)
}

/**
 * Register the injection forwarding plane, the embedded-console passthrough,
 * and the quota snapshot service on the web server seam. Mounting is
 * immediate (the routes answer as soon as apply returns); each piece's
 * disposer goes inside its own effect so an unload removes the routes and
 * stops the poller. The sidecar port and readiness are read from the
 * supervisor instance — the single source of truth for the running chain.
 * @param ctx - the host context.
 * @param config - the resolved configuration.
 * @param supervisor - the acquired supervisor owning the running chain.
 */
function mountHostServices(ctx: PluginContext, config: SidecarConfig, supervisor: Supervisor): void {
  if (!config.proxy.enabled) {
    ctx.logger.info('dsh-sub2api-sidecar: proxy disabled by config; admin prefix stays unregistered')
    return
  }
  const sidecar = { get port(): number | undefined { return supervisor.sidecarPort } }
  const proxy = registerAdminProxy({
    config,
    webServer: ctx.webServer,
    credentials: ctx.credentials,
    logger: ctx.logger,
    sidecar,
  })
  ctx.effect(() => () => proxy.dispose())
  const ui = registerUiProxy({
    config,
    webServer: ctx.webServer,
    credentials: ctx.credentials,
    logger: ctx.logger,
    sidecar,
  })
  ctx.effect(() => () => ui.dispose())
  const quota = new QuotaSnapshotService({
    config,
    credentials: ctx.credentials,
    logger: ctx.logger,
    sidecar,
  })
  ctx.effect(() => () => quota.dispose())
  const disposeSnapshotRoute = registerQuotaSnapshotRoute(
    { config, credentials: ctx.credentials, logger: ctx.logger, sidecar },
    ctx.webServer,
    quota,
  )
  ctx.effect(() => () => disposeSnapshotRoute())
  quota.start()
}
