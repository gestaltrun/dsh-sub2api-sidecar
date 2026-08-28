/**
 * Data layer of the composite-route panel (console v1.2 S3): the typed
 * admin-plane calls the route-management UI makes. Every call goes to the
 * host-relative admin proxy (`/plugins/dsh-sub2api/admin/*`), where the
 * management key is injected host-side — the renderer never holds a
 * credential. The upstream answers carry the standard
 * `{ code, message, data }` envelope; {@link unwrap} turns a non-zero code
 * or HTTP failure into an `Error` carrying upstream's message.
 *
 * The composite group id is resolved by listing groups and picking the
 * first `platform === "composite"` entry; callers cache the result.
 *
 * @module dsh-sub2api-sidecar/client/composite-routes
 */

/** Host-relative admin plane; the injection proxy answers it same-origin with no client key. */
export const ADMIN_API = '/plugins/dsh-sub2api/admin'

/** Route match kinds upstream accepts (`oneof`-validated). */
export const MATCH_TYPES = ['exact', 'prefix'] as const

/** One route match kind. */
export type MatchType = (typeof MATCH_TYPES)[number]

/** Route endpoint scopes upstream accepts (`oneof`-validated). */
export const ENDPOINTS = ['any', 'messages', 'responses', 'chat_completions', 'embeddings', 'images', 'gemini'] as const

/** One endpoint scope. */
export type Endpoint = (typeof ENDPOINTS)[number]

/** Target platforms upstream accepts (`oneof`-validated). */
export const PLATFORMS = ['anthropic', 'openai', 'gemini', 'antigravity', 'grok', 'kimi', 'zhipu', 'deepseek'] as const

/** One target platform. */
export type Platform = (typeof PLATFORMS)[number]

/** One saved composite route, as upstream persists it. */
export interface CompositeRoute {
  readonly id: number
  readonly group_id: number
  readonly public_model: string
  readonly match_type: MatchType
  readonly target_platform: Platform
  readonly upstream_model: string
  readonly endpoint: Endpoint
  readonly priority: number
  readonly enabled: boolean
  readonly notes: string
}

/** The create/update payload of one composite route. */
export interface RouteDraft {
  readonly public_model: string
  readonly match_type: MatchType
  readonly target_platform: Platform
  readonly upstream_model: string
  readonly endpoint: Endpoint
  readonly priority: number
  readonly enabled: boolean
  readonly notes: string
}

/** The preview answer: the resolution one public model would get. */
export interface RoutePreview {
  readonly matched: boolean
  readonly source: string
  readonly target_platform: string
  readonly upstream_model: string
  readonly endpoint: string
  readonly reason?: string
}

/** The empty draft the add form starts from (mirrors upstream's defaults). */
export function emptyRouteDraft(): RouteDraft {
  return {
    public_model: '',
    match_type: 'exact',
    target_platform: 'openai',
    upstream_model: '',
    endpoint: 'any',
    priority: 100,
    enabled: true,
    notes: '',
  }
}

/** The draft one saved route edits into. */
export function draftOf(route: CompositeRoute): RouteDraft {
  return {
    public_model: route.public_model,
    match_type: route.match_type,
    target_platform: route.target_platform,
    upstream_model: route.upstream_model,
    endpoint: route.endpoint,
    priority: route.priority,
    enabled: route.enabled,
    notes: route.notes,
  }
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

/** The group list's paginated payload. */
interface GroupList {
  readonly items?: readonly { readonly id: number; readonly platform: string }[]
}

/**
 * Resolve the composite group's id: the first group whose platform is
 * `composite`.
 * @param fetchImpl - fetch implementation; defaults to globalThis.fetch.
 * @returns the group id.
 * @throws when no composite group exists.
 */
export async function resolveCompositeGroupId(fetchImpl: typeof fetch = fetch): Promise<number> {
  const list = await unwrap<GroupList>(fetchImpl(`${ADMIN_API}/groups?page=1&page_size=100`, {
    headers: { accept: 'application/json' },
  }))
  const composite = list.items?.find((group) => group.platform === 'composite')
  if (composite === undefined) throw new Error('no composite group exists')
  return composite.id
}

/**
 * List the composite group's saved routes.
 * @param groupId - the composite group id.
 * @param fetchImpl - fetch implementation; defaults to globalThis.fetch.
 * @returns the saved routes.
 */
export async function listRoutes(groupId: number, fetchImpl: typeof fetch = fetch): Promise<CompositeRoute[]> {
  return await unwrap<CompositeRoute[]>(fetchImpl(`${ADMIN_API}/groups/${String(groupId)}/composite-routes`, {
    headers: { accept: 'application/json' },
  }))
}

/**
 * Create one route.
 * @param groupId - the composite group id.
 * @param draft - the route payload.
 * @param fetchImpl - fetch implementation; defaults to globalThis.fetch.
 * @returns the saved route.
 */
export async function createRoute(groupId: number, draft: RouteDraft, fetchImpl: typeof fetch = fetch): Promise<CompositeRoute> {
  return await unwrap<CompositeRoute>(fetchImpl(`${ADMIN_API}/groups/${String(groupId)}/composite-routes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(draft),
  }))
}

/**
 * Replace one route.
 * @param groupId - the composite group id.
 * @param routeId - the route id.
 * @param draft - the route payload.
 * @param fetchImpl - fetch implementation; defaults to globalThis.fetch.
 * @returns the saved route.
 */
export async function updateRoute(groupId: number, routeId: number, draft: RouteDraft, fetchImpl: typeof fetch = fetch): Promise<CompositeRoute> {
  return await unwrap<CompositeRoute>(fetchImpl(`${ADMIN_API}/groups/${String(groupId)}/composite-routes/${String(routeId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(draft),
  }))
}

/**
 * Delete one route.
 * @param groupId - the composite group id.
 * @param routeId - the route id.
 * @param fetchImpl - fetch implementation; defaults to globalThis.fetch.
 */
export async function deleteRoute(groupId: number, routeId: number, fetchImpl: typeof fetch = fetch): Promise<void> {
  await unwrap<unknown>(fetchImpl(`${ADMIN_API}/groups/${String(groupId)}/composite-routes/${String(routeId)}`, {
    method: 'DELETE',
  }))
}

/**
 * Preview how one public model resolves under the group's routes.
 * @param groupId - the composite group id.
 * @param model - the public model to resolve.
 * @param endpoint - the endpoint scope to resolve under.
 * @param fetchImpl - fetch implementation; defaults to globalThis.fetch.
 * @returns the resolution.
 */
export async function previewRoute(groupId: number, model: string, endpoint: Endpoint, fetchImpl: typeof fetch = fetch): Promise<RoutePreview> {
  return await unwrap<RoutePreview>(fetchImpl(`${ADMIN_API}/groups/${String(groupId)}/composite-routes/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, endpoint }),
  }))
}
