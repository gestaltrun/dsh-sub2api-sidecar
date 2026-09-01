/**
 * HTTP client for the sub2api panel/gateway API surface the bootstrap needs.
 * Endpoints and payload shapes follow upstream Wei-Shaw/sub2api
 * (backend/internal/server/routes): login, admin settings admin-api-key
 * regenerate, group management, panel API-key creation, and the two
 * auth-convention probes (`/v1/models` with a gateway key, admin endpoints
 * with an admin key).
 *
 * Every response uses the upstream envelope `{ code, message, data }`; errors
 * carry only the upstream code and message — key material is never included in
 * an error path.
 *
 * @module dsh-sub2api-sidecar/sub2api-client
 */

/** Authenticated caller for admin and panel requests. */
export type Auth =
  | { readonly kind: 'bearer'; readonly token: string }
  | { readonly kind: 'adminKey'; readonly key: string }

/** One group as returned by the admin groups endpoints. */
export interface GroupSummary {
  /** Numeric group id. */
  readonly id: number
  /** Group name. */
  readonly name: string
  /** Group platform (`composite` for the bootstrap group). */
  readonly platform: string
}

/** One model and the capabilities advertised by its group-bound gateway route. */
export interface GatewayModel {
  readonly id: string
  readonly name: string
  readonly contextWindow?: number
  readonly maxTokens?: number
  readonly input?: ReadonlyArray<'text' | 'image'>
  readonly reasoningEfforts?: false | Readonly<Partial<Record<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max', string | null>>>
  readonly defaultReasoningLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

/** Administrator compliance acknowledgement status. */
export interface ComplianceStatus {
  /** Whether an acknowledgement is still owed. */
  readonly required: boolean
  /** The compliance document version upstream enforces. */
  readonly version: string
  /** Compliance document URL, Chinese. */
  readonly documentUrlZh: string | undefined
  /** Compliance document URL, English. */
  readonly documentUrlEn: string | undefined
  /** The exact acknowledgement phrase, Chinese variant. */
  readonly ackPhraseZh: string | undefined
  /** The exact acknowledgement phrase, English variant. */
  readonly ackPhraseEn: string | undefined
}

/** Error raised for a non-success upstream response. */
export class Sub2apiApiError extends Error {
  /** HTTP status of the response. */
  readonly status: number
  /** Upstream error code (`INVALID_ADMIN_KEY`, `UNAUTHORIZED`, …). */
  readonly code: string

  /**
   * @param status - HTTP status.
   * @param code - upstream error code.
   * @param message - upstream message (safe: no credential material).
   */
  constructor(status: number, code: string, message: string) {
    super(`sub2api API error ${status} ${code}: ${message}`)
    this.name = 'Sub2apiApiError'
    this.status = status
    this.code = code
  }

  /** Whether the upstream refused the caller's authorization. */
  get isUnauthorized(): boolean {
    return this.status === 401
  }
}

/** Client dependencies, injectable for tests. */
export interface Sub2apiClientOptions {
  /** Base URL, e.g. `http://127.0.0.1:45123`. */
  readonly baseUrl: string
  /** Request timeout per call; defaults to 10s. */
  readonly timeoutMs?: number
  /** Fetch implementation; defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch
}

/** The subset of the upstream API the bootstrap drives. */
export class Sub2apiClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  /**
   * @param options - base URL, optional timeout and fetch implementation.
   */
  constructor(options: Sub2apiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /**
   * Send one JSON request and unwrap the upstream envelope.
   * @param method - HTTP method.
   * @param path - endpoint path beginning with `/`.
   * @param auth - optional authenticated caller.
   * @param body - optional JSON body.
   * @param headers - extra headers merged after auth headers.
   * @returns the envelope's `data` payload.
   * @throws {@link Sub2apiApiError} for any non-success response.
   */
  private async request<T>(
    method: string,
    path: string,
    auth: Auth | undefined,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const requestHeaders: Record<string, string> = { accept: 'application/json', ...headers }
    if (body !== undefined) requestHeaders['content-type'] = 'application/json'
    if (auth?.kind === 'bearer') requestHeaders['authorization'] = `Bearer ${auth.token}`
    if (auth?.kind === 'adminKey') requestHeaders['x-api-key'] = auth.key
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const payload: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const record = (payload ?? {}) as Record<string, unknown>
      throw new Sub2apiApiError(
        response.status,
        typeof record['code'] === 'string' ? record['code'] : String(record['code'] ?? 'UNKNOWN'),
        typeof record['message'] === 'string' ? record['message'] : response.statusText,
      )
    }
    const record = (payload ?? {}) as Record<string, unknown>
    if (record['code'] !== 0 && record['code'] !== undefined) {
      throw new Sub2apiApiError(
        response.status,
        String(record['code']),
        typeof record['message'] === 'string' ? record['message'] : 'upstream reported failure',
      )
    }
    return record['data'] as T
  }

