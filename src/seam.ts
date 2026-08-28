/**
 * Structural types for the DeepSeek Harness service seams this plugin
 * consumes. The plugin is loaded by the harness Loader, which provides the
 * real `@deepseek-ai/dsh-subprocess`, `@deepseek-ai/dsh-credentials`,
 * `@deepseek-ai/dsh-settings`, and `@deepseek-ai/dsh-host-webserver`
 * services; these local interfaces pin the exact member subset the supervisor
 * and the host-half services call so this package builds and tests
 * standalone without importing the private harness packages.
 *
 * @module dsh-sub2api-sidecar/seam
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** A harness context logger (`ctx.logger`): printf-style formatting. */
export interface LoggerLike {
  /** Log an informational line. */
  info(formatter: string, ...args: unknown[]): void
  /** Log a warning line. */
  warn(formatter: string, ...args: unknown[]): void
  /** Log an error line. */
  error(formatter: string, ...args: unknown[]): void
}

/** Bounded in-memory collection for one child output stream. */
export interface SubprocessCollect {
  /** In-memory cap in bytes; overflow keeps the TAIL. */
  maxBytes: number
  /** Full-stream spill file; absent disables spilling. */
  spill?: {
    /** Whole-stream byte cap; a larger stream discards its spill. */
    maxBytes: number
  }
}

/** stdout/stderr disposition for one spawned child. */
export type SubprocessOutputMode = 'pipe' | 'inherit' | SubprocessCollect

/** Offset-based incremental read of one collected stream. */
export interface SubprocessOutputReader {
  /**
   * Read everything captured since `fromByte`.
   * @param fromByte - whole-stream offset to resume from (0 for the first read).
   * @returns the delta text, the next offset, and whether the tail window was exceeded.
   */
  readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean }
}

/** Exit facts of one closed child process. */
export interface SubprocessOutcome {
  /** Exit code; null when the process died from a signal. */
  exitCode: number | null
  /** Terminating signal; null on normal exit. */
  signal: string | null
}

/** A live child process owned by the subprocess service. */
export interface SubprocessHandleLike {
  /** Process id (tree root); -1 when the spawn itself failed. */
  readonly pid: number
  /** Resolves at process close; rejects only for spawn-level failures. */
  readonly done: Promise<SubprocessOutcome>
  /** Readers for collect-mode streams, readable after exit. */
  readonly collected: {
    readonly stdout?: SubprocessOutputReader
    readonly stderr?: SubprocessOutputReader
  }
  /**
   * Begin the SIGTERM → grace → SIGKILL escalation on the process tree.
   * Idempotent; also triggered by the spawn spec's abort signal.
   */
  terminate(): void
  /**
   * Wait until the whole process tree exited.
   * @param signal - optional bound for the wait.
   * @returns true when the tree exited, false when the signal aborted first.
   */
  waitForExit(signal?: AbortSignal): Promise<boolean>
}

/** A fully specified spawn request, mirroring the dsh-subprocess spec shape. */
export interface SubprocessSpawnSpec {
  /** Executable and arguments; `argv[0]` is the program. Never shell-interpreted. */
  argv: readonly string[]
  /** Working directory for the child. */
  cwd: string
  /** Per-stream stdio dispositions. */
  stdio: {
    stdin: 'ignore' | 'pipe' | { readonly data: string }
    stdout: SubprocessOutputMode
    stderr: SubprocessOutputMode
  }
  /** Positive finite grace period for terminate escalation and pipe draining. */
  graceMs: number
  /** Abort signal starting the terminate escalation on the process tree. */
  signal?: AbortSignal | undefined
  /** Explicit environment entries merged onto the implementation's scrubbed base. */
  env?: NodeJS.ProcessEnv | undefined
}

/** The `ctx.subprocess` seam subset the supervisor uses. */
export interface SubprocessService {
  /**
   * Start one managed child process from a fully-specified spec.
   * @param spec - argv, directory, stdio dispositions, grace, cancellation, environment.
   * @returns the live process handle.
   */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandleLike
}

/** One resolved credential value and its source layer. */
export interface ResolvedCredential {
  /** The non-empty secret value. */
  value: string
  /** Provider-defined source layer id. */
  source: string
}

/** The `ctx.credentials` seam subset the supervisor uses. */
export interface CredentialsService {
  /**
   * Resolve one reference to its current value.
   * @param ref - POSIX-identifier credential reference.
   * @returns the value and source, or undefined while unconfigured.
   */
  resolve(ref: string): Promise<ResolvedCredential | undefined>
  /**
   * Durably store one value under the provider's 0600 semantics.
   * @param ref - POSIX-identifier credential reference.
   * @param value - the non-empty secret value.
   */
  set(ref: string, value: string): Promise<void>
}

/** The `ctx.settings` seam subset the supervisor uses. */
export interface SettingsService {
  /**
   * Merge a partial patch into a namespace's user layer and persist it.
   * @param namespace - registered settings namespace (e.g. `llm-pi-ai`).
   * @param patch - plain-object patch over the user section.
   */
  update(namespace: string, patch: object): Promise<void>
  /**
   * Read one registered namespace's resolved value (schema defaults, then the
   * registrant's composition `base`, then the user layer).
   * @param namespace - registered settings namespace.
   * @returns the resolved section, or `undefined` while the namespace is unregistered.
   */
  get(namespace: string): unknown
}

/** Route match kind: `exact` matches the pathname verbatim; `prefix` matches the pathname and anything below it. */
export type WebRouteKind = 'exact' | 'prefix'

/** One HTTP route registration on the host web server. */
export interface WebRoute {
  /** How `path` matches the request pathname. */
  kind: WebRouteKind
  /** Absolute pathname without a trailing slash. */
  path: string
  /**
   * Own the full response lifecycle of every matched request.
   * @param req - the accepted request.
   * @param res - the response to answer.
   */
  handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
}

/** The `ctx.webServer` seam subset the host-half services use. */
export interface WebServerService {
  /**
   * Register one named route.
   * @param route - kind, path, and the owning handler.
   * @returns the disposer removing the route.
   */
  register(route: WebRoute): () => void
  /** The listened port; present once the host server is initialized. */
  readonly port?: number
  /** The configured bind host; present once the host server is initialized. */
  readonly host?: '127.0.0.1' | '0.0.0.0'
}

/** The service seams plus logger the supervisor needs from the host context. */
export interface Seams {
  /** Managed child-process seam (`ctx.subprocess`). */
  readonly subprocess: SubprocessService
  /** Credential-reference seam (`ctx.credentials`). */
  readonly credentials: CredentialsService
  /** User-settings seam (`ctx.settings`). */
  readonly settings: SettingsService
  /** Host logger (`ctx.logger`). */
  readonly logger: LoggerLike
}
