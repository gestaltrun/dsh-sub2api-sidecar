/**
 * The Host-side quota snapshot service. One poller reads the supervised
 * sidecar's admin API on a configured interval — the accounts list plus each
 * account's platform quota endpoint — and aggregates the result into a single
 * read-only snapshot served on the web server seam for later desktop
 * consumers. The snapshot is a contract, not a proxy: only whitelisted
 * account and quota fields are mapped, so credential-shaped fields from the
 * upstream DTO can never leak into it.
 *
 * Freshness is explicit. A snapshot that was not produced by a fully
 * successful poll is marked `unavailable` with the reason — a sidecar that is
 * down, a missing admin key, or a failed upstream call never yields empty
 * data dressed up as success, and `lastSuccessAt` dates whatever data is
 * retained.
 *
 * Platform tiers follow the frozen spec's 分档 (gestaltrun/deepseek-harness-gestalt#346):
 * `remote-probed` platforms answer from their upstream quota endpoint
 * (openai, grok, and the CN providers kimi/zhipu/deepseek), every other
 * platform is `local-derived` from the account list's own scheduling and
 * quota-limit fields.
 *
 * @module dsh-sub2api-sidecar/quota-snapshot
 */

import { admit } from './trust.ts'
import type { TrustPolicy } from './trust.ts'
import type { SidecarConfig } from './config.ts'
import type { SidecarSource } from './proxy.ts'
import type { CredentialsService, LoggerLike, WebServerService } from './seam.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Host-side pathname of the read-only snapshot route. */
export const QUOTA_SNAPSHOT_PATH = '/plugins/dsh-sub2api/quota-snapshot'

/** Maximum accounts list pages fetched per poll; a page cap bounds one cycle. */
const MAX_SNAPSHOT_PAGES = 10

/** Upstream accounts list page size. */
const ACCOUNTS_PAGE_SIZE = 100

/** One usage window inside a remote-probed quota. */
export interface QuotaWindow {
  /** Window or limit name as upstream reports it. */
  name?: string
  /** Percentage of the window already used (0–100+). */
  usedPercent?: number
  /** When the window resets, as reported upstream. */
  resetsAt?: string
}

/** A monetary balance reported for a pay-as-you-go account. */
export interface QuotaBalance {
  /** Balance amount in `currency` units. */
  amount?: number
  /** Currency code as upstream reports it. */
  currency?: string
}

/** Quota for a `remote-probed` platform: data fetched from the platform's quota endpoint this poll. */
export interface RemoteProbedQuota {
  readonly tier: 'remote-probed'
  /** Which upstream endpoint answered; one of `openai-quota`, `grok-quota`, `cn-quota`, `cn-balance`. */
  readonly source: string
  /** Usage windows; absent when upstream reported none in a mappable field. */
  readonly windows?: QuotaWindow[]
  /** Pay-as-you-go balance; absent for plan-based platforms. */
  readonly balance?: QuotaBalance
  /** Present instead of data when this account's endpoint call failed this poll. */
  readonly error?: string
}

/** Quota for a `local-derived` platform: mapped from the accounts list record. */
export interface LocalDerivedQuota {
  readonly tier: 'local-derived'
  /** When the account's rate limit lifts. */
  readonly rateLimitResetAt?: string
  /** Until when the account is marked overloaded. */
  readonly overloadUntil?: string
  /** The account's session window facts. */
  readonly sessionWindow?: { status?: string; start?: string; end?: string }
  /** Host-side API-key quota accounting fields, when the account carries them. */
  readonly apiQuota?: {
    limit?: number
    used?: number
    daily?: { limit?: number; used?: number }
    weekly?: { limit?: number; used?: number }
  }
}

/** One account's quota view in the snapshot. */
export type AccountQuota = RemoteProbedQuota | LocalDerivedQuota

