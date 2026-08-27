/**
 * PostgreSQL lifecycle over the subprocess seam. First use runs `initdb` into
 * `<dataDir>/pg`; every boot starts through `pg_ctl start`, which daemonizes
 * the postmaster — so the supervisor does not own a handle for postgres and
 * stops it through `pg_ctl stop`, which SIGTERMs the postmaster for a clean
 * shutdown. The cluster directory is never deleted.
 *
 * @module dsh-sub2api-sidecar/postgres
 */

import fs from 'node:fs/promises'
import { formatBatchFailure, runBatch } from './batch.ts'
import type { SubprocessService } from './seam.ts'

/** Paths and knobs the postgres steps need. */
export interface PostgresOptions {
  /** Path to the pack's initdb binary. */
  readonly initdbPath: string
  /** Path to the pack's pg_ctl binary. */
  readonly pgCtlPath: string
  /** PostgreSQL cluster directory. */
  readonly pgDataDir: string
  /** Server log file (`pg_ctl -l`). */
  readonly logPath: string
  /** Unix-socket directory for the postmaster. */
  readonly socketDir: string
  /** Wait budget for `pg_ctl start`/`stop`. */
  readonly graceMs: number
}

/**
 * Initialize a fresh PostgreSQL cluster when none exists yet. Auth is `trust`
 * because the server binds 127.0.0.1 only and the pack is host-local; the
 * locale is pinned to C/UTF-8 so initialization never depends on the host
 * locale environment.
 * @param subprocess - the host subprocess seam.
 * @param options - postgres paths and knobs.
 * @param signal - cancellation of the initialization.
 * @returns true when a cluster was created, false when one already existed.
 * @throws when initdb exits non-zero.
 */
export async function initdbOnce(
  subprocess: SubprocessService,
  options: PostgresOptions,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const versionFile = `${options.pgDataDir}/PG_VERSION`
  if (await fs.access(versionFile).then(() => true, () => false)) return false
  const result = await runBatch(subprocess, {
    argv: [
      options.initdbPath,
      '-D', options.pgDataDir,
      '-U', 'postgres',
      '-A', 'trust',
      '-E', 'UTF8',
      '--locale=C',
    ],
    cwd: options.socketDir,
    graceMs: options.graceMs,
    signal,
  })
  if (result.exitCode !== 0) throw new Error(formatBatchFailure('initdb', result))
  return true
}

/**
 * Start the postgres server through `pg_ctl start`, which waits until the
 * postmaster accepts connections before exiting. The server binds 127.0.0.1
 * only, on the allocated port, with its socket under the run directory.
 * @param subprocess - the host subprocess seam.
 * @param options - postgres paths and knobs.
 * @param port - loopback port for the server.
 * @param signal - cancellation of the start.
 * @throws when pg_ctl exits non-zero.
 */
export async function startPostgres(
  subprocess: SubprocessService,
  options: PostgresOptions,
  port: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const result = await runBatch(subprocess, {
    argv: [
      options.pgCtlPath,
      '-D', options.pgDataDir,
      '-l', options.logPath,
      '-o', `-c listen_addresses=127.0.0.1 -c port=${port} -c unix_socket_directories=${options.socketDir}`,
      'start',
    ],
    cwd: options.socketDir,
    graceMs: options.graceMs,
    signal,
  })
  if (result.exitCode !== 0) throw new Error(formatBatchFailure('pg_ctl start', result))
}

/**
 * Stop the postgres server cleanly (`-m fast`, SIGTERM to the postmaster) and
 * escalate to `-m immediate` when the fast shutdown did not settle.
 * @param subprocess - the host subprocess seam.
 * @param options - postgres paths and knobs.
 * @returns the shutdown mode that succeeded.
 * @throws when even the immediate shutdown fails; the data stays untouched either way.
 */
export async function stopPostgres(subprocess: SubprocessService, options: PostgresOptions): Promise<'fast' | 'immediate'> {
  for (const mode of ['fast', 'immediate'] as const) {
    const result = await runBatch(subprocess, {
      argv: [options.pgCtlPath, '-D', options.pgDataDir, '-m', mode, 'stop'],
      cwd: options.socketDir,
      graceMs: options.graceMs,
    })
    if (result.exitCode === 0) return mode
  }
  // A pg_ctl stop failure usually means no server is running (already stopped
  // or crashed); confirm via status so a wedged postmaster fails loudly here.
  const status = await runBatch(subprocess, {
    argv: [options.pgCtlPath, '-D', options.pgDataDir, 'status'],
    cwd: options.socketDir,
    graceMs: options.graceMs,
  })
  if (status.exitCode !== 0) return 'immediate'
  throw new Error(formatBatchFailure('pg_ctl stop', status))
}
