/**
 * Redis component handling: the darwin pack's loud placeholder fails the boot
 * unless skipping is configured; the skip is recorded under the run directory
 * and the configured external endpoint reaches sub2api's environment.
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
  for (const world of worlds) {
    for (const effect of world.effects) await effect()()
  }
  await new Promise((resolve) => setTimeout(resolve, 300))
  await Promise.all(worlds.map((world) => world.dispose()))
})

describe('redis component', () => {
  it('fails loud naming the lock entry when the placeholder ships without a skip', { timeout: 40_000 }, async () => {
    const world = await createWorld({ redisStub: true })
    worlds.push(world)
    const ctx = world as unknown as PluginContext
    await expect(apply(ctx, world.rawConfig)).rejects.toThrow(/pack-sources\.lock\.json sources\.redis/)
    // Nothing got registered: the boot never reached bootstrap.
    expect(world.settings.updates).toHaveLength(0)
  })

  it('records the configured skip and points sub2api at the conventional local Redis', { timeout: 40_000 }, async () => {
    const world = await createWorld({
      redisStub: true,
      configOverrides: { redis: { skip: true } },
    })
    worlds.push(world)
    const ctx = world as unknown as PluginContext
    await apply(ctx, world.rawConfig)

    const markerText = await readTextOrNull(path.join(world.config.runtimeDir, 'run', 'redis.skipped.json'))
    expect(markerText).toContain('config.redis.skip=true')
    // The skip was announced on the log, not silently accepted.
    expect(world.logger.lines.some((line) => line.includes('redis skipped'))).toBe(true)
    // sub2api targets the conventional local endpoint, where a first-boot
    // AUTO_SETUP fails loudly if nothing listens.
    const envDump = JSON.parse(await readTextOrNull(path.join(world.stateDir, 'sub2api-env.json')) ?? '{}')
    expect(envDump['REDIS_HOST']).toBe('127.0.0.1')
    expect(envDump['REDIS_PORT']).toBe('6379')
    // No redis process was started for this boot.
    const redisBoots = await readTextOrNull(path.join(world.stateDir, 'redis-boots.log'))
    expect(redisBoots).toBeNull()
    // Credentials still issued; the boot completed end to end.
    expect(world.credentials.store.get('SUB2API_API_KEY')).toMatch(/^sk-/)
  })

  it('points sub2api at the configured external endpoint instead of the pack binary', { timeout: 40_000 }, async () => {
    const world = await createWorld({
      configOverrides: { redis: { external: { host: '127.0.0.1', port: 6390 } } },
    })
    worlds.push(world)
    const ctx = world as unknown as PluginContext
    await apply(ctx, world.rawConfig)

    const envDump = JSON.parse(await readTextOrNull(path.join(world.stateDir, 'sub2api-env.json')) ?? '{}')
    expect(envDump['REDIS_HOST']).toBe('127.0.0.1')
    expect(envDump['REDIS_PORT']).toBe('6390')
    // The bundled binary was not started and no skip marker was recorded.
    const redisBoots = await readTextOrNull(path.join(world.stateDir, 'redis-boots.log'))
    expect(redisBoots).toBeNull()
    const markerText = await readTextOrNull(path.join(world.config.runtimeDir, 'run', 'redis.skipped.json'))
    expect(markerText).toBeNull()
  })

  it('propagates an initdb failure as a loud boot error', { timeout: 40_000 }, async () => {
    const world = await createWorld({ initdbFails: true })
    worlds.push(world)
    const ctx = world as unknown as PluginContext
    await expect(apply(ctx, world.rawConfig)).rejects.toThrow(/initdb failed/)
    expect(world.settings.updates).toHaveLength(0)
    await expect(fs.access(path.join(world.config.runtimeDir, 'data', 'pg', 'PG_VERSION'))).rejects.toThrow()
  })
})
