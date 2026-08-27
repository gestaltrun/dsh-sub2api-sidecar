/**
 * Plugin configuration: raw shape, validated resolution with every default
 * applied in one explicit step, and the Standard Schema the Cordis Loader
 * validates the cordis.yml entry config against. Misconfiguration fails here,
 * at load, before any process is started.
 *
 * @module dsh-sub2api-sidecar/config
 */

import { childPath, defineSyncSchema, SchemaError, StandardSchema } from './standard-schema.ts'
import type { SchemaIssue } from './standard-schema.ts'
import { parseAllowedOrigin } from './trust.ts'

/** One hand-declared model on the composite route. */
export interface RouteModel {
  /** Model id sent on the wire and shown to model selectors. */
  id: string
  /** Human-readable name; defaults to the id. */
  name?: string
  /** Context capacity advertised to the harness (default 262144). */
  contextWindow?: number
  /** Output capability advertised to the harness (default 32768). */
  maxTokens?: number
}

/** Raw, user-facing plugin configuration; every field optional. */
export interface RawSidecarConfig {
  /** When false the plugin is inert: no directories, no processes, no settings writes. */
  enabled?: boolean
  /** Root of the sidecar's mutable state; defaults to `$DSH_HOME/sub2api`. */
  runtimeDir?: string
  /** Unpacked runtime pack location; defaults to `<runtimeDir>/runtime`. */
  binaryDir?: string
  /** Loopback port scan range for postgres, redis, and the sub2api server. */
  portRange?: { min?: number; max?: number }
  /** Total budget for the sub2api `/health` poll; first boots run migrations. */
  healthTimeoutMs?: number
  /** Interval between health probes. */
  healthPollMs?: number
  /** Per-process SIGTERM→SIGKILL grace and the pg_ctl stop wait budget. */
  stopGraceMs?: number
  /** AUTO_SETUP admin account email; upstream default `admin@sub2api.local`. */
  adminEmail?: string
  /** Admin account password; when absent a random one is generated and kept in `<runDir>/admin-password` (0600). */
  adminPassword?: string
  /** Composite group settings. */
  group?: { name?: string; description?: string }
  /** The single hand-declared provider route written into `llm-pi-ai`. */
  route?: {
    /** Provider route key in the `llm-pi-ai` providers dict. */
    name?: string
    /** Wire protocol every model on the route speaks. */
    api?: string
    /** Display name for configuration surfaces. */
    displayName?: string
    /** Model list advertised on the route; at least one entry is required. */
    models?: RouteModel[]
  }
  /** Redis placement; the darwin pack ships a loud stub, so darwin needs `skip` plus an external Redis. */
  redis?: {
    /** Skip the bundled redis-server entirely; the skip is recorded under `<runDir>`. */
    skip?: boolean
    /** External Redis for sub2api when skipped or absent from the pack. */
    external?: { host?: string; port?: number }
  }
  /** Credential references the two keys are stored under. */
  credentials?: {
    /** Reference for the `admin-` management key. */
    adminRef?: string
    /** Reference for the `sk-` composite inference key. */
    inferenceRef?: string
  }
  /** Host-side injection forwarding plane. */
  proxy?: {
    /** When false the admin proxy prefix and the snapshot route stay unregistered. */
    enabled?: boolean
    /** Extra absolute origins trusted by the proxy and snapshot routes besides the host's own. */
    allowedOrigins?: string[]
    /** Per-request upstream budget for one forwarded admin call. */
    timeoutMs?: number
  }
  /** Interval between quota snapshot polls of the sidecar admin API. */
  quotaPollMs?: number
}

