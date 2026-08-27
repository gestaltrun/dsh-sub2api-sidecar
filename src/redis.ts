/**
 * redis-server lifecycle. The darwin runtime pack ships a loud placeholder
 * instead of a real redis (pack-sources.lock.json sources.redis), so a launch
 * attempt without configuration fails loudly naming the lock entry; `redis.skip`
 * records the skip under the run directory instead. A real (non-stub) binary is
 * spawned as a managed child and awaited via loopback TCP readiness.
 *
 * @module dsh-sub2api-sidecar/redis
 */

import net from 'node:net'
import fs from 'node:fs/promises'
import { formatBatchFailure } from './batch.ts'
import { isRedisStub } from './layout.ts'
import type { Layout } from './layout.ts'
import type { SubprocessHandleLike, SubprocessService } from './seam.ts'

/** Outcome of the redis step of one boot. */
export type RedisOutcome =
  | { readonly kind: 'managed'; readonly handle: SubprocessHandleLike; readonly host: string; readonly port: number }
  | { readonly kind: 'external'; readonly host: string; readonly port: number }
  | { readonly kind: 'skipped'; readonly markerPath: string }

/** What this boot wants from the redis component, decided by config alone. */
export type RedisRequest =
  | { readonly plan: 'external'; readonly host: string; readonly port: number }
  | { readonly plan: 'skip' }
  | { readonly plan: 'local'; readonly port: number }

/** Bounded in-memory tail for the redis stderr diagnostic. */
const REDIS_STDERR_TAIL_BYTES = 16_384

/** Whole-stream spill cap for the redis stderr diagnostic. */
const REDIS_STDERR_SPILL_BYTES = 1_048_576

/**
 * Wait until a loopback TCP endpoint accepts a connection, or fail once the
 * deadline passes.
 * @param port - loopback port to probe.
 * @param deadline - absolute epoch-milliseconds budget.
 * @param signal - cancellation of the wait.
 * @throws when the deadline passes first or the wait is aborted.
 */
async function awaitTcpReady(port: number, deadline: number, signal: AbortSignal | undefined): Promise<void> {
  for (;;) {
    if (signal?.aborted) throw new Error('dsh-sub2api-sidecar: redis start aborted')
    if (Date.now() > deadline) {
      throw new Error(`dsh-sub2api-sidecar: redis on 127.0.0.1:${port} did not accept connections in time`)
    }
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
    })
    if (open) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * Read the bounded stderr tail of a settled redis child.
 * @param handle - the child handle.
 * @returns the retained tail; empty when nothing was collected.
 */
function redisStderrTail(handle: SubprocessHandleLike): string {
  const reader = handle.collected.stderr
  if (!reader) return ''
  return reader.readFrom(0).text
}

/**
 * Start or account for the redis component of one boot.
 * @param subprocess - the host subprocess seam.
 * @param layout - the resolved layout.
 * @param request - what this boot wants from redis (external endpoint, skip, or local launch).
 * @param options - readiness timeout and terminate grace.
 * @param signal - cancellation of the start.
 * @returns what the boot decided for redis.
 * @throws when the pack binary is the darwin stub and skipping is not configured,
 * or when a real binary exits or stays unreachable before readiness.
 */
export async function startRedis(
  subprocess: SubprocessService,
  layout: Layout,
  request: RedisRequest,
  options: {
    timeoutMs: number
    graceMs: number
  },
  signal: AbortSignal | undefined,
): Promise<RedisOutcome> {
  if (request.plan === 'external') {
    return { kind: 'external', host: request.host, port: request.port }
  }
  if (request.plan === 'skip') {
    const marker = {
      skippedAt: new Date().toISOString(),
      reason: 'config.redis.skip=true; the pack ships no darwin redis binary (pack-sources.lock.json sources.redis)',
    }
    await fs.writeFile(layout.redisSkipMarker, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
    return { kind: 'skipped', markerPath: layout.redisSkipMarker }
  }
  if (await isRedisStub(layout.bin.redis)) {
    throw new Error(
      `dsh-sub2api-sidecar: ${layout.bin.redis} is the runtime pack's Redis placeholder — no trustworthy`
        + ' portable darwin redis distribution exists (pack-sources.lock.json sources.redis). Start an'
        + ' external Redis and set config.redis = { skip: true, external: { host, port } }, or replace'
        + ' the placeholder with a real binary.',
    )
  }

  const handle = subprocess.spawn({
    argv: [layout.bin.redis, '--port', String(request.port), '--bind', '127.0.0.1'],
    cwd: layout.runDir,
    stdio: {
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: { maxBytes: REDIS_STDERR_TAIL_BYTES, spill: { maxBytes: REDIS_STDERR_SPILL_BYTES } },
    },
    graceMs: options.graceMs,
    signal,
    env: {},
  })
  const deadline = Date.now() + options.timeoutMs
  const readiness = awaitTcpReady(request.port, deadline, signal)
  const exited = handle.done.then(async (outcome) => {
    throw new Error(formatBatchFailure(
      `redis-server (exited before accepting connections on 127.0.0.1:${String(request.port)})`,
      { ...outcome, stderrTail: redisStderrTail(handle) },
    ))
  })
  await Promise.race([readiness, exited])
  return { kind: 'managed', handle, host: '127.0.0.1', port: request.port }
}
