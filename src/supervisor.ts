/**
 * The supervisor: one boot of the whole sidecar chain — directories, initdb,
 * postgres, redis, sub2api, health, bootstrap, llm-pi-ai profile — and the
 * dispose ladder that stops it. Instances are refcounted per resolved
 * runtime dir on a globalThis-keyed registry, so a double mount or an HMR
 * reload cannot start a second process set behind one runtime dir, and the
 * chain stops only when the last owner releases.
 *
 * `dispose` terminates the managed trees (sub2api, redis) and shuts postgres
 * down through `pg_ctl stop`. Neither `data/` nor the runtime pack is ever
 * deleted or emptied by this package.
 *
 * @module dsh-sub2api-sidecar/supervisor
 */

import fs from 'node:fs/promises'
import { Sub2apiClient } from './client.ts'
import { DEFAULT_EXTERNAL_REDIS } from './config.ts'
import type { SidecarConfig } from './config.ts'
import { ensureAdminPassword } from './admin-password.ts'
import { ensureBootstrap } from './bootstrap.ts'
import { awaitHealthy } from './health.ts'
import { prepareLayout, resolveLayout } from './layout.ts'
import type { Layout } from './layout.ts'
import type { DesiredProfile } from './llm-profile.ts'
import { allocatePort, allocatePortPair } from './ports.ts'
import { initdbOnce, startPostgres, stopPostgres } from './postgres.ts'
import { startRedis } from './redis.ts'
import type { RedisOutcome, RedisRequest } from './redis.ts'
import type { Seams } from './seam.ts'
import { buildServerEnv, startSub2api } from './sub2api-process.ts'
import type { SubprocessHandleLike } from './seam.ts'

/** Supervisor state persisted under the run directory; contains no secrets. */
interface SupervisorState {
  /** ISO timestamp of the last successful bootstrap. */
  bootstrappedAt?: string
  /** The llm-pi-ai profile written by the last successful boot. */
  lastWrittenProfile?: DesiredProfile
}

/** Dependencies one supervisor instance is built from. */
export interface SupervisorOptions {
  /** Resolved plugin configuration. */
  readonly config: SidecarConfig
  /** Host service seams and logger. */
  readonly seams: Seams
}

/** Refcounted registry entry behind the globalThis key. */
interface RegistryEntry {
  readonly supervisor: Supervisor
  readonly releaseRef: () => void
  refs: number
}


/**
 * Cross-HMR registry. Module re-instantiation (Cordis HMR) gives the plugin a
 * fresh module scope, so the registry lives on `globalThis` under a symbol to
 * remain authoritative for the process lifetime.
 */
const REGISTRY_KEY = Symbol.for('dsh-sub2api-sidecar/supervisors')

/** Read or create the process-wide registry. */
function registry(): Map<string, RegistryEntry> {
  const globalRegistry = globalThis as unknown as Record<symbol, Map<string, RegistryEntry> | undefined>
  const existing = globalRegistry[REGISTRY_KEY]
  if (existing) return existing
  const created = new Map<string, RegistryEntry>()
  globalRegistry[REGISTRY_KEY] = created
  return created
}

/** One supervised sidecar boot, refcounted per runtime dir. */
export class Supervisor {
  private readonly config: SidecarConfig
  private readonly seams: Seams
  private readonly layout: Layout
  private readonly abort = new AbortController()
  private entry: RegistryEntry | undefined
  private startPromise: Promise<void> | undefined
  private stopping: Promise<void> | undefined
  private serverPort: number | undefined
  private serverHandle: SubprocessHandleLike | undefined
  private redis: RedisOutcome | undefined

  private constructor(options: SupervisorOptions) {
    this.config = options.config
    this.seams = options.seams
    this.layout = resolveLayout(options.config)
  }