/** Resolved configuration: every field present, validated, and defaulted. */
export interface SidecarConfig {
  /** When false the plugin is inert. */
  enabled: boolean
  /** Root of the sidecar's mutable state. */
  runtimeDir: string
  /** Unpacked runtime pack location. */
  binaryDir: string
  /** Loopback port scan range, inclusive bounds. */
  portRange: { min: number; max: number }
  /** Total budget for the `/health` poll. */
  healthTimeoutMs: number
  /** Interval between health probes. */
  healthPollMs: number
  /** Per-process SIGTERM→SIGKILL grace and pg_ctl stop wait budget. */
  stopGraceMs: number
  /** AUTO_SETUP admin account email. */
  adminEmail: string
  /** Admin account password; undefined means generate-and-persist under `<runDir>`. */
  adminPassword: string | undefined
  /** Composite group settings. */
  group: { name: string; description: string }
  /** The single hand-declared provider route. */
  route: {
    name: string
    api: string
    displayName: string
    models: Required<RouteModel>[]
  }
  /** Redis placement. */
  redis: {
    skip: boolean
    external: { host: string; port: number } | undefined
  }
  /** Credential references for the two keys. */
  credentials: { adminRef: string; inferenceRef: string }
  /** Host-side injection forwarding plane. */
  proxy: {
    /** When false the admin proxy prefix and the snapshot route stay unregistered. */
    enabled: boolean
    /** Absolute origins trusted besides the host's own, normalized. */
    allowedOrigins: string[]
    /** Per-request upstream budget for one forwarded admin call. */
    timeoutMs: number
  }
  /** Interval between quota snapshot polls. */
  quotaPollMs: number
}

/** Lowest port the default scan range starts at. */
export const DEFAULT_PORT_MIN = 45100

/** Highest port the default scan range ends at. */
export const DEFAULT_PORT_MAX = 45199

/** Default budget for the first-boot health poll; AUTO_SETUP runs migrations. */
export const DEFAULT_HEALTH_TIMEOUT_MS = 120_000

/** Default interval between health probes. */
export const DEFAULT_HEALTH_POLL_MS = 500

/** Default SIGTERM→SIGKILL grace per process and pg_ctl stop wait budget. */
export const DEFAULT_STOP_GRACE_MS = 8_000

/** Default composite group name created in sub2api. */
export const DEFAULT_GROUP_NAME = 'dsh-composite'

/** Default provider route key in the `llm-pi-ai` providers dict. */
export const DEFAULT_ROUTE_NAME = 'sub2api'

/** Default wire protocol of the sub2api gateway's OpenAI-compatible surface. */
export const DEFAULT_ROUTE_API = 'openai-completions'

/** Context capacity advertised for models the route entry does not size. */
export const DEFAULT_MODEL_CONTEXT_WINDOW = 262_144

/** Output capability advertised for models the route entry does not size. */
export const DEFAULT_MODEL_MAX_TOKENS = 32_768

/** Default credential reference for the `admin-` management key. */
export const DEFAULT_ADMIN_CREDENTIAL_REF = 'SUB2API_ADMIN_API_KEY'

/** Default credential reference for the `sk-` composite inference key. */
export const DEFAULT_INFERENCE_CREDENTIAL_REF = 'SUB2API_API_KEY'

/** Default state of the host-side injection forwarding plane. */
export const DEFAULT_PROXY_ENABLED = true

/** Default per-request upstream budget for one forwarded admin call. */
export const DEFAULT_PROXY_TIMEOUT_MS = 30_000

/** Default interval between quota snapshot polls. */
export const DEFAULT_QUOTA_POLL_MS = 60_000

/**
 * The conventional local Redis endpoint. It defaults a configured external
 * endpoint's missing fields and is the target sub2api points at when the
 * bundled component is skipped without an external endpoint.
 */
export const DEFAULT_EXTERNAL_REDIS: { host: string; port: number } = { host: '127.0.0.1', port: 6379 }

/** Reference accepted by the credentials seam: a POSIX shell identifier. */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Provider route key: lowercase letter first so it is also a credential-ref stem. */
const ROUTE_PATTERN = /^[a-z][a-z0-9-]*$/

