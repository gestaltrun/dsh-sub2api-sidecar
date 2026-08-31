/**
 * PostgreSQL lifecycle over the subprocess seam. First use runs `initdb` into
 * `<dataDir>/pg`; every boot starts `postgres` in the foreground through the
 * subprocess seam. The returned handle owns the whole server tree, so normal
 * disposal and provider teardown share the same awaited termination path.
 * The cluster directory is never deleted.
 *
 * @module dsh-sub2api-sidecar/postgres
 */

import fs from 'node:fs/promises'
import { createConnection } from 'node:net'
import path from 'node:path'
import { formatBatchFailure, readTail, runBatch } from './batch.ts'
import type { SubprocessHandleLike, SubprocessOutcome, SubprocessService } from './seam.ts'

/** Paths and knobs the one-time cluster initialization needs. */
export interface InitdbOptions {
  /** Path to the pack's initdb binary. */
  readonly initdbPath: string
  /** PostgreSQL cluster directory. */
  readonly pgDataDir: string
  /** Working directory for cluster initialization. */
  readonly socketDir: string
  /** Wait budget for initdb termination escalation. */
  readonly graceMs: number
}

/** Paths and knobs the foreground PostgreSQL server needs. */
export interface PostgresOptions {
  /** Path to the pack's foreground postgres binary. */
  readonly postgresPath: string
  /** PostgreSQL cluster directory. */
  readonly pgDataDir: string
  /** Server collector log file. */
  readonly logPath: string
  /** Unix-socket directory for the postmaster. */
  readonly socketDir: string
  /** Wait budget for startup readiness and terminate escalation. */
  readonly graceMs: number
  /** Maximum time for the loopback listener to become ready. */
  readonly startupTimeoutMs: number
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
  options: InitdbOptions,
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
 * Start the postgres server as a foreground managed process and wait until
 * its loopback listener accepts connections.
 * @param subprocess - the host subprocess seam.
 * @param options - postgres paths and knobs.
 * @param port - loopback port for the server.
 * @param signal - cancellation of the start.
 * @returns the managed PostgreSQL process tree.
 * @throws when the process exits or the listener misses its startup budget.
 */
export async function startPostgres(
  subprocess: SubprocessService,
  options: PostgresOptions,
  port: number,
  signal: AbortSignal | undefined,
): Promise<SubprocessHandleLike> {
  const handle = subprocess.spawn({
    argv: [
      options.postgresPath,
      '-D', options.pgDataDir,
      '-c', 'listen_addresses=127.0.0.1',
      '-c', `port=${String(port)}`,
      '-c', `unix_socket_directories=${options.socketDir}`,
      '-c', 'logging_collector=on',
      '-c', `log_directory=${options.socketDir}`,
      '-c', `log_filename=${path.basename(options.logPath)}`,
    ],
    cwd: options.socketDir,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 256 * 1024, spill: { maxBytes: 8 * 1024 * 1024 } },
      stderr: { maxBytes: 256 * 1024, spill: { maxBytes: 8 * 1024 * 1024 } },
    },
    graceMs: options.graceMs,
    signal,
  })
  await waitForPostgres(handle, port, options.startupTimeoutMs, signal)
  return handle
}

async function waitForPostgres(
  handle: SubprocessHandleLike,
  port: number,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  let outcome: SubprocessOutcome | Error | undefined
  void handle.done.then(value => { outcome = value }, error => { outcome = error as Error })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted === true) {
      handle.terminate()
      await handle.waitForExit()
      throw new DOMException('PostgreSQL startup was cancelled', 'AbortError')
    }
    if (outcome instanceof Error) throw outcome
    if (outcome !== undefined) {
      const stderr = readTail(handle, 'stderr').trim()
      throw new Error(
        `postgres exited before readiness (code ${String(outcome.exitCode)}, signal ${String(outcome.signal)})`
          + (stderr.length > 0 ? `\n${stderr}` : ''),
      )
    }
    if (await acceptsConnection(port)) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  handle.terminate()
  await handle.waitForExit()
  throw new Error(`postgres did not accept loopback connections within ${String(timeoutMs)}ms`)
}

function acceptsConnection(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false
    const finish = (ready: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ready)
    }
    socket.once('connect', () => { finish(true) })
    socket.once('error', () => { finish(false) })
    socket.setTimeout(250, () => { finish(false) })
  })
}