  /**
   * Read the administrator compliance acknowledgement status (the one admin
   * plane upstream admits before acknowledgement).
   * @param auth - admin JWT or admin key.
   * @returns the status upstream reports.
   */
  async getComplianceStatus(auth: Auth): Promise<ComplianceStatus> {
    const data = await this.request<Record<string, unknown>>('GET', '/api/v1/admin/compliance', auth, undefined)
    return {
      required: data['required'] === true,
      version: typeof data['version'] === 'string' ? data['version'] : '',
      documentUrlZh: typeof data['document_url_zh'] === 'string' ? data['document_url_zh'] : undefined,
      documentUrlEn: typeof data['document_url_en'] === 'string' ? data['document_url_en'] : undefined,
      ackPhraseZh: typeof data['ack_phrase_zh'] === 'string' ? data['ack_phrase_zh'] : undefined,
      ackPhraseEn: typeof data['ack_phrase_en'] === 'string' ? data['ack_phrase_en'] : undefined,
    }
  }

  /**
   * Submit the administrator compliance acknowledgement with the exact
   * phrase upstream issued in its status.
   * @param auth - admin JWT or admin key.
   * @param phrase - the acknowledgement phrase verbatim from the status.
   * @param language - which phrase (`zh` or `en`).
   * @returns the post-acceptance status.
   */
  async acceptCompliance(auth: Auth, phrase: string, language: 'zh' | 'en'): Promise<void> {
    await this.request<unknown>('POST', '/api/v1/admin/compliance/accept', auth, {
      phrase,
      language,
    })
  }

  /**
   * Log in with the AUTO_SETUP admin account and return the access token.
   * @param email - admin account email.
   * @param password - admin account password.
   * @returns the JWT access token.
   * @throws {@link Sub2apiApiError} on refusal (wrong credentials, 2FA required, inactive).
   */
  async login(email: string, password: string): Promise<string> {
    const data = await this.request<Record<string, unknown>>('POST', '/api/v1/auth/login', undefined, {
      email,
      password,
    })
    const token = data['access_token']
    if (typeof token !== 'string' || token.length === 0) {
      throw new Sub2apiApiError(500, 'BAD_LOGIN_RESPONSE', 'login response carries no access_token')
    }
    return token
  }

  /**
   * Regenerate the admin API key; the full `admin-…` key is returned once.
   * @param auth - admin JWT or the current admin key.
   * @returns the new admin key.
   */
  async regenerateAdminApiKey(auth: Auth): Promise<string> {
    const data = await this.request<Record<string, unknown>>(
      'POST', '/api/v1/admin/settings/admin-api-key/regenerate', auth, {},
    )
    const key = data['key']
    if (typeof key !== 'string' || key.length === 0) {
      throw new Sub2apiApiError(500, 'BAD_REGENERATE_RESPONSE', 'regenerate response carries no key')
    }
    return key
  }

  /**
   * Read the admin API key status (used to validate an existing key).
   * @param auth - the admin key under test.
   * @returns existence and masked key as upstream reports them.
   */
  async getAdminApiKeyStatus(auth: Auth): Promise<{ exists: boolean; maskedKey: string }> {
    const data = await this.request<Record<string, unknown>>(
      'GET', '/api/v1/admin/settings/admin-api-key', auth, undefined,
    )
    return {
      exists: data['exists'] === true,
      maskedKey: typeof data['masked_key'] === 'string' ? data['masked_key'] : '',
    }
  }

  /**
   * List all groups, optionally filtered by platform.
   * @param auth - admin JWT or admin key.
   * @param platform - optional platform filter (`composite`).
   * @returns the groups upstream reports.
   */
  async listGroups(auth: Auth, platform?: string): Promise<GroupSummary[]> {
    const query = platform === undefined ? '' : `?platform=${encodeURIComponent(platform)}`
    const data = await this.request<unknown>('GET', `/api/v1/admin/groups/all${query}`, auth, undefined)
    return sanitizeGroups(data)
  }

