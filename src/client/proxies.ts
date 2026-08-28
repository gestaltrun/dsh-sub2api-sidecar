/**
 * Data layer of the proxy panel (console v1.2 S6): the typed admin-plane
 * calls the proxy-management UI makes. Same transport posture as
 * {@link composite-routes} — every call goes to the host-relative admin
 * proxy where the management key is injected host-side, and the upstream
 * `{ code, message, data }` envelope unwraps into data or an `Error`
 * carrying upstream's message.
 *
 * Upstream's account add/edit form reads this same proxies table for its
 * 代理 dropdown, so a proxy created here is selectable there without any
 * iframe refresh.
 *
 * @module dsh-sub2api-sidecar/client/proxies
 */

import { ADMIN_API } from './composite-routes.ts'

/** Proxy protocols upstream accepts. */
export const PROXY_PROTOCOLS = ['http', 'https', 'socks5', 'socks5h'] as const

/** One proxy protocol. */
export type ProxyProtocol = (typeof PROXY_PROTOCOLS)[number]

/** Fallback modes upstream accepts (`none`/`direct`/`proxy` + backup id). */
export const FALLBACK_MODES = ['none', 'direct', 'proxy'] as const

/** One fallback mode. */
export type FallbackMode = (typeof FALLBACK_MODES)[number]

/** One saved proxy, as the list endpoint returns it. */
export interface Proxy {
  readonly id: number
  readonly name: string
  readonly protocol: ProxyProtocol
  readonly host: string
  readonly port: number
  readonly username: string
  readonly status: string
  readonly expires_at: string | null
  readonly fallback_mode: string
  readonly backup_proxy_id: number | null
  readonly expiry_warn_days: number
  readonly account_count?: number
  readonly latency_ms?: number | null
  readonly latency_status?: string
  readonly latency_message?: string
  readonly ip_address?: string
  readonly country?: string
  readonly region?: string
  readonly city?: string
}

/** The create/update payload of one proxy (form shape, pre-transform). */
export interface ProxyDraft {
  readonly name: string
  readonly protocol: ProxyProtocol
  readonly host: string
  readonly port: number
  readonly username: string
  readonly password: string
  /** Whether the password goes into the update payload (edit-only; create always sends it). */
  readonly changePassword: boolean
  /** ISO `yyyy-mm-dd` from the date input; empty means no expiry. */
  readonly expiresAt: string
  readonly fallbackMode: FallbackMode
  readonly backupProxyId: number | null
  readonly expiryWarnDays: number
}

/** The test-connection answer. */
export interface ProxyTestResult {
  readonly success: boolean
  readonly message: string
  readonly latency_ms?: number
  readonly ip_address?: string
  readonly country?: string
  readonly region?: string
  readonly city?: string
}

/** The quality-check answer (only the fields the panel displays). */
export interface ProxyQualityResult {
  readonly score: number
  readonly grade: string
  readonly summary: string
}

/** The empty draft the add form starts from (mirrors upstream's defaults). */
export function emptyProxyDraft(): ProxyDraft {
  return {
    name: '',
    protocol: 'http',
    host: '',
    port: 8080,
    username: '',
    password: '',
    changePassword: false,
    expiresAt: '',
    fallbackMode: 'none',
    backupProxyId: null,
    expiryWarnDays: 7,
  }
}

/** The draft one saved proxy edits into; the password stays empty until 修改密码 is checked. */
export function proxyDraftOf(proxy: Proxy): ProxyDraft {
  return {
    name: proxy.name,
    protocol: proxy.protocol,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    password: '',
    changePassword: false,
    expiresAt: proxy.expires_at === null ? '' : proxy.expires_at.slice(0, 10),
    fallbackMode: (FALLBACK_MODES as readonly string[]).includes(proxy.fallback_mode) ? proxy.fallback_mode as FallbackMode : 'none',
    backupProxyId: proxy.backup_proxy_id,
    expiryWarnDays: proxy.expiry_warn_days,
  }
}

/** The list endpoint's paginated payload. */
interface ProxyList {
  readonly items?: readonly Proxy[]
}

/** The standard upstream envelope. */
interface Envelope<T> {
  readonly code?: number
  readonly message?: string
  readonly data?: T
}

/**
 * Unwrap one upstream envelope, throwing an `Error` with upstream's message
 * on HTTP failure or a non-zero code.
 * @param request - the in-flight request.
 * @returns the envelope's `data`.
 */
