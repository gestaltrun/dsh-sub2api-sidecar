/**
 * The quota snapshot service against a fake sidecar admin API: platform-tier
 * mapping (remote-probed endpoints vs local-derived fields), explicit
 * unavailability when the sidecar is down or upstream fails, retention of
 * `lastSuccessAt` and stale-but-labeled data, and refresh after recovery.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { QuotaSnapshotService } from '../src/quota-snapshot.ts'
import { FakeCredentials, FakeLogger } from './helpers/world.ts'
import { okEnvelope, startFakeAdminApi } from './helpers/fake-admin-api.ts'
import type { FakeAdminApi, FakeRoute } from './helpers/fake-admin-api.ts'

const ADMIN_KEY = 'admin-test-fedcba9876543210'

const servers: FakeAdminApi[] = []
const tempRoots: string[] = []

afterAll(async () => {
  for (const server of servers) await server.close()
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })))
})

/** Upstream-shaped account records for the four tier scenarios. */
const ACCOUNTS: Record<string, unknown>[] = [
  {
    id: 1, name: 'codex-oauth', platform: 'openai', type: 'oauth', status: 'active', schedulable: true,
    credentials: { account_mode: 'oauth' },
  },
  {
    id: 2, name: 'claude-pro', platform: 'anthropic', type: 'oauth', status: 'active', schedulable: true,
    rate_limit_reset_at: '2026-08-28T12:00:00.000Z',
    session_window_status: 'active', session_window_start: '2026-08-28T10:00:00.000Z', session_window_end: '2026-08-28T15:00:00.000Z',
  },
  {
    id: 3, name: 'kimi-coding', platform: 'kimi', type: 'apikey', status: 'active', schedulable: true,
    credentials: { account_mode: 'coding' },
  },
  {
    id: 4, name: 'deepseek-payg', platform: 'deepseek', type: 'apikey', status: 'active', schedulable: true,
    credentials: { account_mode: 'payg' },
    quota_limit: 120, quota_used: 30, quota_daily_limit: 40, quota_daily_used: 10,
  },
  {
    id: 5, name: 'gemini-vertex', platform: 'gemini', type: 'service_account', status: 'error', schedulable: false,
    overload_until: '2026-08-28T09:30:00.000Z',
  },
]

/** The quota endpoint answers the preseeded fixtures serve. */
function quotaRoutes(): Record<string, FakeRoute> {
  return {
    'GET /api/v1/admin/openai/accounts/1/quota': okEnvelope({
      allowed: true,
      limit_reached: false,
      primary_window: { limit_name: 'gpt-5 codex', used_percent: 42.5, limit_window_seconds: 18_000, reset_after_seconds: 600, reset_at: 1_854_000_000_000 },
      secondary_window: { limit_name: 'weekly', used_percent: 12, limit_window_seconds: 604_800, reset_after_seconds: 86_400, reset_at: 1_854_080_000_000 },
    }),
    'GET /api/v1/admin/cn-providers/accounts/3/quota': okEnvelope({
      provider: 'kimi', source: 'coding-plan', success: true, credential_valid: true,
      tiers: [
        { window: '5h', used_percent: 66, reset_at: '2026-08-28T14:00:00Z' },
        { window: 'weekly', used_percent: 21, reset_at: '2026-09-01T00:00:00Z' },
      ],
      plan_level: 'pro', fetched_at: 1_854_000_000_000, persisted: true,
    }),
    'GET /api/v1/admin/cn-providers/accounts/4/balance': okEnvelope({
      provider: 'deepseek', success: true, balance: 88.4, currency: 'CNY', available: true, fetched_at: 1_854_000_000_000, persisted: true,
    }),
  }
}

