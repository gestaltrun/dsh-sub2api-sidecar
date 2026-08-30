/**
 * Runtime layout resolution and directory preparation: the binary pack
 * directory is read-only and replaceable on upgrade, while all mutable state
 * lives under `data/` (sub2api DATA_DIR, PostgreSQL cluster) and `run/`
 * (logs, sockets, supervisor state, the persisted admin password). `dispose`
 * stops processes but never deletes either directory.
 *
 * @module dsh-sub2api-sidecar/layout
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { SidecarConfig } from './config.ts'

/** Resolved on-disk layout for one supervisor instance. */
export interface Layout {
  /** Root of the sidecar's mutable state (`runtimeDir`). */
  readonly runtimeDir: string
  /** sub2api DATA_DIR and PostgreSQL cluster parent; survives dispose. */
  readonly dataDir: string
  /** PostgreSQL cluster directory (`<dataDir>/pg`). */
  readonly pgDataDir: string
  /** Ephemeral runtime files; survives dispose, contents do not matter. */
  readonly runDir: string
  /** Unpacked runtime pack directory (bin/, lib/, share/). */
  readonly binaryDir: string
  /** Pack executables this supervisor needs. */
  readonly bin: {
    /** sub2api server binary. */
    readonly sub2api: string
    /** PostgreSQL cluster initialization tool. */
    readonly initdb: string
    /** PostgreSQL foreground server owned by the subprocess seam. */
    readonly postgres: string
    /** Optional redis-server; absent means the pack does not carry one. */
    readonly redis: string
  }
  /** Supervisor state files (no secrets). */
  readonly stateFile: string
  /** Persisted admin password file (0600); the only secret the plugin owns on disk. */
  readonly adminPasswordFile: string
  /** Marker written when the bundled redis-server was skipped by configuration. */
  readonly redisSkipMarker: string
  /** sub2api stdout/stderr spill file. */
  readonly sub2apiLog: string
  /** PostgreSQL collector log file. */
  readonly postgresLog: string
  /** redis log file written by the launcher. */
  readonly redisLog: string
}

/**
 * Resolve the layout from config; no filesystem access.
 * @param config - the resolved plugin configuration.
 * @returns the layout paths.
 */
export function resolveLayout(config: SidecarConfig): Layout {
  const dataDir = path.join(config.runtimeDir, 'data')
  const runDir = path.join(config.runtimeDir, 'run')
  return {
    runtimeDir: config.runtimeDir,
    dataDir,
    pgDataDir: path.join(dataDir, 'pg'),
    runDir,
    binaryDir: config.binaryDir,
    bin: {
      sub2api: path.join(config.binaryDir, 'bin', 'sub2api'),
      initdb: path.join(config.binaryDir, 'bin', 'initdb'),
      postgres: path.join(config.binaryDir, 'bin', 'postgres'),
      redis: path.join(config.binaryDir, 'bin', 'redis-server'),
    },
    stateFile: path.join(runDir, 'supervisor-state.json'),
    adminPasswordFile: path.join(runDir, 'admin-password'),
    redisSkipMarker: path.join(runDir, 'redis.skipped.json'),
    sub2apiLog: path.join(runDir, 'sub2api.log'),
    postgresLog: path.join(runDir, 'postgres.log'),
    redisLog: path.join(runDir, 'redis.log'),
  }
}

/**
 * Create the mutable directories and verify the binary pack is present.
 * The data and run directories get 0700: the run directory holds the admin
 * password file and the data directory holds the database cluster.
 * @param layout - the resolved layout.
 * @throws when the pack directory does not carry the required executables.
 */
export async function prepareLayout(layout: Layout): Promise<void> {
  await fs.mkdir(layout.dataDir, { recursive: true, mode: 0o700 })
  await fs.mkdir(layout.runDir, { recursive: true, mode: 0o700 })
  const required: ReadonlyArray<[string, string]> = [
    ['sub2api', layout.bin.sub2api],
    ['initdb', layout.bin.initdb],
    ['postgres', layout.bin.postgres],
  ]
  for (const [name, filePath] of required) {
    await fs.access(filePath, fs.constants.X_OK).catch(() => {
      throw new Error(
        `dsh-sub2api-sidecar: runtime pack at ${layout.binaryDir} is missing a runnable bin/${name}`
          + ' — unpack the runtime pack archive or point config.binaryDir at it',
      )
    })
  }
}

/**
 * Detect the darwin redis placeholder shipped by the runtime pack. The stub is
 * a shell script whose banner names pack-sources.lock.json; a real redis-server
 * is a binary that never contains the banner in its first bytes.
 * @param redisPath - path of the pack's bin/redis-server.
 * @returns whether the file is the loud stub.
 */
export async function isRedisStub(redisPath: string): Promise<boolean> {
  const handle = await fs.open(redisPath, 'r').catch(() => null)
  if (!handle) return false
  try {
    const buffer = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).includes('Redis placeholder')
  } finally {
    await handle.close()
  }
}