async function unwrap<T>(request: Promise<Response>): Promise<T> {
  const response = await request
  const envelope = (await response.json().catch(() => ({}))) as Envelope<T>
  if (!response.ok || (typeof envelope.code === 'number' && envelope.code !== 0)) {
    throw new Error(envelope.message ?? `HTTP ${String(response.status)}`)
  }
  return envelope.data as T
}

/** Translate one form draft into upstream's create/update payload. */
function payloadOf(draft: ProxyDraft, editing: boolean): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: draft.name.trim(),
    protocol: draft.protocol,
    host: draft.host.trim(),
    port: draft.port,
    username: draft.username.trim() === '' ? null : draft.username.trim(),
    expires_at: draft.expiresAt === '' ? null : Math.floor(new Date(draft.expiresAt).getTime() / 1000),
    fallback_mode: draft.fallbackMode,
    backup_proxy_id: draft.fallbackMode === 'proxy' ? draft.backupProxyId : null,
    expiry_warn_days: draft.expiryWarnDays,
  }
  // Create always sends the password; update sends it only when the
  // 修改密码 toggle is on, so an untouched edit keeps the stored secret.
  if (!editing || draft.changePassword) {
    payload['password'] = draft.password.trim() === '' ? null : draft.password.trim()
  }
  return payload
}

/**
 * List proxies (one page, generous size; the panel filters client-side).
 * @param fetchImpl - fetch implementation; defaults to globalThis.fetch.
 * @returns the saved proxies.
 */
export async function listProxies(fetchImpl: typeof fetch = fetch): Promise<Proxy[]> {
  const list = await unwrap<ProxyList>(fetchImpl(`${ADMIN_API}/proxies?page=1&page_size=200`, {
    headers: { accept: 'application/json' },
  }))
  return [...(list.items ?? [])]
}

/**
 * Create one proxy.
 * @param draft - the form draft.
 * @param fetchImpl - fetch implementation; defaults to globalThis.fetch.
 * @returns the saved proxy.
 */
export async function createProxy(draft: ProxyDraft, fetchImpl: typeof fetch = fetch): Promise<Proxy> {
  return await unwrap<Proxy>(fetchImpl(`${ADMIN_API}/proxies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payloadOf(draft, false)),
  }))
}

/**
 * Update one proxy; the password rides along only when the draft's
 * 修改密码 toggle is on.
 * @param id - the proxy id.
 * @param draft - the form draft.
 * @param fetchImpl - fetch implementation; defaults to globalThis.fetch.
 * @returns the saved proxy.
 */
export async function updateProxy(id: number, draft: ProxyDraft, fetchImpl: typeof fetch = fetch): Promise<Proxy> {
  return await unwrap<Proxy>(fetchImpl(`${ADMIN_API}/proxies/${String(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payloadOf(draft, true)),
  }))
}

/**
 * Delete one proxy. Upstream refuses with a binding error when accounts
 * still reference it; the message propagates unchanged.
 * @param id - the proxy id.
 * @param fetchImpl - fetch implementation; defaults to globalThis.fetch.
 */
export async function deleteProxy(id: number, fetchImpl: typeof fetch = fetch): Promise<void> {
  await unwrap<unknown>(fetchImpl(`${ADMIN_API}/proxies/${String(id)}`, { method: 'DELETE' }))
}

/**
 * Test one proxy's connectivity.
 * @param id - the proxy id.
 * @param fetchImpl - fetch implementation; defaults to globalThis.fetch.
 * @returns the test outcome.
 */
export async function testProxy(id: number, fetchImpl: typeof fetch = fetch): Promise<ProxyTestResult> {
  return await unwrap<ProxyTestResult>(fetchImpl(`${ADMIN_API}/proxies/${String(id)}/test`, { method: 'POST' }))
}

/**
 * Run upstream's quality check on one proxy.
 * @param id - the proxy id.
 * @param fetchImpl - fetch implementation; defaults to globalThis.fetch.
 * @returns the quality outcome.
 */
export async function checkProxyQuality(id: number, fetchImpl: typeof fetch = fetch): Promise<ProxyQualityResult> {
  return await unwrap<ProxyQualityResult>(fetchImpl(`${ADMIN_API}/proxies/${String(id)}/quality-check`, { method: 'POST' }))
}
