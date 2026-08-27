/**
 * Config schema and resolution: misconfiguration fails loud at load with the
 * offending path named, defaults resolve in one explicit step, and the
 * Standard Schema shape the Cordis Loader validates against behaves.
 */

import { describe, expect, it } from 'vitest'
import { Config, resolveConfig } from '../src/config.ts'

describe('config schema', () => {
  it('admits an empty object and resolves every default', () => {
    const result = Config['~standard'].validate({})
    expect(result.issues).toBeUndefined()
    const resolved = resolveConfig(result.value ?? {}, { DSH_HOME: '/tmp/home' })
    expect(resolved.enabled).toBe(true)
    expect(resolved.runtimeDir).toBe('/tmp/home/sub2api')
    expect(resolved.binaryDir).toBe('/tmp/home/sub2api/runtime')
    expect(resolved.credentials.adminRef).toBe('SUB2API_ADMIN_API_KEY')
    expect(resolved.credentials.inferenceRef).toBe('SUB2API_API_KEY')
    expect(resolved.route.name).toBe('sub2api')
    expect(resolved.route.api).toBe('openai-completions')
    expect(resolved.route.models.length).toBeGreaterThan(0)
    expect(resolved.group.name).toBe('dsh-composite')
    expect(resolved.redis.skip).toBe(false)
    expect(resolved.adminPassword).toBeUndefined()
  })

  it('rejects unknown-shape values with named paths', () => {
    const result = Config['~standard'].validate({ healthTimeoutMs: -5 })
    expect(result.issues).toBeDefined()
    expect(result.issues?.[0]?.path).toEqual(['healthTimeoutMs'])
  })

  it('rejects a route name that cannot serve as a credential-ref stem', () => {
    const result = Config['~standard'].validate({ route: { name: '9route' } })
    expect(result.issues?.[0]?.path).toEqual(['route', 'name'])
  })

  it('rejects credential refs that are not POSIX identifiers', () => {
    const result = Config['~standard'].validate({ credentials: { adminRef: 'not a ref' } })
    expect(result.issues?.[0]?.path).toEqual(['credentials', 'adminRef'])
  })

  it('rejects an empty model list and an unsupported wire protocol', () => {
    const emptyModels = Config['~standard'].validate({ route: { models: [] } })
    expect(emptyModels.issues?.[0]?.path[0]).toBe('route')
    const badApi = Config['~standard'].validate({ route: { api: 'grpc' } })
    expect(badApi.issues?.[0]?.path).toEqual(['route', 'api'])
  })
})

describe('resolveConfig', () => {
  it('requires DSH_HOME or an explicit runtimeDir', () => {
    expect(() => resolveConfig({}, {})).toThrow(/DSH_HOME/)
  })

  it('rejects an inverted port range', () => {
    expect(() => resolveConfig({ portRange: { min: 500, max: 400 } }, { DSH_HOME: '/tmp/home' }))
      .toThrow(/portRange/)
  })

  it('honors every override it accepts', () => {
    const resolved = resolveConfig({
      enabled: false,
      runtimeDir: '/data/sidecar',
      binaryDir: '/packs/current',
      adminEmail: 'ops@example.com',
      adminPassword: 'secret-password',
      group: { name: 'custom-group' },
      route: { name: 'relay', api: 'anthropic-messages', displayName: 'Relay', models: [{ id: 'm1', contextWindow: 1000, maxTokens: 500 }] },
      redis: { skip: true, external: { host: 'redis.internal', port: 6380 } },
      credentials: { adminRef: 'X_ADMIN', inferenceRef: 'X_KEY' },
    }, {})
    expect(resolved.enabled).toBe(false)
    expect(resolved.binaryDir).toBe('/packs/current')
    expect(resolved.adminPassword).toBe('secret-password')
    expect(resolved.group.name).toBe('custom-group')
    expect(resolved.route.models[0]).toMatchObject({ id: 'm1', name: 'm1', contextWindow: 1000, maxTokens: 500 })
    expect(resolved.redis.external).toEqual({ host: 'redis.internal', port: 6380 })
    expect(resolved.credentials).toEqual({ adminRef: 'X_ADMIN', inferenceRef: 'X_KEY' })
  })
})
