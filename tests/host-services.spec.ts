/**
 * Assembled host-half wiring through `apply`: after a real supervised boot
 * the proxy prefix and the snapshot route are registered on the web server
 * seam, the injected key authenticates the embedded console path, the
 * snapshot aggregates the fake's accounts with explicit freshness, and
 * unloading the effects removes the routes.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import type { PluginContext } from '../src/index.ts'
import { QUOTA_SNAPSHOT_PATH } from '../src/quota-snapshot.ts'
import { ADMIN_PROXY_PREFIX } from '../src/proxy.ts'
import { createWorld, readTextOrNull } from './helpers/world.ts'
import type { World } from './helpers/world.ts'

const worlds: World[] = []

afterAll(async () => {
  for (const world of worlds) {
    for (const effect of world.effects) await effect()()
  }
  await new Promise((resolve) => setTimeout(resolve, 200))
  await Promise.all(worlds.map((world) => world.dispose()))
})

/** Register a world for cleanup and return it with a plugin-context view. */
function useWorld(world: World): { world: World; ctx: PluginContext } {
  worlds.push(world)
  return { world, ctx: world as unknown as PluginContext }
}

/** Preseed the fake sub2api's persistent state with accounts and quota routes. */
async function preseedAccounts(stateDir: string): Promise<void> {
  await fs.writeFile(path.join(stateDir, 'fake-sub2api-state.json'), `${JSON.stringify({
    adminKey: null,
    jwt: null,
    groups: [],
    keys: [],
    regenerateCount: 0,
    loginCount: 0,
    accounts: [
      {
        id: 1, name: 'claude-pro', platform: 'anthropic', type: 'oauth', status: 'active', schedulable: true,
        rate_limit_reset_at: '2026-08-28T12:00:00.000Z',
        session_window_status: 'active',
      },
      {
        id: 2, name: 'kimi-coding', platform: 'kimi', type: 'apikey', status: 'active', schedulable: true,
        credentials: { account_mode: 'coding' },
      },
    ],
    quotaRoutes: {
      '/api/v1/admin/cn-providers/accounts/2/quota': {
        provider: 'kimi', source: 'coding-plan', success: true, credential_valid: true,
        tiers: [{ window: '5h', used_percent: 33, reset_at: '2026-08-28T14:00:00Z' }],
        fetched_at: 1_854_000_000_000, persisted: true,
      },
    },
  }, null, 2)}\n`)
}

describe('assembled host services', () => {
  it('serves the injected admin proxy and the quota snapshot after a real boot', { timeout: 60_000 }, async () => {
    const { world, ctx } = useWorld(await createWorld({
      configOverrides: { quotaPollMs: 40, proxy: { timeoutMs: 3_000 } },
    }))
    await preseedAccounts(world.stateDir)
    await apply(ctx, world.rawConfig)

    const adminKey = world.credentials.store.get('SUB2API_ADMIN_API_KEY')
    expect(adminKey).toMatch(/^admin-[0-9a-f]{64}$/)
    const origin = `http://127.0.0.1:${String(world.webServer.port)}`

    // The embedded console path authenticates through the injected key: the
    // fake upstream enforces the admin- key, so 200 proves injection.
    const proxied = await fetch(`${origin}${ADMIN_PROXY_PREFIX}/settings/admin-api-key`, {
      headers: { origin },
    })
    expect(proxied.status).toBe(200)
    const payload = await proxied.json() as { code: number; data: { exists: boolean } }
    expect(payload.data.exists).toBe(true)

    // The embedded-console passthrough is registered by the same wiring and
    // injects the key on its admin-plane subpaths.
    const embedded = await fetch(`${origin}/plugins/dsh-sub2api/ui/api/v1/admin/settings/admin-api-key`, {
      headers: { origin },
    })
    expect(embedded.status).toBe(200)
    expect(((await embedded.json()) as { code: number }).code).toBe(0)

    // Cross-origin calls are refused at the seam.
    const forbidden = await fetch(`${origin}${ADMIN_PROXY_PREFIX}/settings/admin-api-key`, {
      headers: { origin: 'http://evil.example' },
    })
    expect(forbidden.status).toBe(403)

    // The snapshot becomes ready and carries the mapped accounts.
    type SnapshotBody = { status: string; accounts: Array<{ id: number; quota: { tier: string } }> }
    let snapshot: SnapshotBody | undefined
    for (let i = 0; i < 200 && snapshot === undefined; i++) {
      const response = await fetch(`${origin}${QUOTA_SNAPSHOT_PATH}`, { headers: { origin } })
      const body = await response.json() as SnapshotBody
      if (body.status === 'ready') snapshot = body
      else await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(snapshot?.status).toBe('ready')
    expect(snapshot?.accounts).toHaveLength(2)
    expect(snapshot?.accounts.map((account) => account.quota.tier).sort()).toEqual(['local-derived', 'remote-probed'])

    // Neither the proxy nor the snapshot path leaks the key.
    const proxyText = await (await fetch(`${origin}${ADMIN_PROXY_PREFIX}/settings/admin-api-key`, { headers: { origin } })).text()
    const snapshotText = await (await fetch(`${origin}${QUOTA_SNAPSHOT_PATH}`, { headers: { origin } })).text()
    for (const text of [proxyText, snapshotText]) expect(text).not.toContain(adminKey ?? '')
    for (const line of world.logger.lines) expect(line).not.toContain(adminKey ?? '')

    // Unloading the fiber removes both routes and stops the poller.
    for (const effect of world.effects) await effect()()
    world.effects.length = 0
    const gone = await fetch(`${origin}${QUOTA_SNAPSHOT_PATH}`, { headers: { origin } })
    expect(gone.status).toBe(404)

    // The supervisor state file stays secret-free alongside the new services.
    const state = await readTextOrNull(path.join(world.config.runtimeDir, 'run', 'supervisor-state.json'))
    expect(state).not.toContain(adminKey ?? '')
  })
})