/** One account row in the snapshot; a strict whitelist of upstream fields. */
export interface SnapshotAccount {
  /** Upstream numeric account id. */
  readonly id: number
  /** Display name. */
  readonly name: string
  /** Platform identifier (`anthropic`, `openai`, `kimi`, …). */
  readonly platform: string
  /** Account type (`oauth`, `apikey`, `setup-token`, …). */
  readonly accountType: string
  /** Upstream account status. */
  readonly status: string
  /** Whether the scheduler currently admits the account. */
  readonly schedulable: boolean
  /** The platform-tier quota view. */
  readonly quota: AccountQuota
}

/** The published snapshot. Consumers must branch on `status` before reading data. */
export interface QuotaSnapshot {
  /** `ready` only after a fully successful poll; otherwise `unavailable`. */
  readonly status: 'ready' | 'unavailable'
  /** Why the snapshot is unavailable; undefined when ready. */
  readonly reason: string | undefined
  /** ISO time this snapshot object was built. */
  readonly generatedAt: string
  /** ISO time of the last fully successful poll; undefined before the first one. */
  readonly lastSuccessAt: string | undefined
  /** The supervised server's loopback port while it runs this poll; undefined when down. The desktop embed uses it for the direct-console fallback link. */
  readonly sidecarPort: number | undefined
  /** Accounts from the last fully successful poll; empty before the first one. */
  readonly accounts: readonly SnapshotAccount[]
}

/** Dependencies of one snapshot service. */
export interface QuotaSnapshotOptions {
  /** Resolved plugin configuration (credentials reference and poll budget). */
  readonly config: SidecarConfig
  /** Credential seam resolving the injected `admin-` key. */
  readonly credentials: CredentialsService
  /** Host logger; receives poll outcomes only. */
  readonly logger: LoggerLike
  /** The live sidecar port source. */
  readonly sidecar: SidecarSource
  /** Fetch implementation; defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch
}

/** Platforms whose quota comes from an upstream quota endpoint. */
const REMOTE_PROBED_PLATFORMS = new Set(['openai', 'grok', 'kimi', 'zhipu', 'deepseek'])

/** Read one poll-fresh snapshot view of the service. */
export class QuotaSnapshotService {
  private current: QuotaSnapshot
  private timer: NodeJS.Timeout | undefined
  private cycle: Promise<void> | undefined
  private stopped = false

  /**
   * @param options - config, seams, the live sidecar source, and an optional fetch implementation.
   */
  constructor(private readonly options: QuotaSnapshotOptions) {
    this.current = {
      status: 'unavailable',
      reason: 'no-poll-yet',
      generatedAt: new Date().toISOString(),
      lastSuccessAt: undefined,
      sidecarPort: options.sidecar.port,
      accounts: [],
    }
  }

  /** Begin polling: one immediate cycle, then one per configured interval. */
  start(): void {
    if (this.timer !== undefined || this.stopped) return
    void this.runCycle()
  }

  /**
   * The latest published snapshot. The returned object is replaced, never
   * mutated, on each poll.
   * @returns the current snapshot.
   */
  snapshot(): QuotaSnapshot {
    return this.current
  }

  /** Stop polling and wait for any in-flight cycle to settle. */
  async dispose(): Promise<void> {
    this.stopped = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    await this.cycle
  }