/** One started service against a fresh fake admin API. */
async function useService(options: { accounts?: Record<string, unknown>[]; failAdmin?: boolean } = {}): Promise<{
  service: QuotaSnapshotService
  sidecar: FakeAdminApi
  credentials: FakeCredentials
  logger: FakeLogger
  dispose(): Promise<void>
}> {
  const sidecar = await startFakeAdminApi({ adminKey: ADMIN_KEY })
  servers.push(sidecar)
  for (const [key, route] of Object.entries(quotaRoutes())) sidecar.setRoute(key, route)
  sidecar.setRoute('GET /api/v1/admin/accounts', okEnvelope({ items: options.accounts ?? ACCOUNTS, total: (options.accounts ?? ACCOUNTS).length, page: 1, page_size: 100, pages: 1 }))
  if (options.failAdmin === true) sidecar.failAdmin(true)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sidecar-quota-'))
  tempRoots.push(root)
  const credentials = new FakeCredentials()
  credentials.store.set('SUB2API_ADMIN_API_KEY', ADMIN_KEY)
  const logger = new FakeLogger()
  const config = resolveConfig({
    runtimeDir: path.join(root, 'runtime'),
    portRange: { min: sidecar.port, max: sidecar.port },
    proxy: { timeoutMs: 2_000 },
    quotaPollMs: 25,
  }, { DSH_HOME: root })
  const service = new QuotaSnapshotService({
    config,
    credentials,
    logger,
    sidecar: { port: sidecar.port },
  })
  service.start()
  return {
    service,
    sidecar,
    credentials,
    logger,
    dispose(): Promise<void> { return service.dispose() },
  }
}

/** Wait until the predicate holds or the budget expires. */
async function until(predicate: () => boolean, budgetMs = 3_000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached within budget')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('platform tier mapping', () => {
  it('maps remote-probed endpoints and local-derived fields into one ready snapshot', { timeout: 15_000 }, async () => {
    const fixture = await useService()
    await until(() => fixture.service.snapshot().status === 'ready')
    const snapshot = fixture.service.snapshot()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.reason).toBeUndefined()
    expect(snapshot.lastSuccessAt).toBe(snapshot.generatedAt)
    expect(snapshot.sidecarPort).toBe(fixture.sidecar.port)
    expect(snapshot.accounts).toHaveLength(5)

    const byId = new Map(snapshot.accounts.map((account) => [account.id, account]))

    // openai: remote-probed windows from primary/secondary.
    const openai = byId.get(1)?.quota as { tier: string; source: string; windows?: Array<{ name?: string; usedPercent?: number }> }
    expect(openai.tier).toBe('remote-probed')
    expect(openai.source).toBe('openai-quota')
    expect(openai.windows?.map((window) => window.usedPercent)).toEqual([42.5, 12])

    // anthropic: local-derived rate-limit and session-window fields.
    const anthropic = byId.get(2)?.quota as { tier: string; rateLimitResetAt?: string; sessionWindow?: { status?: string } }
    expect(anthropic.tier).toBe('local-derived')
    expect(anthropic.rateLimitResetAt).toBe('2026-08-28T12:00:00.000Z')
    expect(anthropic.sessionWindow?.status).toBe('active')

    // kimi coding: remote-probed rolling windows; no balance call for coding mode.
    const kimi = byId.get(3)?.quota as { tier: string; source: string; windows?: Array<{ name?: string; usedPercent?: number }> }
    expect(kimi.tier).toBe('remote-probed')
    expect(kimi.source).toBe('cn-quota')
    expect(kimi.windows?.map((window) => window.name)).toEqual(['5h', 'weekly'])

    // deepseek payg: remote balance; the local apiQuota fields are not probed
    // remotely, but the balance endpoint is authoritative for payg.
    const deepseek = byId.get(4)?.quota as { tier: string; source: string; balance?: { amount?: number; currency?: string } }
    expect(deepseek.tier).toBe('remote-probed')
    expect(deepseek.source).toBe('cn-balance')
    expect(deepseek.balance).toEqual({ amount: 88.4, currency: 'CNY' })

    // gemini: local-derived from the overload field only.
    const gemini = byId.get(5)?.quota as { tier: string; overloadUntil?: string }
    expect(gemini.tier).toBe('local-derived')
    expect(gemini.overloadUntil).toBe('2026-08-28T09:30:00.000Z')

    // The poller authenticated with the injected key and read the lite list.
    const listCall = fixture.sidecar.requests.find((request) => request.path.startsWith('/api/v1/admin/accounts'))
    expect(listCall?.headers['x-api-key']).toBe(ADMIN_KEY)

    await fixture.dispose()
  })

  it('keeps credential-shaped upstream fields out of the snapshot', { timeout: 15_000 }, async () => {
    const fixture = await useService({
      accounts: [{
        id: 9, name: 'leaky', platform: 'anthropic', type: 'oauth', status: 'active', schedulable: true,
        credentials: { api_key: 'sk-super-secret', account_mode: 'x' }, extra: { internal: 'noise' },
      }],
    })
    await until(() => fixture.service.snapshot().status === 'ready')
    const text = JSON.stringify(fixture.service.snapshot())
    expect(text).not.toContain('sk-super-secret')
    expect(text).not.toContain('internal')
    await fixture.dispose()
  })
})

