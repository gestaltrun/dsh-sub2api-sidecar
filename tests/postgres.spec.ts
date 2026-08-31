import { describe, expect, it, vi } from 'vitest'
import { startPostgres } from '../src/postgres.ts'
import type { SubprocessHandleLike, SubprocessService } from '../src/seam.ts'

describe('startPostgres', () => {
  it('includes bounded stderr when postgres exits before readiness', async () => {
    const handle: SubprocessHandleLike = {
      pid: 42,
      done: Promise.resolve({ exitCode: 1, signal: null }),
      collected: {
        stderr: {
          readFrom: () => ({
            text: 'FATAL: lock file "postmaster.pid" already exists\n',
            nextOffset: 51,
            lossy: false,
          }),
        },
      },
      terminate: vi.fn(),
      waitForExit: vi.fn(async () => true),
    }
    const subprocess: SubprocessService = { spawn: vi.fn(() => handle) }

    await expect(startPostgres(subprocess, {
      postgresPath: '/runtime/bin/postgres',
      pgDataDir: '/data/pg',
      logPath: '/run/postgres.log',
      socketDir: '/run',
      graceMs: 100,
      startupTimeoutMs: 100,
    }, 1, undefined)).rejects.toThrow(
      'postgres exited before readiness (code 1, signal null)\nFATAL: lock file "postmaster.pid" already exists',
    )
  })
})
