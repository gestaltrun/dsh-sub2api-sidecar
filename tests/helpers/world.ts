/**
 * Fixture builder: assemble a fake runtime pack (bin/sub2api wrapper, initdb,
 * foreground postgres, optional real-behaving or stub redis-server), a fake context
 * (in-memory credentials + settings + recording logger), and the resolved
 * config the tests run with.
 *
 * @module tests/helpers/world
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../../src/config.ts'
import type { SidecarConfig } from '../../src/config.ts'
import type { CredentialsService, LoggerLike, SettingsService, SubprocessService } from '../../src/seam.ts'
import { FakeWebServer } from './fake-webserver.ts'
import { makeSubprocessService } from './subprocess-local.ts'

const helpersDir = path.dirname(fileURLToPath(import.meta.url))

/** In-memory credentials service double. */
export class FakeCredentials implements CredentialsService {
  readonly store = new Map<string, string>()
  readonly setCalls: Array<{ ref: string; value: string }> = []

  async resolve(ref: string): Promise<{ value: string; source: string } | undefined> {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'test' }
  }

  async set(ref: string, value: string): Promise<void> {
    this.setCalls.push({ ref, value })
    this.store.set(ref, value)
  }
}

/** Recording settings service double. */
export class FakeSettings implements SettingsService {
  readonly updates: Array<{ namespace: string; patch: Record<string, unknown> }> = []
  /** Pre-seeded resolved sections served by {@link get}, keyed by namespace. */
  readonly sections: Record<string, unknown> = {}

  async update(namespace: string, patch: object): Promise<void> {
    this.updates.push({ namespace, patch: patch as Record<string, unknown> })
    // Simulate the real service's persistence so a later get() observes the
    // committed user layer: top-level keys merge, `providers` merges per key.
    const current = (this.sections[namespace] ?? {}) as Record<string, unknown>
    const merged: Record<string, unknown> = { ...current }
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      if (key === 'providers' && typeof value === 'object' && value !== null) {
        merged[key] = {
          ...((current[key] ?? {}) as Record<string, unknown>),
          ...(value as Record<string, unknown>),
        }
      } else {
        merged[key] = value
      }
    }
    this.sections[namespace] = merged
  }

  get(namespace: string): unknown {
    return this.sections[namespace]
  }
}

/** Recording logger double; every line is kept for secret-leak assertions. */
export class FakeLogger implements LoggerLike {
  readonly lines: string[] = []

  info(formatter: string, ...args: unknown[]): void {
    this.lines.push(`INFO ${formatter.replace(/%[sd]/g, () => String(args.shift()))}`)
  }

  warn(formatter: string, ...args: unknown[]): void {
    this.lines.push(`WARN ${formatter.replace(/%[sd]/g, () => String(args.shift()))}`)
  }

  error(formatter: string, ...args: unknown[]): void {
    this.lines.push(`ERROR ${formatter.replace(/%[sd]/g, () => String(args.shift()))}`)
  }
}

/** One assembled test world. */
export interface World {
  /** Temp root holding runtimeDir and the fake pack. */
  readonly root: string
  /** Fake state dir shared by the fake processes. */
  readonly stateDir: string
  /** Resolved config pointing at the fake pack. */
  readonly config: SidecarConfig
  /** The raw config to feed `apply` so it resolves to this world's paths. */
  readonly rawConfig: Record<string, unknown>
  /** Real local subprocess provider. */
  readonly subprocess: SubprocessService
  readonly credentials: FakeCredentials
  readonly settings: FakeSettings
  readonly logger: FakeLogger
  /** Listening web server seam double the plugin registers routes on. */
  readonly webServer: FakeWebServer
  /** Plugin-context effect registry: returns the registered disposers. */
  readonly effects: Array<() => () => unknown>
  /** Register an effect the way the cordis context would. */
  effect(execute: () => () => unknown): () => unknown
  /** Dispose everything the world allocated. */
  dispose(): Promise<void>
}

/** Options for building a world. */
export interface WorldOptions {
  /** Port scan range; tests use disjoint ranges to run reliably side by side. */
  portRange?: { min: number; max: number }
  /** Write a redis-server stub (loud placeholder) instead of a working fake. */
  redisStub?: boolean
  /** Omit bin/redis-server entirely. */
  omitRedis?: boolean
  /** Make initdb fail. */
  initdbFails?: boolean
  /** Make the fake sub2api health endpoint fail. */
  healthFails?: boolean
  /** Delay the fake sub2api SIGTERM handler before it records shutdown. */
  shutdownDelayMs?: number
  /** Arm the fake upstream's administrator compliance gate (423 until acknowledged). */
  complianceRequired?: boolean
  /** Config overrides layered onto the defaults. */
  configOverrides?: Partial<Parameters<typeof resolveConfig>[0]> & { adminPassword?: string }
}

/**
 * Build one test world.
 * @param options - fixture switches.
 * @returns the world handle.
 */