/** pi-ai wire protocols a hand-declared route may name. */
const ROUTE_APIS = new Set(['openai-completions', 'openai-responses', 'anthropic-messages'])

const DEFAULT_ROUTE_MODELS: readonly RouteModel[] = [
  { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' },
]

/** Validation context threaded through the recursive checks. */
interface ValidateContext {
  readonly issues: SchemaIssue[]
}

/** Record one issue and continue collecting. */
function fail(ctx: ValidateContext, path: ReadonlyArray<PropertyKey>, message: string): void {
  ctx.issues.push({ path, message })
}

/** Assert a value is a plain object, or record an issue and return null. */
function expectObject(
  ctx: ValidateContext,
  path: ReadonlyArray<PropertyKey>,
  value: unknown,
): Record<string, unknown> | null {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(ctx, path, 'must be an object')
    return null
  }
  return value as Record<string, unknown>
}

/** Read a string field, validating emptiness and pattern. */
function expectString(
  ctx: ValidateContext,
  path: ReadonlyArray<PropertyKey>,
  value: unknown,
  pattern?: RegExp,
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    fail(ctx, path, 'must be a non-empty string')
    return undefined
  }
  if (pattern && !pattern.test(value)) {
    fail(ctx, path, `must match ${String(pattern)}`)
    return undefined
  }
  return value
}

/** Read a positive integer field with an optional upper bound. */
function expectPositiveInt(
  ctx: ValidateContext,
  path: ReadonlyArray<PropertyKey>,
  value: unknown,
  max?: number,
): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail(ctx, path, 'must be a positive integer')
    return undefined
  }
  if (max !== undefined && value > max) {
    fail(ctx, path, `must be no greater than ${max}`)
    return undefined
  }
  return value
}

/** Validate one route model entry. */
function validateModel(ctx: ValidateContext, path: ReadonlyArray<PropertyKey>, value: unknown): RouteModel | null {
  const raw = expectObject(ctx, path, value)
  if (!raw) return null
  const id = expectString(ctx, childPath(path, 'id'), raw['id'])
  if (id === undefined) {
    fail(ctx, childPath(path, 'id'), 'is required')
    return null
  }
  const model: RouteModel = { id }
  const name = expectString(ctx, childPath(path, 'name'), raw['name'])
  if (name !== undefined) model.name = name
  const contextWindow = expectPositiveInt(ctx, childPath(path, 'contextWindow'), raw['contextWindow'])
  if (contextWindow !== undefined) model.contextWindow = contextWindow
  const maxTokens = expectPositiveInt(ctx, childPath(path, 'maxTokens'), raw['maxTokens'])
  if (maxTokens !== undefined) model.maxTokens = maxTokens
  return model
}