  /** Run one poll cycle, publish, and schedule the next one. */
  private async runCycle(): Promise<void> {
    const cycle = this.pollOnce()
    this.cycle = cycle
    await cycle.catch(() => {})
    this.cycle = undefined
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.runCycle()
    }, this.options.config.quotaPollMs)
    this.timer.unref()
  }

  /** One poll: readiness, accounts list, per-platform quota, publish. */
  private async pollOnce(): Promise<void> {
    const { config, sidecar, logger } = this.options
    const generatedAt = new Date().toISOString()
    const port = sidecar.port
    if (port === undefined) {
      this.publish('sidecar-not-ready', generatedAt, undefined)
      return
    }
    const credential = await this.options.credentials.resolve(config.credentials.adminRef)
    if (credential === undefined) {
      this.publish('admin-key-unavailable', generatedAt, port)
      return
    }
    let accounts: SnapshotAccount[]
    try {
      accounts = await this.pollAccounts(port, credential.value)
    } catch (error) {
      this.publish('accounts-list-failed', generatedAt, port)
      logger.warn('dsh-sub2api-sidecar: quota poll failed to list accounts (%s)', describe(error))
      return
    }
    this.current = {
      status: 'ready',
      reason: undefined,
      generatedAt,
      lastSuccessAt: generatedAt,
      sidecarPort: port,
      accounts,
    }
    logger.info('dsh-sub2api-sidecar: quota snapshot refreshed with %d accounts', accounts.length)
  }

  /** Replace the published snapshot with an unavailable one, retaining prior data. */
  private publish(reason: string, generatedAt: string, sidecarPort: number | undefined): void {
    this.current = {
      status: 'unavailable',
      reason,
      generatedAt,
      lastSuccessAt: this.current.lastSuccessAt,
      sidecarPort,
      accounts: this.current.accounts,
    }
  }

  /**
   * Fetch the full accounts list (paged) and map every account's quota.
   * @param port - the sidecar's loopback port.
   * @param adminKey - the injected `admin-` key.
   * @returns the mapped snapshot accounts.
   * @throws when any accounts-list page fails.
   */
  private async pollAccounts(port: number, adminKey: string): Promise<SnapshotAccount[]> {
    const fetchImpl = this.options.fetchImpl ?? fetch
    const timeoutMs = this.options.config.proxy.timeoutMs
    const records: Record<string, unknown>[] = []
    for (let page = 1; page <= MAX_SNAPSHOT_PAGES; page++) {
      const data = await adminGet(
        fetchImpl,
        port,
        adminKey,
        `/api/v1/admin/accounts?lite=true&page=${String(page)}&page_size=${String(ACCOUNTS_PAGE_SIZE)}`,
        timeoutMs,
      )
      const items = Array.isArray(data) ? data : asRecord(data)?.['items']
      if (!Array.isArray(items)) throw new Error('accounts payload carries no items array')
      for (const item of items) {
        if (typeof item === 'object' && item !== null) records.push(item as Record<string, unknown>)
      }
      if (items.length < ACCOUNTS_PAGE_SIZE) break
    }
    return Promise.all(records.map(async (record) => mapAccount(record, { fetchImpl, port, adminKey, timeoutMs })))
  }
}

/** Facts the account mapper needs to probe remote quota endpoints. */
export interface ProbeContext {
  /** Fetch implementation for endpoint calls. */
  readonly fetchImpl: typeof fetch
  /** The sidecar's loopback port. */
  readonly port: number
  /** The injected `admin-` key. */
  readonly adminKey: string
  /** Per-call budget in milliseconds. */
  readonly timeoutMs: number
}

/** One upstream admin GET with the injected key; returns the envelope's data. */
async function adminGet(
  fetchImpl: typeof fetch | undefined,
  port: number,
  adminKey: string,
  path: string,
  timeoutMs: number,
): Promise<unknown> {
  const response = await (fetchImpl ?? fetch)(`http://127.0.0.1:${String(port)}${path}`, {
    headers: { accept: 'application/json', 'x-api-key': adminKey },
    signal: AbortSignal.timeout(timeoutMs),
  })
  const payload: unknown = await response.json().catch(() => null)
  const record = (payload ?? {}) as Record<string, unknown>
  if (!response.ok || (record['code'] !== 0 && record['code'] !== undefined)) {
    const code = typeof record['code'] === 'string' ? record['code'] : `HTTP ${String(response.status)}`
    throw new Error(`upstream refused ${path}: ${code}`)
  }
  return record['data']
}

/** Human-safe error text for logs; never carries credential material. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Map one accounts-list record onto a snapshot account, probing the platform
 * quota endpoint when the platform's tier is remote.
 * @param record - the upstream account DTO.
 * @param probe - endpoint-call facts.
 * @returns the snapshot account row.
 */
