/**
 * Supervisor lifecycle: happy-path boot with credential issuance and the
 * llm-pi-ai registration, health failure refusal, dispose semantics (data
 * preserved, processes exited), and reload idempotency (keys reused, no
 * duplicate processes, no re-initdb).
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import type { PluginContext } from '../src/index.ts'
import { createWorld, readTextOrNull } from './helpers/world.ts'
import type { World } from './helpers/world.ts'

const worlds: World[] = []

afterAll(async () => {
  // Stop every chain the tests started before removing their fixtures.
  for (const world of worlds) {
    for (const effect of world.effects) await effect()()
  }
  await new Promise((resolve) => setTimeout(resolve, 300))
  await Promise.all(worlds.map((world) => world.dispose()))
})

/** Register a world for cleanup and return it with a plugin-context view. */
function useWorld(world: World): { world: World; ctx: PluginContext } {
  worlds.push(world)
  return { world, ctx: world as unknown as PluginContext }
}

/** The fake upstream records exactly one boot line per process start. */
async function bootLines(stateDir: string, name: string): Promise<string[]> {
  const text = await readTextOrNull(path.join(stateDir, name))
  return (text ?? '').split('\n').filter((line) => line.length > 0)
}

describe('supervisor happy path', () => {
  it('boots the chain, issues both keys, and registers the llm-pi-ai route', { timeout: 40_000 }, async () => {
    const { world, ctx } = useWorld(await createWorld())
    await apply(ctx, world.rawConfig)

    // Dual keys stored, with their prefixes intact.
    const adminKey = world.credentials.store.get('SUB2API_ADMIN_API_KEY')
    const inferenceKey = world.credentials.store.get('SUB2API_API_KEY')
    expect(adminKey).toMatch(/^admin-[0-9a-f]{64}$/)
    expect(inferenceKey).toMatch(/^sk-[0-9a-f]{64}$/)

    // Exactly one llm-pi-ai settings write carrying the hand-declared route.
    expect(world.settings.updates).toHaveLength(1)
    const update = world.settings.updates[0]
    expect(update?.namespace).toBe('llm-pi-ai')
    const providers = update?.patch['providers'] as Record<string, Record<string, unknown>>
    const profile = providers?.['sub2api']
    expect(profile?.['apiKeyEnv']).toBe('SUB2API_API_KEY')
    expect(profile?.['baseURL']).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
    expect(Array.isArray(profile?.['models'])).toBe(true)

    // The baseURL names the port the fake actually listens on: a request to it
    // through the issued sk- key succeeds.
    const baseURL = profile?.['baseURL'] as string
    const gateway = await fetch(`${baseURL}/models`, { headers: { authorization: `Bearer ${inferenceKey}` } })
    expect(gateway.status).toBe(200)

    // Exactly one process set: one sub2api boot, one redis boot, one initdb.
    expect(await bootLines(world.stateDir, 'sub2api-boots.log')).toHaveLength(1)
    expect(await bootLines(world.stateDir, 'redis-boots.log')).toHaveLength(1)
    expect(await bootLines(world.stateDir, 'initdb-calls.log')).toHaveLength(1)

    // The state file records the written profile and no secret material.
    const state = await readTextOrNull(path.join(world.config.runtimeDir, 'run', 'supervisor-state.json'))
    expect(state).toContain('lastWrittenProfile')
    expect(state).not.toContain((adminKey ?? '').slice(0, 20))
    expect(state).not.toContain((inferenceKey ?? '').slice(0, 20))

    // No key value may appear in any log line.
    for (const line of world.logger.lines) {
      expect(line).not.toContain(adminKey ?? '')
      expect(line).not.toContain(inferenceKey ?? '')
    }
  })

  it('reuses both keys and skips the profile write on a reload', { timeout: 40_000 }, async () => {
    const { world, ctx } = useWorld(await createWorld())
    await apply(ctx, world.rawConfig)
    const adminKey = world.credentials.store.get('SUB2API_ADMIN_API_KEY')
    const inferenceKey = world.credentials.store.get('SUB2API_API_KEY')
    const updatesAfterFirstBoot = world.settings.updates.length
    const firstBoots = await bootLines(world.stateDir, 'sub2api-boots.log')

    // Simulate a Cordis HMR reload: unload the fiber (effects run, dispose
    // completes and frees the ports), then mount the plugin again over the
    // same runtime dir.
    for (const effect of world.effects) await effect()()
    await apply(ctx, world.rawConfig)

    expect(world.credentials.store.get('SUB2API_ADMIN_API_KEY')).toBe(adminKey)
    expect(world.credentials.store.get('SUB2API_API_KEY')).toBe(inferenceKey)
    // The fake's regenerate and login endpoints were hit only during the
    // first boot: nothing was reissued.
    const fakeState = JSON.parse(await readTextOrNull(path.join(world.stateDir, 'fake-sub2api-state.json')) ?? '{}')
    expect(fakeState['regenerateCount']).toBe(1)
    expect(fakeState['loginCount']).toBe(1)
    // The reload started exactly one new process set, not a duplicate.
    expect(await bootLines(world.stateDir, 'sub2api-boots.log')).toHaveLength(firstBoots.length + 1)
    // The profile did not change (stable ports), so the second boot wrote nothing.
    expect(world.settings.updates).toHaveLength(updatesAfterFirstBoot)
    // Still exactly one initdb across both boots; the data dir survived.
    expect(await bootLines(world.stateDir, 'initdb-calls.log')).toHaveLength(1)
    await expect(fs.access(path.join(world.config.runtimeDir, 'data', 'pg', 'PG_VERSION'))).resolves.toBeUndefined()
  })
})

describe('health failure refusal', () => {
  it('fails loud and writes neither credentials nor llm-pi-ai', { timeout: 40_000 }, async () => {
    const { world, ctx } = useWorld(await createWorld({ healthFails: true }))
    await expect(apply(ctx, world.rawConfig)).rejects.toThrow(/did not become healthy/)
    expect(world.credentials.store.size).toBe(0)
    expect(world.settings.updates).toHaveLength(0)

    // The failure path still stopped what it had started.
    const pgctlCalls = await readTextOrNull(path.join(world.stateDir, 'pgctl-calls.log'))
    expect(pgctlCalls).toContain('stop')
    expect(await bootLines(world.stateDir, 'sub2api-boots.log')).toHaveLength(1)
    const stopped = await readTextOrNull(path.join(world.stateDir, 'sub2api-stopped'))
    expect(stopped).not.toBeNull()
    // And the data directory was not emptied by the failure.
    await expect(fs.access(path.join(world.config.runtimeDir, 'data', 'pg', 'PG_VERSION'))).resolves.toBeUndefined()
  })
})

describe('dispose semantics', () => {
  it('stops the process trees and preserves the data directory', { timeout: 40_000 }, async () => {
    const { world, ctx } = useWorld(await createWorld())
    await apply(ctx, world.rawConfig)
    const pgVersion = path.join(world.config.runtimeDir, 'data', 'pg', 'PG_VERSION')
    await expect(fs.access(pgVersion)).resolves.toBeUndefined()

    for (const effect of world.effects) await effect()()

    expect(await readTextOrNull(path.join(world.stateDir, 'sub2api-stopped'))).not.toBeNull()
    expect(await readTextOrNull(path.join(world.stateDir, 'redis-stopped'))).not.toBeNull()
    const pgctlCalls = await readTextOrNull(path.join(world.stateDir, 'pgctl-calls.log'))
    expect(pgctlCalls).toContain('stop')
    // Data survives dispose.
    await expect(fs.access(pgVersion)).resolves.toBeUndefined()
  })
})