/** Validate the whole raw config, collecting every issue instead of failing fast. */
function validateRaw(ctx: ValidateContext, path: ReadonlyArray<PropertyKey>, value: unknown): RawSidecarConfig | null {
  const raw = expectObject(ctx, path, value)
  if (!raw) return null

  if (raw['enabled'] !== undefined && typeof raw['enabled'] !== 'boolean') {
    fail(ctx, childPath(path, 'enabled'), 'must be a boolean')
  }
  expectString(ctx, childPath(path, 'runtimeDir'), raw['runtimeDir'])
  expectString(ctx, childPath(path, 'binaryDir'), raw['binaryDir'])
  expectPositiveInt(ctx, childPath(path, 'healthTimeoutMs'), raw['healthTimeoutMs'])
  expectPositiveInt(ctx, childPath(path, 'healthPollMs'), raw['healthPollMs'])
  expectPositiveInt(ctx, childPath(path, 'stopGraceMs'), raw['stopGraceMs'])
  expectString(ctx, childPath(path, 'adminEmail'), raw['adminEmail'])
  expectString(ctx, childPath(path, 'adminPassword'), raw['adminPassword'])

  const portRange = expectObject(ctx, childPath(path, 'portRange'), raw['portRange'])
  if (portRange) {
    expectPositiveInt(ctx, childPath(childPath(path, 'portRange'), 'min'), portRange['min'], 65_535)
    expectPositiveInt(ctx, childPath(childPath(path, 'portRange'), 'max'), portRange['max'], 65_535)
  }

  const group = expectObject(ctx, childPath(path, 'group'), raw['group'])
  if (group) {
    expectString(ctx, childPath(childPath(path, 'group'), 'name'), group['name'])
    expectString(ctx, childPath(childPath(path, 'group'), 'description'), group['description'])
  }

  const route = expectObject(ctx, childPath(path, 'route'), raw['route'])
  if (route) {
    const routePath = childPath(path, 'route')
    expectString(ctx, childPath(routePath, 'name'), route['name'], ROUTE_PATTERN)
    const api = expectString(ctx, childPath(routePath, 'api'), route['api'])
    if (api !== undefined && !ROUTE_APIS.has(api)) {
      fail(ctx, childPath(routePath, 'api'), `must be one of ${[...ROUTE_APIS].join(', ')}`)
    }
    expectString(ctx, childPath(routePath, 'displayName'), route['displayName'])
    const models = route['models']
    if (models !== undefined) {
      if (!Array.isArray(models) || models.length === 0) {
        fail(ctx, childPath(routePath, 'models'), 'must be a non-empty array')
      } else {
        for (const [index, model] of models.entries()) validateModel(ctx, childPath(childPath(routePath, 'models'), index), model)
      }
    }
  }

  const redis = expectObject(ctx, childPath(path, 'redis'), raw['redis'])
  if (redis) {
    const redisPath = childPath(path, 'redis')
    if (redis['skip'] !== undefined && typeof redis['skip'] !== 'boolean') {
      fail(ctx, childPath(redisPath, 'skip'), 'must be a boolean')
    }
    const external = expectObject(ctx, childPath(redisPath, 'external'), redis['external'])
    if (external) {
      expectString(ctx, childPath(childPath(redisPath, 'external'), 'host'), external['host'])
      expectPositiveInt(ctx, childPath(childPath(redisPath, 'external'), 'port'), external['port'], 65_535)
    }
  }

  const credentials = expectObject(ctx, childPath(path, 'credentials'), raw['credentials'])
  if (credentials) {
    const credentialsPath = childPath(path, 'credentials')
    expectString(ctx, childPath(credentialsPath, 'adminRef'), credentials['adminRef'], REF_PATTERN)
    expectString(ctx, childPath(credentialsPath, 'inferenceRef'), credentials['inferenceRef'], REF_PATTERN)
  }

  const proxy = expectObject(ctx, childPath(path, 'proxy'), raw['proxy'])
  if (proxy) {
    const proxyPath = childPath(path, 'proxy')
    if (proxy['enabled'] !== undefined && typeof proxy['enabled'] !== 'boolean') {
      fail(ctx, childPath(proxyPath, 'enabled'), 'must be a boolean')
    }
    const origins = proxy['allowedOrigins']
    if (origins !== undefined) {
      if (!Array.isArray(origins)) {
        fail(ctx, childPath(proxyPath, 'allowedOrigins'), 'must be an array of origin strings')
      } else {
        for (const [index, origin] of origins.entries()) {
          if (typeof origin !== 'string' || origin.length === 0) {
            fail(ctx, childPath(childPath(proxyPath, 'allowedOrigins'), index), 'must be a non-empty string')
          }
        }
      }
    }
    expectPositiveInt(ctx, childPath(proxyPath, 'timeoutMs'), proxy['timeoutMs'])
  }

  expectPositiveInt(ctx, childPath(path, 'quotaPollMs'), raw['quotaPollMs'])

  return raw as RawSidecarConfig
}

/**
 * Resolve the raw config into the fully-defaulted config the supervisor runs
 * with. This is the single defaulting step: nothing downstream applies `??`
 * fallbacks, so what the schema admits is exactly what runs.
 * @param raw - the validated raw config.
 * @param env - process environment; `DSH_HOME` anchors the default runtime dir.
 * @returns the resolved configuration.
 */