  /**
   * List the composite routes configured on one group. Fails soft: an
   * unknown endpoint resolves to an empty list, because the derived model
   * catalog is best-effort enrichment over the configured one.
   * @param auth - admin JWT or admin key.
   * @param groupId - the composite group id.
   * @returns the sanitized route entries.
   */
  async listCompositeRoutes(auth: Auth, groupId: number): Promise<Array<{ public_model: string; target_platform: string }>> {
    try {
      const data = await this.request<unknown>('GET', `/api/v1/admin/groups/${String(groupId)}/composite-routes`, auth, undefined)
      const list = Array.isArray(data)
        ? data
        : typeof data === 'object' && data !== null && Array.isArray((data as Record<string, unknown>)['items'])
          ? (data as Record<string, unknown>)['items'] as unknown[]
          : []
      return list.flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null) return []
        const record = entry as Record<string, unknown>
        if (typeof record['public_model'] !== 'string' || record['public_model'].length === 0) return []
        return [{ public_model: record['public_model'], target_platform: typeof record['target_platform'] === 'string' ? record['target_platform'] : '' }]
      })
    } catch {
      return []
    }
  }

  /**
   * List the model ids recorded by successful upstream synchronization for
   * accounts in one group. Accounts without a synchronized metadata snapshot
   * contribute nothing, so configured platform defaults cannot masquerade as
   * subscription capabilities.
   * @param auth - admin JWT or admin key.
   * @param groupId - group whose account mappings define the model set.
   * @returns unique model ids in account order.
   */
  async listGroupAccountModels(auth: Auth, groupId: number): Promise<string[]> {
    const pageSize = 100
    const models = new Set<string>()
    for (let page = 1; ; page += 1) {
      const data = await this.request<unknown>(
        'GET',
        `/api/v1/admin/accounts?page=${String(page)}&page_size=${String(pageSize)}`,
        auth,
        undefined,
      )
      const payload = typeof data === 'object' && data !== null ? data as Record<string, unknown> : {}
      const items = Array.isArray(payload['items']) ? payload['items'] : []
      for (const entry of items) {
        if (typeof entry !== 'object' || entry === null) continue
        const account = entry as Record<string, unknown>
        if (!accountGroupIds(account).includes(groupId)) continue
        const extra = plainRecord(account['extra'])
        const snapshot = plainRecord(extra?.['upstream_model_metadata'])
        const snapshotModels = plainRecord(snapshot?.['models'])
        for (const modelId of Object.keys(snapshotModels ?? {})) {
          if (modelId.length > 0) models.add(modelId)
        }
      }
      const total = positiveInteger(payload['total'])
      if (items.length < pageSize || (total !== undefined && page * pageSize >= total)) break
    }
    return [...models]
  }

  /**
   * Create a group.
   * @param auth - admin JWT or admin key.
   * @param input - name, description, platform, and rate multiplier.
   * @returns the created group.
   */
  async createGroup(
    auth: Auth,
    input: { name: string; description: string; platform: string; rateMultiplier: number },
  ): Promise<GroupSummary> {
    const data = await this.request<Record<string, unknown>>('POST', '/api/v1/admin/groups', auth, {
      name: input.name,
      description: input.description,
      platform: input.platform,
      rate_multiplier: input.rateMultiplier,
    })
    const id = typeof data['id'] === 'number' ? data['id'] : Number(data['id'])
    if (!Number.isInteger(id)) {
      throw new Sub2apiApiError(500, 'BAD_GROUP_RESPONSE', 'create-group response carries no numeric id')
    }
    return {
      id,
      name: typeof data['name'] === 'string' ? data['name'] : input.name,
      platform: typeof data['platform'] === 'string' ? data['platform'] : input.platform,
    }
  }

  /**
   * Create a panel API key bound to a group; the full `sk-…` key is returned once.
   * @param auth - the owner's JWT (the admin account's).
   * @param input - key name and owning group id.
   * @returns the new inference key.
   */
  async createApiKey(auth: Auth, input: { name: string; groupId: number }): Promise<string> {
    const data = await this.request<Record<string, unknown>>('POST', '/api/v1/keys', auth, {
      name: input.name,
      group_id: input.groupId,
    })
    const key = data['key']
    if (typeof key !== 'string' || key.length === 0) {
      throw new Sub2apiApiError(500, 'BAD_KEY_RESPONSE', 'create-key response carries no key')
    }
    return key
  }

  /**
   * Probe the gateway with a candidate `sk-` key (`GET /v1/models`), which
   * upstream authenticates without billing enforcement.
   * @param key - the inference key under test.
   * @returns true when the gateway accepts the key.
   */
  async gatewayKeyValid(key: string): Promise<boolean> {
    try {
      await this.request<unknown>('GET', '/v1/models',
        { kind: 'bearer', token: key }, undefined)
      return true
    } catch (error) {
      if (error instanceof Sub2apiApiError && error.isUnauthorized) return false
      throw error
    }
  }

  /**
   * Read the model catalog the inference key can actually serve.
   * @param key - the group-bound inference key.
   * @returns unique model ids in gateway order.
   */
  async listGatewayModels(key: string): Promise<GatewayModel[]> {
    const data = await this.request<unknown>('GET', '/v1/models',
      { kind: 'bearer', token: key }, undefined)
    if (!Array.isArray(data)) throw new Error('sub2api gateway model list carries no data array')
    const seen = new Set<string>()
    return data.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return []
      const record = entry as Record<string, unknown>
      const id = record['id']
      if (typeof id !== 'string' || id.length === 0 || seen.has(id)) return []
      seen.add(id)
      return [gatewayModel(record, id)]
    })
  }

  /**
   * Probe an admin endpoint with a candidate key. The upstream convention is
   * that only the settings-stored `admin-` key authenticates here, so a
   * gateway `sk-` key must be refused with 401.
   * @param key - the key to send as `x-api-key`.
   * @returns the HTTP status the admin endpoint answered.
   */
  async adminEndpointStatus(key: string): Promise<number> {
    try {
      await this.request<unknown>('GET', '/api/v1/admin/settings/admin-api-key',
        { kind: 'adminKey', key }, undefined)
      return 200
    } catch (error) {
      if (error instanceof Sub2apiApiError) return error.status
      throw error
    }
  }
}