async function mapAccount(
  record: Record<string, unknown>,
  probe: ProbeContext,
): Promise<SnapshotAccount> {
  const platform = asString(record['platform']) ?? ''
  const quota = REMOTE_PROBED_PLATFORMS.has(platform)
    ? await probeRemoteQuota(record, platform, probe)
    : mapLocalQuota(record)
  return {
    id: typeof record['id'] === 'number' ? record['id'] : Number(record['id']),
    name: asString(record['name']) ?? '',
    platform,
    accountType: asString(record['type']) ?? '',
    status: asString(record['status']) ?? '',
    schedulable: record['schedulable'] === true,
    quota,
  }
}

/** Map the local-derived quota fields of one account record. */
function mapLocalQuota(record: Record<string, unknown>): LocalDerivedQuota {
  const quota: { tier: 'local-derived' } & Record<string, unknown> = { tier: 'local-derived' }
  const rateLimitResetAt = asString(record['rate_limit_reset_at'])
  if (rateLimitResetAt !== undefined) quota['rateLimitResetAt'] = rateLimitResetAt
  const overloadUntil = asString(record['overload_until'])
  if (overloadUntil !== undefined) quota['overloadUntil'] = overloadUntil
  const window = {
    status: asString(record['session_window_status']),
    start: asString(record['session_window_start']),
    end: asString(record['session_window_end']),
  }
  if (window.status !== undefined || window.start !== undefined || window.end !== undefined) {
    quota['sessionWindow'] = window
  }
  const apiQuota: Record<string, unknown> = {}
  const limit = asNumber(record['quota_limit'])
  const used = asNumber(record['quota_used'])
  if (limit !== undefined) apiQuota['limit'] = limit
  if (used !== undefined) apiQuota['used'] = used
  const daily = pair(record, 'quota_daily')
  if (daily !== undefined) apiQuota['daily'] = daily
  const weekly = pair(record, 'quota_weekly')
  if (weekly !== undefined) apiQuota['weekly'] = weekly
  if (Object.keys(apiQuota).length > 0) quota['apiQuota'] = apiQuota
  return quota as unknown as LocalDerivedQuota
}

/** Read a `…_limit`/`…_used` field pair from an account record. */
function pair(record: Record<string, unknown>, stem: string): { limit?: number; used?: number } | undefined {
  const limit = asNumber(record[`${stem}_limit`])
  const used = asNumber(record[`${stem}_used`])
  if (limit === undefined && used === undefined) return undefined
  const out: { limit?: number; used?: number } = {}
  if (limit !== undefined) out['limit'] = limit
  if (used !== undefined) out['used'] = used
  return out
}

/**
 * Probe the remote quota endpoints of one remote-tier account and merge the
 * answers into one quota entry. A failed endpoint records its error instead
 * of data and never fails the poll.
 */
async function probeRemoteQuota(
  record: Record<string, unknown>,
  platform: string,
  probe: ProbeContext,
): Promise<RemoteProbedQuota> {
  const id = typeof record['id'] === 'number' ? String(record['id']) : String(Number(record['id']))
  const endpoints: Array<{ source: string; path: string }> = []
  if (platform === 'openai') endpoints.push({ source: 'openai-quota', path: `/api/v1/admin/openai/accounts/${id}/quota` })
  if (platform === 'grok') endpoints.push({ source: 'grok-quota', path: `/api/v1/admin/grok/accounts/${id}/quota` })
  if (platform === 'kimi' || platform === 'zhipu' || platform === 'deepseek') {
    // account_mode is a non-sensitive enum upstream keeps in the redacted
    // credentials map; it selects the plan window vs. pay-as-you-go endpoint.
    const mode = asString(asRecord(record['credentials'])?.['account_mode'])
    if (mode !== 'payg') endpoints.push({ source: 'cn-quota', path: `/api/v1/admin/cn-providers/accounts/${id}/quota` })
    if (mode !== 'coding' && platform !== 'zhipu') {
      endpoints.push({ source: 'cn-balance', path: `/api/v1/admin/cn-providers/accounts/${id}/balance` })
    }
  }

  const quota: { tier: 'remote-probed'; source: string; windows?: QuotaWindow[]; balance?: QuotaBalance; error?: string } = {
    tier: 'remote-probed',
    source: endpoints.map((endpoint) => endpoint.source).join('+'),
  }
  const windows: QuotaWindow[] = []
  let lastError: string | undefined
  for (const endpoint of endpoints) {
    let payload: unknown
    try {
      payload = await adminGet(probe.fetchImpl, probe.port, probe.adminKey, endpoint.path, probe.timeoutMs)
    } catch (error) {
      lastError = describe(error)
      continue
    }
    mapQuotaPayload(endpoint.source, payload, windows, quota)
  }
  if (windows.length > 0) quota['windows'] = windows
  if (lastError !== undefined && windows.length === 0 && quota['balance'] === undefined) {
    quota['error'] = lastError
  }
  return quota as RemoteProbedQuota
}