  /**
   * Acquire the supervisor for the config's runtime dir, starting it lazily on
   * the first acquisition. A second acquisition of the same runtime dir — a
   * double mount or an HMR reload before the old fiber released — returns the
   * running instance instead of starting another process set.
   * @param options - resolved config and host seams.
   * @returns the supervisor and a token disposer releasing this acquisition.
   */
  static acquire(options: SupervisorOptions): { supervisor: Supervisor; release: () => Promise<void> } {
    const key = options.config.runtimeDir
    let entry = registry().get(key)
    if (!entry) {
      const created = new Supervisor(options)
      entry = {
        supervisor: created,
        refs: 0,
        releaseRef: () => {
          const current = registry().get(key)
          if (current === undefined || current.supervisor !== created) return
          current.refs -= 1
          if (current.refs <= 0) {
            registry().delete(key)
            created.stopping ??= created.dispose()
          }
        },
      }
      created.entry = entry
      registry().set(key, entry)
    }
    entry.refs += 1
    const supervisor = entry.supervisor
    return { supervisor, release: () => supervisor.releaseOwned() }
  }

  /** Release one acquisition; the last release stops the chain. */
  private async releaseOwned(): Promise<void> {
    this.entry?.releaseRef()
    if (this.stopping !== undefined) await this.stopping
  }

  /** Whether this instance owns a started or starting chain. */
  get running(): boolean {
    return this.startPromise !== undefined && this.stopping === undefined
  }

  /**
   * Start the chain once per instance; concurrent and repeated calls share the
   * same startup.
   * @throws when any step fails; earlier steps are stopped by the dispose
   * ladder the caller registers (or the failure path invokes).
   */
  async start(): Promise<void> {
    this.startPromise ??= this.boot()
    await this.startPromise
  }

  /** The boot sequence; each step fails loud and names its cause. */
  private async boot(): Promise<void> {
    const { config, seams, layout, abort } = this
    const logger = seams.logger
    logger.info('dsh-sub2api-sidecar: starting sidecar chain under %s', layout.runtimeDir)
    await prepareLayout(layout)

    const needsLocalRedis = config.redis.external === undefined && !config.redis.skip
    const [postgresPort, serverPort] = await allocatePortPair(config.portRange)
    const redisPort = needsLocalRedis ? await allocatePort(config.portRange) : undefined
    const redisRequest: RedisRequest = config.redis.external !== undefined
      ? { plan: 'external', host: config.redis.external.host, port: config.redis.external.port }
      : config.redis.skip
        ? { plan: 'skip' }
        // needsLocalRedis pinned the port allocation above to this branch.
        : { plan: 'local', port: redisPort as number }

    await initdbOnce(seams.subprocess, {
      initdbPath: layout.bin.initdb,
      pgCtlPath: layout.bin.pgCtl,
      pgDataDir: layout.pgDataDir,
      logPath: layout.postgresLog,
      socketDir: layout.runDir,
      graceMs: config.stopGraceMs,
    }, abort.signal)
    await startPostgres(seams.subprocess, {
      initdbPath: layout.bin.initdb,
      pgCtlPath: layout.bin.pgCtl,
      pgDataDir: layout.pgDataDir,
      logPath: layout.postgresLog,
      socketDir: layout.runDir,
      graceMs: config.stopGraceMs,
    }, postgresPort, abort.signal)
    logger.info('dsh-sub2api-sidecar: postgres listening on 127.0.0.1:%d', postgresPort)

    this.redis = await startRedis(
      seams.subprocess,
      layout,
      redisRequest,
      { timeoutMs: config.healthTimeoutMs, graceMs: config.stopGraceMs },
      abort.signal,
    )
    const redisEndpoint = this.redis.kind === 'managed' || this.redis.kind === 'external'
      ? { host: this.redis.host, port: this.redis.port }
      // Skip without an external endpoint points sub2api at the conventional
      // local Redis; a first-boot AUTO_SETUP then fails loudly there if none
      // is listening, which is the documented posture of `redis.skip`.
      : { ...DEFAULT_EXTERNAL_REDIS }
    if (this.redis.kind === 'managed') {
      logger.info('dsh-sub2api-sidecar: redis listening on 127.0.0.1:%d', this.redis.port)
    } else if (this.redis.kind === 'skipped') {
      logger.warn('dsh-sub2api-sidecar: bundled redis skipped by configuration; skip recorded at %s', this.redis.markerPath)
    } else {
      logger.info('dsh-sub2api-sidecar: using external redis at %s:%d', this.redis.host, this.redis.port)
    }

    const adminPassword = await ensureAdminPassword(config.adminPassword, layout.adminPasswordFile)
    this.serverPort = serverPort
    const serverHandle = startSub2api(
      seams.subprocess,
      [layout.bin.sub2api],
      layout.runDir,
      buildServerEnv({
        dataDir: layout.dataDir,
        serverPort,
        postgres: { port: postgresPort },
        redis: redisEndpoint,
        admin: { email: config.adminEmail, password: adminPassword },
      }),
      config.stopGraceMs,
      abort.signal,
    )
    this.serverHandle = serverHandle
    await awaitHealthy({
      baseUrl: `http://127.0.0.1:${serverPort}`,
      timeoutMs: config.healthTimeoutMs,
      pollMs: config.healthPollMs,
    }, serverHandle)
    logger.info('dsh-sub2api-sidecar: sub2api healthy at http://127.0.0.1:%d', serverPort)

    const state = await readState(layout.stateFile)
    const client = new Sub2apiClient({ baseUrl: `http://127.0.0.1:${serverPort}` })
    const result = await ensureBootstrap({
      client,
      credentials: seams.credentials,
      settings: seams.settings,
      logger,
      config,
      adminPassword,
      lastWrittenProfile: state.lastWrittenProfile,
      serverPort,
    })
    await writeState(layout.stateFile, {
      bootstrappedAt: new Date().toISOString(),
      lastWrittenProfile: result.writtenProfile,
    })
    logger.info(
      'dsh-sub2api-sidecar: bootstrap complete (admin key %s, inference key %s)',
      result.reusedAdminKey ? 'reused' : 'issued',
      result.reusedInferenceKey ? 'reused' : 'issued',
    )
  }

