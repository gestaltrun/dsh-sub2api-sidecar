/**
 * sub2api readiness: poll `GET /health` (the upstream common route answers
 * `{"status":"ok"}`) until it succeeds or the deadline passes, racing the
 * server process so an early crash is reported with its own output instead of
 * burning the whole health budget.
 *
 * @module dsh-sub2api-sidecar/health
 */

import { formatBatchFailure } from './batch.ts'
import type { SubprocessHandleLike } from './seam.ts'

/** Facts one health attempt carries, for diagnostics on failure. */
export interface HealthOptions {
  /** Base URL, e.g. `http://127.0.0.1:45123`. */
  readonly baseUrl: string
  /** Total poll budget in milliseconds. */
  readonly timeoutMs: number
  /** Interval between probes in milliseconds. */
  readonly pollMs: number
}

/**
 * Read the bounded stderr tail of a settled server child.
 * @param handle - the server handle.
 * @returns the retained tail; empty when nothing was collected.
 */
function serverStderrTail(handle: SubprocessHandleLike): string {
  const reader = handle.collected.stderr
  if (!reader) return ''
  return reader.readFrom(0).text
}

/**
 * Probe the health endpoint once.
 * @param baseUrl - the server base URL.
 * @returns true when the endpoint answered 200 with `status: "ok"`.
 */
async function probeOnce(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(new URL('/health', baseUrl), {
      signal: AbortSignal.timeout(5_000),
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return false
    const body: unknown = await response.json().catch(() => null)
    return typeof body === 'object' && body !== null
      && (body as Record<string, unknown>)['status'] === 'ok'
  } catch {
    return false
  }
}

/**
 * Poll the server health endpoint until ready.
 * @param options - base URL, timeout budget, and poll interval.
 * @param handle - the server child; its early exit fails the poll immediately.
 * @returns when the endpoint reports ready.
 * @throws when the deadline passes, or the server exited before becoming healthy
 * (the error carries the server's collected stderr tail).
 */
export async function awaitHealthy(options: HealthOptions, handle: SubprocessHandleLike): Promise<void> {
  const deadline = Date.now() + options.timeoutMs
  const poll = (async () => {
    for (;;) {
      if (await probeOnce(options.baseUrl)) return
      if (Date.now() > deadline) {
        throw new Error(
          `dsh-sub2api-sidecar: sub2api at ${options.baseUrl} did not become healthy within`
            + ` ${options.timeoutMs}ms — check ${options.baseUrl}/health and the server's output spill`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, options.pollMs))
    }
  })()
  const exited = handle.done.then(async (outcome) => {
    throw new Error(formatBatchFailure(
      `sub2api exited before becoming healthy (while polling ${options.baseUrl}/health)`,
      { ...outcome, stderrTail: serverStderrTail(handle) },
    ))
  })
  await Promise.race([poll, exited])
}
