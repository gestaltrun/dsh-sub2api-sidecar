/**
 * The dual-key auth-convention tests: the `sk-` composite inference key opens
 * the gateway (`/v1/*`) and MUST be refused with 401 on the admin plane
 * (`/api/v1/admin/*`); the `admin-` management key opens the admin plane and
 * is not a gateway key. This is the acceptance convention the bootstrap
 * relies on and re-verifies after every issuance.
 */

import { afterAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import type { PluginContext } from '../src/index.ts'
import { createWorld } from './helpers/world.ts'
import type { World } from './helpers/world.ts'

const worlds: World[] = []

afterAll(async () => {
  for (const world of worlds) {
    for (const effect of world.effects) await effect()()
  }
  await new Promise((resolve) => setTimeout(resolve, 300))
  await Promise.all(worlds.map((world) => world.dispose()))
})

describe('dual-key split convention', () => {
  it('keeps the sk- key out of the admin plane and the admin- key off the gateway', { timeout: 40_000 }, async () => {
    const world = await createWorld({
      configOverrides: { route: { models: [{ id: 'v12-probe' }] } },
    })
    worlds.push(world)
    const ctx = world as unknown as PluginContext
    await apply(ctx, world.rawConfig)

    const adminKey = world.credentials.store.get('SUB2API_ADMIN_API_KEY')
    const inferenceKey = world.credentials.store.get('SUB2API_API_KEY')
    expect(adminKey).toBeDefined()
    expect(inferenceKey).toBeDefined()
    const baseURL = `http://127.0.0.1:${world.config.portRange.min}/v1`.replace(/\/v1$/, '')
    // The gateway port is not derivable from the range start in general; read
    // the registered profile's baseURL instead.
    const profile = (world.settings.updates[0]?.patch['providers'] as Record<string, { baseURL: string }>)?.['sub2api']
    expect(profile).toBeDefined()
    const sidecarBase = new URL(profile?.baseURL ?? baseURL).origin

    // sk- key on the admin endpoint: the upstream middleware answers
    // INVALID_ADMIN_KEY with 401 — the bootstrap convention check asserts the
    // same thing after issuance.
    const skOnAdmin = await fetch(`${sidecarBase}/api/v1/admin/settings/admin-api-key`, {
      headers: { 'x-api-key': inferenceKey ?? '' },
    })
    expect(skOnAdmin.status).toBe(401)
    const skOnAdminBody: unknown = await skOnAdmin.json()
    expect((skOnAdminBody as Record<string, unknown>)['code']).toBe('INVALID_ADMIN_KEY')

    // sk- key on the gateway: opens.
    const skOnGateway = await fetch(`${sidecarBase}/v1/models`, {
      headers: { authorization: `Bearer ${inferenceKey}` },
    })
    expect(skOnGateway.status).toBe(200)

    // admin- key on the gateway: not a gateway key.
    const adminOnGateway = await fetch(`${sidecarBase}/v1/models`, {
      headers: { authorization: `Bearer ${adminKey}` },
    })
    expect(adminOnGateway.status).toBe(401)

    // admin- key on the admin plane: opens.
    const adminOnAdmin = await fetch(`${sidecarBase}/api/v1/admin/settings/admin-api-key`, {
      headers: { 'x-api-key': adminKey ?? '' },
    })
    expect(adminOnAdmin.status).toBe(200)
  })
})