const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
type GatewayReasoningLevel = typeof REASONING_LEVELS[number]

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function accountGroupIds(account: Record<string, unknown>): number[] {
  const direct = Array.isArray(account['group_ids']) ? account['group_ids'] : []
  const nested = Array.isArray(account['groups'])
    ? account['groups'].map(group => plainRecord(group)?.['id'])
    : []
  return [...direct, ...nested]
    .map(value => typeof value === 'number' ? value : Number(value))
    .filter(id => Number.isInteger(id))
}

function gatewayReasoningLevel(value: unknown): GatewayReasoningLevel | undefined {
  const normalized = value === 'none' ? 'off' : value === 'ultra' ? 'max' : value
  return typeof normalized === 'string' && REASONING_LEVELS.some(level => level === normalized)
    ? normalized as GatewayReasoningLevel
    : undefined
}

function gatewayReasoning(record: Record<string, unknown>): Pick<GatewayModel, 'reasoningEfforts' | 'defaultReasoningLevel'> {
  if (record['reasoning'] === false) return { reasoningEfforts: false }
  if (record['reasoning'] !== true || !Array.isArray(record['supported_reasoning_levels'])) return {}
  const efforts: Partial<Record<GatewayReasoningLevel, string | null>> = {}
  for (const raw of record['supported_reasoning_levels']) {
    const level = gatewayReasoningLevel(raw)
    if (level === undefined || Object.hasOwn(efforts, level)) continue
    efforts[level] = level === 'off' ? null : typeof raw === 'string' ? raw : level
  }
  if (Object.keys(efforts).length === 0) return {}
  const defaultReasoningLevel = gatewayReasoningLevel(record['default_reasoning_level'])
  return {
    reasoningEfforts: efforts,
    ...(defaultReasoningLevel !== undefined && Object.hasOwn(efforts, defaultReasoningLevel)
      ? { defaultReasoningLevel }
      : {}),
  }
}

function gatewayModel(record: Record<string, unknown>, id: string): GatewayModel {
  const contextWindow = positiveInteger(record['context_window'])
  const maxTokens = positiveInteger(record['max_output_tokens'])
  const modalities = Array.isArray(record['input_modalities'])
    ? [...new Set(record['input_modalities'].filter((value): value is 'text' | 'image' => value === 'text' || value === 'image'))]
    : []
  const displayName = record['display_name'] ?? record['name']
  return {
    id,
    name: typeof displayName === 'string' && displayName.length > 0 ? displayName : id,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(modalities.length === 0 ? {} : { input: modalities }),
    ...gatewayReasoning(record),
  }
}

/**
 * Normalize the groups payload, accepting either a bare array or an
 * `{ items: [...] }` wrapper.
 * @param data - the envelope data.
 * @returns the sanitized group summaries.
 */
function sanitizeGroups(data: unknown): GroupSummary[] {
  const list = Array.isArray(data)
    ? data
    : typeof data === 'object' && data !== null && Array.isArray((data as Record<string, unknown>)['items'])
      ? (data as Record<string, unknown>)['items'] as unknown[]
      : []
  const groups: GroupSummary[] = []
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const id = typeof record['id'] === 'number' ? record['id'] : Number(record['id'])
    if (!Number.isInteger(id)) continue
    groups.push({
      id,
      name: typeof record['name'] === 'string' ? record['name'] : '',
      platform: typeof record['platform'] === 'string' ? record['platform'] : '',
    })
  }
  return groups
}