describe('explicit unavailability', () => {
  it('is unavailable with a reason before the first successful poll', { timeout: 15_000 }, async () => {
    const fixture = await useService()
    const initial = fixture.service.snapshot()
    expect(initial.status).toBe('unavailable')
    expect(initial.reason).toBe('no-poll-yet')
    expect(initial.accounts).toEqual([])
    expect(initial.lastSuccessAt).toBeUndefined()
    await fixture.dispose()
  })

  it('marks the snapshot unavailable when the sidecar is not running', { timeout: 15_000 }, async () => {
    const sidecar = await startFakeAdminApi({ adminKey: ADMIN_KEY })
    servers.push(sidecar)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sidecar-quota-'))
    tempRoots.push(root)
    const credentials = new FakeCredentials()
    credentials.store.set('SUB2API_ADMIN_API_KEY', ADMIN_KEY)
    const config = resolveConfig({ runtimeDir: path.join(root, 'runtime'), quotaPollMs: 25 }, { DSH_HOME: root })
    const service = new QuotaSnapshotService({
      config,
      credentials,
      logger: new FakeLogger(),
      sidecar: { port: undefined },
    })
    service.start()
    await until(() => service.snapshot().reason === 'sidecar-not-ready')
    expect(service.snapshot().status).toBe('unavailable')
    expect(service.snapshot().sidecarPort).toBeUndefined()
    expect(service.snapshot().accounts).toEqual([])
    await service.dispose()
  })

  it('degrades to unavailable with the stale data retained and lastSuccessAt intact, then refreshes on recovery', { timeout: 15_000 }, async () => {
    const fixture = await useService()
    await until(() => fixture.service.snapshot().status === 'ready')
    const ready = fixture.service.snapshot()
    expect(ready.accounts).toHaveLength(5)

    fixture.sidecar.failAdmin(true)
    await until(() => fixture.service.snapshot().status === 'unavailable')
    const degraded = fixture.service.snapshot()
    expect(degraded.reason).toBe('accounts-list-failed')
    expect(degraded.generatedAt >= (ready.generatedAt ?? '')).toBe(true)
    expect(degraded.lastSuccessAt).toBe(ready.lastSuccessAt)
    // Stale but labeled: the previous data is retained, never emptied.
    expect(degraded.accounts).toHaveLength(5)
    expect(fixture.logger.lines.some((line) => line.includes('quota poll failed'))).toBe(true)

    fixture.sidecar.failAdmin(false)
    await until(() => fixture.service.snapshot().status === 'ready')
    const recovered = fixture.service.snapshot()
    expect(recovered.reason).toBeUndefined()
    expect((recovered.lastSuccessAt ?? '') > (ready.lastSuccessAt ?? '')).toBe(true)
    await fixture.dispose()
  })

  it('degrades when the admin key disappears from the store', { timeout: 15_000 }, async () => {
    const fixture = await useService()
    await until(() => fixture.service.snapshot().status === 'ready')
    // Unprovision the credential: the next cycle must refuse to fake success.
    fixture.credentials.store.delete('SUB2API_ADMIN_API_KEY')
    await until(() => fixture.service.snapshot().reason === 'admin-key-unavailable')
    expect(fixture.service.snapshot().status).toBe('unavailable')
    expect(fixture.service.snapshot().accounts).toHaveLength(5)
    await fixture.dispose()
  })
})

describe('per-account probe failures', () => {
  it('records the error on the account without failing the whole poll', { timeout: 15_000 }, async () => {
    const fixture = await useService()
    // Break one account's endpoint.
    fixture.sidecar.setRoute('GET /api/v1/admin/openai/accounts/1/quota', { status: 500, body: { code: 'UPSTREAM_DOWN', message: 'x' } })
    await until(() => fixture.service.snapshot().status === 'ready')
    const snapshot = fixture.service.snapshot()
    expect(snapshot.status).toBe('ready')
    const openai = snapshot.accounts.find((account) => account.id === 1)?.quota as { tier: string; error?: string }
    expect(openai.tier).toBe('remote-probed')
    expect(openai.error).toContain('UPSTREAM_DOWN')
    expect(snapshot.accounts).toHaveLength(5)
    await fixture.dispose()
  })
})