export function resolveConfig(raw: RawSidecarConfig, env: NodeJS.ProcessEnv): SidecarConfig {
  if (raw.runtimeDir === undefined && env['DSH_HOME'] === undefined) {
    throw new Error('dsh-sub2api-sidecar: set config.runtimeDir or the DSH_HOME environment variable')
  }
  const runtimeDir = raw.runtimeDir ?? `${env['DSH_HOME']}/sub2api`
  const portRange = {
    min: raw.portRange?.min ?? DEFAULT_PORT_MIN,
    max: raw.portRange?.max ?? DEFAULT_PORT_MAX,
  }
  if (portRange.min > portRange.max) {
    throw new Error(`dsh-sub2api-sidecar: portRange.min (${portRange.min}) must not exceed portRange.max (${portRange.max})`)
  }
  const models: Required<RouteModel>[] = (raw.route?.models ?? DEFAULT_ROUTE_MODELS).map((model) => ({
    id: model.id,
    name: model.name ?? model.id,
    contextWindow: model.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW,
    maxTokens: model.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS,
  }))
  const routeName = raw.route?.name ?? DEFAULT_ROUTE_NAME
  return {
    enabled: raw.enabled ?? true,
    runtimeDir,
    binaryDir: raw.binaryDir ?? `${runtimeDir}/runtime`,
    portRange,
    healthTimeoutMs: raw.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
    healthPollMs: raw.healthPollMs ?? DEFAULT_HEALTH_POLL_MS,
    stopGraceMs: raw.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
    adminEmail: raw.adminEmail ?? 'admin@sub2api.local',
    adminPassword: raw.adminPassword,
    group: {
      name: raw.group?.name ?? DEFAULT_GROUP_NAME,
      description: raw.group?.description ?? 'DeepSeek Harness composite routing group',
    },
    route: {
      name: routeName,
      api: raw.route?.api ?? DEFAULT_ROUTE_API,
      displayName: raw.route?.displayName ?? `Sub2API (${routeName})`,
      models,
    },
    redis: {
      skip: raw.redis?.skip ?? false,
      external: raw.redis?.external
        ? {
            host: raw.redis.external.host ?? DEFAULT_EXTERNAL_REDIS.host,
            port: raw.redis.external.port ?? DEFAULT_EXTERNAL_REDIS.port,
          }
        : undefined,
    },
    credentials: {
      adminRef: raw.credentials?.adminRef ?? DEFAULT_ADMIN_CREDENTIAL_REF,
      inferenceRef: raw.credentials?.inferenceRef ?? DEFAULT_INFERENCE_CREDENTIAL_REF,
    },
    proxy: {
      enabled: raw.proxy?.enabled ?? DEFAULT_PROXY_ENABLED,
      allowedOrigins: (raw.proxy?.allowedOrigins ?? []).map((origin) => {
        try {
          return parseAllowedOrigin(origin)
        } catch {
          throw new Error(`dsh-sub2api-sidecar: proxy.allowedOrigins entry "${origin}" is not a bare http(s) origin`)
        }
      }),
      timeoutMs: raw.proxy?.timeoutMs ?? DEFAULT_PROXY_TIMEOUT_MS,
    },
    quotaPollMs: raw.quotaPollMs ?? DEFAULT_QUOTA_POLL_MS,
  }
}

/** The plugin's `Config` export: Standard Schema v1 over the validator above. */
export const Config: StandardSchema<RawSidecarConfig> = defineSyncSchema<RawSidecarConfig>(
  'dsh-sub2api-sidecar',
  (value) => {
    const ctx: ValidateContext = { issues: [] }
    const raw = validateRaw(ctx, [], value)
    if (!raw || ctx.issues.length > 0) throw new SchemaError(ctx.issues)
    return raw
  },
)
