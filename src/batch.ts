/**
 * Batch execution helpers over the subprocess seam: run one short-lived tool
 * (initdb, pg_ctl) to completion and surface failures with the collected
 * stderr tail. Long-lived processes (postgres via pg_ctl start, redis,
 * sub2api) are spawned through the seam directly and stay handle-owned.
 *
 * @module dsh-sub2api-sidecar/batch
 */

import type { SubprocessHandleLike, SubprocessService, SubprocessSpawnSpec } from './seam.ts'

/** Result of one completed batch run. */
export interface BatchResult {
  /** Exit code; null when the child died from a signal. */
  exitCode: number | null
  /** Terminating signal; null on normal exit. */
  signal: string | null
  /** Collected stderr tail (bounded). */
  stderrTail: string
}

/** Bounded in-memory tail kept for diagnostic messages. */
const DIAGNOSTIC_TAIL_BYTES = 16_384

/**
 * Run one batch-style command through the subprocess seam and await exit.
 * @param subprocess - the host subprocess seam.
 * @param spec - the fully-specified spawn request; stdout/stderr are collected.
 * @returns the exit facts plus the bounded stderr tail.
 * @throws when the spawn itself failed (executable missing, permission denied).
 */
export async function runBatch(
  subprocess: SubprocessService,
  spec: Pick<SubprocessSpawnSpec, 'argv' | 'cwd' | 'env' | 'signal'> & { graceMs: number },
): Promise<BatchResult> {
  const handle = subprocess.spawn({
    ...spec,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: DIAGNOSTIC_TAIL_BYTES },
      stderr: { maxBytes: DIAGNOSTIC_TAIL_BYTES },
    },
  })
  const outcome = await handle.done
  return {
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stderrTail: readTail(handle, 'stderr'),
  }
}

/**
 * Read the whole collected stream content of one side of a closed handle.
 * @param handle - the settled child handle.
 * @param side - which collected stream to read.
 * @returns the retained tail text; empty when the stream was not collected.
 */
export function readTail(
  handle: SubprocessHandleLike,
  side: 'stdout' | 'stderr',
): string {
  const reader = handle.collected[side]
  if (!reader) return ''
  // A lossy read from offset 0 returns the whole retained tail, which is the
  // bounded diagnostic this helper promises.
  return reader.readFrom(0).text
}

/**
 * Format one batch failure: the command, the exit facts, and the stderr tail.
 * The tail is bounded upstream, so the message cannot grow without bound.
 * @param label - human-readable step name for the error.
 * @param result - the failed batch result.
 * @returns the formatted error message.
 */
export function formatBatchFailure(label: string, result: BatchResult): string {
  const exit = result.exitCode !== null
    ? `exit ${result.exitCode}`
    : `signal ${result.signal ?? 'unknown'}`
  const stderr = result.stderrTail.trim()
  return `dsh-sub2api-sidecar: ${label} failed (${exit})${stderr.length > 0 ? `\n${stderr}` : ''}`
}