export async function createWorld(options: WorldOptions = {}): Promise<World> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sidecar-world-'))
  const stateDir = path.join(root, 'state')
  await fs.mkdir(stateDir, { recursive: true })
  const binDir = path.join(root, 'pack', 'bin')
  await fs.mkdir(binDir, { recursive: true })
  const node = process.execPath

  const runtimeDir = path.join(root, 'runtime-home', 'sub2api')
  // A random scan range per world keeps parallel fixtures and leftovers from
  // earlier runs off each other's ports.
  const rangeBase = 30_000 + Math.floor(Math.random() * 20_000)
  const portRange = options.portRange ?? {
    min: rangeBase,
    max: Math.min(rangeBase + 99, 65_000),
  }
  const rawConfig = {
    runtimeDir,
    binaryDir: path.join(root, 'pack'),
    portRange,
    healthTimeoutMs: 15_000,
    healthPollMs: 50,
    stopGraceMs: 2_000,
    adminEmail: 'admin@sub2api.local',
    adminPassword: 'test-password',
    credentials: {
      adminRef: 'SUB2API_ADMIN_API_KEY',
      inferenceRef: 'SUB2API_API_KEY',
    },
    ...options.configOverrides,
  }
  const config = resolveConfig(rawConfig, { DSH_HOME: path.join(root, 'runtime-home') })

  await fs.writeFile(path.join(binDir, 'sub2api'), [
    '#!/bin/sh',
    // The fake's own fixtures ride in the wrapper: state dir and accepted
    // admin credentials. The supervisor's explicit env (REDIS_*, SERVER_*,
    // ADMIN_*) is merged on top by the child process itself.
    `FAKE_STATE_DIR='${stateDir}' \\`,
    ...(options.healthFails === true ? ["FAKE_HEALTH='fail' \\"] : []),
    ...(options.shutdownDelayMs === undefined
      ? []
      : [`FAKE_SHUTDOWN_DELAY_MS='${String(options.shutdownDelayMs)}' \\`]),
    `FAKE_ADMIN_EMAIL='${config.adminEmail}' \\`,
    `FAKE_ADMIN_PASSWORD='${config.adminPassword}' \\`,
    ...(options.complianceRequired === true ? ["FAKE_COMPLIANCE='required' \\"] : []),
    `exec '${node}' '${path.join(helpersDir, 'fake-sub2api.mjs')}'`,
    '',
  ].join('\n'), { mode: 0o755 })

  const initdbExit = options.initdbFails === true ? 1 : 0
  await fs.writeFile(path.join(binDir, 'initdb'), `#!/bin/sh
echo "initdb $*" >> '${stateDir}/initdb-calls.log'
if [ '${String(initdbExit)}' != '0' ]; then
  echo "initdb: directory creation failed" >&2
  exit 1
fi
pgdata=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-D" ]; then pgdata="$arg"; fi
  prev="$arg"
done
mkdir -p "$pgdata"
echo 17 > "$pgdata/PG_VERSION"
exit 0
`, { mode: 0o755 })

  await fs.writeFile(path.join(binDir, 'postgres'), [
    '#!/bin/sh',
    `FAKE_STATE_DIR='${stateDir}' \\`,
    `exec '${node}' '${path.join(helpersDir, 'fake-postgres.mjs')}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 })

  if (options.omitRedis !== true) {
    if (options.redisStub === true) {
      await fs.writeFile(path.join(binDir, 'redis-server'), `#!/bin/sh
echo "redis-server: NOT INCLUDED in this runtime pack (darwin-arm64)." >&2
echo "Redis darwin distribution is an open TODO: pack-sources.lock.json sources.redis.status=todo-unresolved-darwin." >&2
echo "Redis placeholder for this runtime pack (platform: darwin-arm64)." >&2
exit 78
`, { mode: 0o755 })
    } else {
      await fs.writeFile(path.join(binDir, 'redis-server'), [
        '#!/bin/sh',
        `FAKE_STATE_DIR='${stateDir}' \\`,
        `exec '${node}' '${path.join(helpersDir, 'fake-redis.mjs')}' "$@"`,
        '',
      ].join('\n'), { mode: 0o755 })
    }
  }

  const subprocess = makeSubprocessService()
  const credentials = new FakeCredentials()
  const settings = new FakeSettings()
  const logger = new FakeLogger()
  const webServer = new FakeWebServer()
  await webServer.listen()
  const effects: Array<() => () => unknown> = []

  return {
    root,
    stateDir,
    config,
    rawConfig: rawConfig as Record<string, unknown>,
    subprocess,
    credentials,
    settings,
    logger,
    webServer,
    effects,
    effect(execute: () => () => unknown): () => unknown {
      effects.push(execute)
      return execute
    },
    async dispose(): Promise<void> {
      await webServer.close()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

/**
 * Read a text file if it exists, else null.
 * @param filePath - the file to read.
 * @returns the contents or null.
 */
export async function readTextOrNull(filePath: string): Promise<string | null> {
  return fs.readFile(filePath, 'utf8').catch(() => null)
}
