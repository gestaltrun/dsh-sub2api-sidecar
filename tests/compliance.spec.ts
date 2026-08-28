/**
 * The upstream administrator compliance gate: a fresh deployment's admin
 * plane answers 423 until the acknowledgement is submitted, so the bootstrap
 * clears it on boot — echoing back the exact phrase upstream issued — and
 * `compliance.acceptOnBoot: false` turns the gate into a loud boot failure
 * naming the document. The cleared state persists, so later boots skip the
 * step.
 */

import { afterAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import type { PluginContext } from '../src/index.ts'
import { readTextOrNull, createWorld } from './helpers/world.ts'
import type { World } from './helpers/world.ts'

const worlds: World[] = []

afterAll(async () => {
  for (const world of worlds) {
    for (const effect of world.effects) await effect()()
  }
  await new Promise((resolve) => setTimeout(resolve, 300))
  await Promise.all(worlds.map((world) => world.dispose()))
})

/** Read the fake upstream's persisted state. */
async function fakeState(world: World): Promise<{ complianceAck: unknown; adminKey: string | null }> {
  const text = await readTextOrNull(`${world.stateDir}/fake-sub2api-state.json`)
  return JSON.parse(text ?? '{}') as { complianceAck: unknown; adminKey: string | null }
}

describe('compliance acknowledgement', () => {
  it('clears an armed compliance gate on boot and still issues both keys', { timeout: 40_000 }, async () => {
    const world = await createWorld({ complianceRequired: true })
    worlds.push(world)
    await apply(world as unknown as PluginContext, world.rawConfig)

    const adminKey = world.credentials.store.get('SUB2API_ADMIN_API_KEY')
    expect(adminKey).toMatch(/^admin-[0-9a-f]{64}$/)
    const state = await fakeState(world)
    expect(state.complianceAck).not.toBeNull()
    expect(state.complianceAck).toMatchObject({ version: 'vTEST.1' })
    expect(world.logger.lines.some((line) => line.includes('acknowledged upstream compliance'))).toBe(true)
  })

  it('fails loud naming the document when acceptOnBoot is false', { timeout: 40_000 }, async () => {
    const world = await createWorld({
      complianceRequired: true,
      configOverrides: { compliance: { acceptOnBoot: false } },
    })
    worlds.push(world)
    await expect(apply(world as unknown as PluginContext, world.rawConfig)).rejects.toThrow(
      /administrator compliance acknowledgement.*https:\/\/example\.test\/compliance\.zh\.md/s,
    )
    const state = await fakeState(world)
    expect(state.complianceAck).toBeNull()
    expect(state.adminKey).toBeNull()
  })

  it('skips the acknowledgement round trip when the gate is not armed', { timeout: 40_000 }, async () => {
    const world = await createWorld()
    worlds.push(world)
    await apply(world as unknown as PluginContext, world.rawConfig)
    const state = await fakeState(world)
    expect(state.complianceAck).toBeNull()
    expect(world.credentials.store.get('SUB2API_ADMIN_API_KEY')).toMatch(/^admin-[0-9a-f]{64}$/)
  })
})
