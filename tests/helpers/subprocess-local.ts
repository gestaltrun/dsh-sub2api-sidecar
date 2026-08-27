/**
 * Test double of the harness subprocess seam: a faithful-enough local
 * provider over `node:child_process` with detached process groups, bounded
 * collected output with spill, and the SIGTERM → grace → SIGKILL tree
 * escalation the real seam promises. Tests exercise real process lifecycles
 * through this, so dispose assertions observe real exits.
 *
 * @module tests/helpers/subprocess-local
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createWriteStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SubprocessHandleLike, SubprocessOutputReader, SubprocessService, SubprocessSpawnSpec } from '../../src/seam.ts'

/** Spill root for this test run's collected streams. */
const spillRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sidecar-spill-'))

/** One bounded collected stream with offset reads. */
class CollectedStream implements SubprocessOutputReader {
  private buffer = ''
  private bytesDropped = 0
  private totalBytes = 0
  private readonly maxBytes: number
  private readonly spillPath: string
  private readonly spillStream: fs.WriteStream

  /**
   * @param spec - the collect disposition (memory cap and optional spill cap).
   * @param label - unique label backing the spill file name.
   */
  constructor(spec: { maxBytes: number; spill?: { maxBytes: number } }, label: string) {
    this.maxBytes = spec.maxBytes
    this.spillPath = path.join(spillRoot, label)
    this.spillStream = createWriteStream(this.spillPath, { flags: 'w' })
  }

  /** Append one chunk, keeping only the tail beyond the in-memory cap. */
  push(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    this.totalBytes += Buffer.byteLength(text)
    this.spillStream.write(text)
    this.buffer += text
    const oversize = Buffer.byteLength(this.buffer) - this.maxBytes
    if (oversize > 0) {
      // Drop from the head until the buffer fits; a multibyte char split at
      // the boundary degrades to replacement chars, acceptable for diagnostics.
      this.buffer = this.buffer.slice(this.buffer.length - oversize)
      this.bytesDropped += oversize
    }
  }

  /** Close the spill stream; called once at process close. */
  end(): void {
    this.spillStream.end()
  }

  readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean } {
    if (fromByte <= this.bytesDropped) {
      return { text: this.buffer, nextOffset: this.totalBytes, lossy: this.bytesDropped > 0 }
    }
    const relative = fromByte - this.bytesDropped
    if (relative >= this.buffer.length) {
      return { text: '', nextOffset: this.totalBytes, lossy: false }
    }
    return { text: this.buffer.slice(relative), nextOffset: this.totalBytes, lossy: false }
  }

  /** Whole retained tail; used by assertions reading diagnostics after exit. */
  tail(): string {
    return this.buffer
  }
}

/** Build the test subprocess service. */
export function makeSubprocessService(): SubprocessService {
  return {
    spawn(spec: SubprocessSpawnSpec): SubprocessHandleLike {
      const stdio: Array<'ignore' | 'pipe' | 'inherit'> = [
        spec.stdio.stdin === 'ignore' ? 'ignore' : 'pipe',
        spec.stdio.stdout === 'pipe' || typeof spec.stdio.stdout === 'object' ? 'pipe' : 'inherit',
        spec.stdio.stderr === 'pipe' || typeof spec.stdio.stderr === 'object' ? 'pipe' : 'inherit',
      ]
      // Scrub credential-shaped and DSH_* names, mirroring the real seam's
      // ambient base, then merge the spec's explicit entries.
      const env: NodeJS.ProcessEnv = {}
      for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined) continue
        if (/KEY|PASSWORD|SECRET|TOKEN/i.test(key)) continue
        if (key.toUpperCase().startsWith('DSH_')) continue
        env[key] = value
      }
      if (spec.env !== undefined) Object.assign(env, spec.env)

      const child = spawn(spec.argv[0] as string, spec.argv.slice(1), {
        cwd: spec.cwd,
        env,
        stdio,
        detached: true,
      })
      let counter = 0
      const stdout = typeof spec.stdio.stdout === 'object'
        ? new CollectedStream(spec.stdio.stdout, `pid${String(child.pid)}-stdout-${String(counter++)}`)
        : undefined
      const stderr = typeof spec.stdio.stderr === 'object'
        ? new CollectedStream(spec.stdio.stderr, `pid${String(child.pid)}-stderr-${String(counter++)}`)
        : undefined
      child.stdout?.on('data', (chunk: Buffer) => stdout?.push(chunk))
      child.stderr?.on('data', (chunk: Buffer) => stderr?.push(chunk))

      let settled = false
      let escalateTimer: NodeJS.Timeout | undefined
      const done = new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
        child.once('error', (error) => {
          settled = true
          stdout?.end()
          stderr?.end()
          reject(error)
        })
        child.once('close', (code, signal) => {
          settled = true
          stdout?.end()
          stderr?.end()
          resolve({ exitCode: code, signal: signal ?? null })
        })
      })
      const terminate = (): void => {
        const pid = child.pid
        if (settled || pid === undefined) return
        try {
          process.kill(-pid, 'SIGTERM')
        } catch {
          // The tree may already be gone; the escalation below still runs.
        }
        escalateTimer ??= setTimeout(() => {
          try {
            process.kill(-pid, 'SIGKILL')
          } catch {
            // Already exited.
          }
        }, spec.graceMs)
        escalateTimer.unref?.()
      }
      return {
        pid: child.pid ?? -1,
        done,
        collected: {
          ...(stdout === undefined ? {} : { stdout }),
          ...(stderr === undefined ? {} : { stderr }),
        },
        terminate,
        waitForExit: async (signal?: AbortSignal): Promise<boolean> => {
          if (signal !== undefined) terminate()
          if (signal === undefined) {
            await done
            return true
          }
          const outcome = await Promise.race([
            done.then(() => true as const),
            new Promise<false>((resolve) => {
              const onAbort = (): void => resolve(false)
              if (signal.aborted) onAbort()
              else signal.addEventListener('abort', onAbort, { once: true })
            }),
          ])
          return outcome
        },
      }
    },
  }
}