  /**
   * Stop the chain: terminate the managed trees, then shut postgres down
   * through `pg_ctl stop`. Idempotent; safe on a partially started chain.
   * The data directory is preserved.
   */
  private async dispose(): Promise<void> {
    this.abort.abort()
    const { seams, layout } = this
    const logger = seams.logger
    const handles = [this.serverHandle, this.redis?.kind === 'managed' ? this.redis.handle : undefined]
      .filter((handle): handle is SubprocessHandleLike => handle !== undefined)
    await Promise.all(handles.map(async (handle) => {
      handle.terminate()
      await handle.waitForExit()
    }))
    this.serverHandle = undefined
    this.redis = undefined
    this.startPromise = undefined
    if (await fs.access(layout.pgDataDir).then(() => true, () => false)) {
      const mode = await stopPostgres(seams.subprocess, {
        initdbPath: layout.bin.initdb,
        pgCtlPath: layout.bin.pgCtl,
        pgDataDir: layout.pgDataDir,
        logPath: layout.postgresLog,
        socketDir: layout.runDir,
        graceMs: this.config.stopGraceMs,
      })
      logger.info('dsh-sub2api-sidecar: postgres stopped (%s shutdown); data preserved at %s', mode, layout.dataDir)
    }
    logger.info('dsh-sub2api-sidecar: sidecar chain stopped')
  }
}

/**
 * Read the persisted supervisor state, tolerating absence or corruption.
 * @param stateFile - the state file path.
 * @returns the parsed state, or an empty state.
 */
async function readState(stateFile: string): Promise<SupervisorState> {
  const text = await fs.readFile(stateFile, 'utf8').catch(() => null)
  if (text === null) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) return parsed as SupervisorState
    return {}
  } catch {
    // A corrupt state file only costs a redundant profile write and one
    // bootstrap validation round; never fail the boot for it.
    return {}
  }
}

/**
 * Persist the supervisor state (no secrets) atomically enough for a run dir:
 * write then rename.
 * @param stateFile - the state file path.
 * @param state - the state to persist.
 */
async function writeState(stateFile: string, state: SupervisorState): Promise<void> {
  const tmp = `${stateFile}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await fs.rename(tmp, stateFile)
}
