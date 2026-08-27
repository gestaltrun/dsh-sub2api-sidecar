/**
 * sub2api server process: environment assembly and managed spawn. The server
 * runs in the foreground with `RUN_MODE=simple`, binds 127.0.0.1 only, and
 * reads its durable config from `$DATA_DIR/config.yaml`, which its own
 * AUTO_SETUP writes on first boot; the environment passed here overrides the
 * file on every boot (upstream viper `AutomaticEnv`), so runtime values like
 * the database port never go stale across restarts.
 *
 * @module dsh-sub2api-sidecar/sub2api-process
 */

import type { SubprocessHandleLike, SubprocessService } from './seam.ts'

/** Bounded in-memory tail for the server's stdout/stderr diagnostics. */
const SERVER_STREAM_TAIL_BYTES = 16_384

/** Whole-stream spill cap per stream; the spill file location is the subprocess implementation's. */
const SERVER_STREAM_SPILL_BYTES = 4_194_304

/** Facts the child environment is assembled from. */
export interface ServerEnvInput {
  /** sub2api DATA_DIR (config.yaml, .installed). */
  readonly dataDir: string
  /** Loopback port for the server. */
  readonly serverPort: number
  /** PostgreSQL endpoint the supervisor started. */
  readonly postgres: { readonly port: number }
  /** Redis endpoint sub2api should use. */
  readonly redis: { readonly host: string; readonly port: number }
  /** AUTO_SETUP admin credentials (first boot only upstream). */
  readonly admin: { readonly email: string; readonly password: string }
}

/**
 * Assemble the child environment: only what sub2api needs, on top of the
 * implementation's scrubbed parent base. Every value here is runtime-owned;
 * no harness credential or ambient `DSH_*` fact is forwarded.
 * @param input - endpoint and admin facts.
 * @returns the explicit environment entries for the spawn spec.
 */
export function buildServerEnv(input: ServerEnvInput): Record<string, string> {
  return {
    RUN_MODE: 'simple',
    DATA_DIR: input.dataDir,
    AUTO_SETUP: 'true',
    SERVER_HOST: '127.0.0.1',
    SERVER_PORT: String(input.serverPort),
    DATABASE_HOST: '127.0.0.1',
    DATABASE_PORT: String(input.postgres.port),
    DATABASE_USER: 'postgres',
    DATABASE_PASSWORD: 'sub2api-sidecar',
    DATABASE_DBNAME: 'sub2api',
    DATABASE_SSLMODE: 'disable',
    REDIS_HOST: input.redis.host,
    REDIS_PORT: String(input.redis.port),
    ADMIN_EMAIL: input.admin.email,
    ADMIN_PASSWORD: input.admin.password,
  }
}

/**
 * Spawn the sub2api server as a managed child. stdin is closed immediately;
 * both output streams are bounded-collected with a spill file (location owned
 * by the subprocess implementation), so post-mortem diagnostics survive
 * bounded memory.
 * @param subprocess - the host subprocess seam.
 * @param argv - the resolved server argv (`[<bin/sub2api>]`).
 * @param cwd - working directory for the child (the run directory).
 * @param env - the explicit environment entries.
 * @param graceMs - terminate escalation grace.
 * @param signal - abort signal terminating the tree on fire.
 * @returns the owned child handle.
 */
export function startSub2api(
  subprocess: SubprocessService,
  argv: readonly string[],
  cwd: string,
  env: Record<string, string>,
  graceMs: number,
  signal: AbortSignal | undefined,
): SubprocessHandleLike {
  return subprocess.spawn({
    argv: [...argv],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: SERVER_STREAM_TAIL_BYTES, spill: { maxBytes: SERVER_STREAM_SPILL_BYTES } },
      stderr: { maxBytes: SERVER_STREAM_TAIL_BYTES, spill: { maxBytes: SERVER_STREAM_SPILL_BYTES } },
    },
    graceMs,
    signal,
    env,
  })
}