/** Map one endpoint payload into the quota entry's windows/balance. */
function mapQuotaPayload(
  source: string,
  payload: unknown,
  windows: QuotaWindow[],
  quota: { windows?: QuotaWindow[]; balance?: QuotaBalance },
): void {
  const record = asRecord(payload)
  if (record === undefined) return
  if (source === 'openai-quota') {
    for (const key of ['primary_window', 'secondary_window']) {
      const window = asRecord(record[key])
      if (window === undefined) continue
      windows.push({
        name: asString(window['limit_name']),
        usedPercent: asNumber(window['used_percent']),
        resetsAt: asString(window['reset_at']),
      })
    }
    return
  }
  if (source === 'grok-quota') {
    const billing = asRecord(record['billing'])
    const usedPercent = asNumber(billing?.['used_percent']) ?? asNumber(billing?.['usage_percent'])
    if (usedPercent !== undefined) {
      windows.push({ name: asString(billing?.['period_type']) ?? 'billing', usedPercent, resetsAt: asString(billing?.['period_end']) })
    }
    const snapshot = asRecord(record['snapshot'])
    for (const key of ['requests', 'tokens']) {
      const window = asRecord(snapshot?.[key])
      const limit = asNumber(window?.['limit'])
      const remaining = asNumber(window?.['remaining'])
      if (window === undefined || limit === undefined || remaining === undefined || limit <= 0) continue
      windows.push({
        name: key,
        usedPercent: ((limit - remaining) / limit) * 100,
        resetsAt: asString(window['reset_at']),
      })
    }
    return
  }
  if (source === 'cn-quota') {
    const tiers = record['tiers']
    if (!Array.isArray(tiers)) return
    for (const tier of tiers) {
      const entry = asRecord(tier)
      if (entry === undefined) continue
      windows.push({
        name: asString(entry['window']),
        usedPercent: asNumber(entry['used_percent']),
        resetsAt: asString(entry['reset_at']),
      })
    }
    return
  }
  if (source === 'cn-balance') {
    const balance = asNumber(record['balance'])
    if (balance !== undefined) {
      quota['balance'] = { amount: balance, currency: asString(record['currency']) }
    }
  }
}

/** Read an optional string field. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Read an optional finite number field. */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Read an optional object field. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Register the read-only snapshot route on the web server seam. The route
 * shares the proxy's admission posture and answers only GET.
 * @param options - the service's options (config and seams).
 * @param webServer - the host web server seam.
 * @param service - the service whose snapshot is served.
 * @returns the route registration disposer.
 */
export function registerQuotaSnapshotRoute(
  options: QuotaSnapshotOptions,
  webServer: WebServerService,
  service: QuotaSnapshotService,
): () => void {
  const policy: TrustPolicy = { allowedOrigins: new Set(options.config.proxy.allowedOrigins) }
  return webServer.register({
    kind: 'exact',
    path: QUOTA_SNAPSHOT_PATH,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      const decision = admit(
        { remoteAddress: req.socket.remoteAddress, origin: req.headers['origin'], host: req.headers['host'] },
        policy,
      )
      if (!decision.allowed) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ code: 'SNAPSHOT_FORBIDDEN', message: 'request is not admitted by the snapshot route' }))
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ code: 'SNAPSHOT_METHOD', message: 'the snapshot route answers GET only' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(service.snapshot()))
    },
  })
}
