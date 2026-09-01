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
    expect(resolved.route.models).toEqual([])
    expect(resolved.group.name).toBe('dsh-composite')
    expect(resolved.redis.skip).toBe(false)
    expect(resolved.adminPassword).toBeUndefined()
    expect(resolved.proxy.enabled).toBe(true)
    expect(resolved.proxy.allowedOrigins).toEqual([])
    expect(resolved.proxy.timeoutMs).toBe(30_000)
    expect(resolved.quotaPollMs).toBe(60_000)
    expect(resolved.modelCatalogPollMs).toBe(5_000)
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

  it('rejects proxy shapes that are not booleans, origin arrays, or integer budgets', () => {
    const enabled = Config['~standard'].validate({ proxy: { enabled: 'yes' } })
    expect(enabled.issues?.[0]?.path).toEqual(['proxy', 'enabled'])
    const origins = Config['~standard'].validate({ proxy: { allowedOrigins: 'https://x.example' } })
    expect(origins.issues?.[0]?.path).toEqual(['proxy', 'allowedOrigins'])
    const timeout = Config['~standard'].validate({ proxy: { timeoutMs: 0 } })
    expect(timeout.issues?.[0]?.path).toEqual(['proxy', 'timeoutMs'])
    const poll = Config['~standard'].validate({ quotaPollMs: 1.5 })
    expect(poll.issues?.[0]?.path).toEqual(['quotaPollMs'])
    const catalogPoll = Config['~standard'].validate({ modelCatalogPollMs: 1.5 })
    expect(catalogPoll.issues?.[0]?.path).toEqual(['modelCatalogPollMs'])
  })

  it('admits an explicitly empty fallback model list and rejects an unsupported wire protocol', () => {
    const emptyModels = Config['~standard'].validate({ route: { models: [] } })
    expect(emptyModels.issues).toBeUndefined()
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

  it('rejects an allowed origin that is not a bare http(s) origin', () => {
    expect(() => resolveConfig({ proxy: { allowedOrigins: ['file:///etc'] } }, { DSH_HOME: '/tmp/home' }))
      .toThrow(/allowedOrigins/)
    expect(() => resolveConfig({ proxy: { allowedOrigins: ['https://desktop.example/path'] } }, { DSH_HOME: '/tmp/home' }))
      .toThrow(/bare http\(s\) origin/)
  })

  it('normalizes and resolves the proxy group and poll interval', () => {
    const resolved = resolveConfig({
      proxy: { enabled: false, allowedOrigins: ['https://desktop.example/'], timeoutMs: 5_000 },
      quotaPollMs: 1_000,
      modelCatalogPollMs: 2_000,
    }, { DSH_HOME: '/tmp/home' })
    expect(resolved.proxy).toEqual({ enabled: false, allowedOrigins: ['https://desktop.example'], timeoutMs: 5_000 })
    expect(resolved.quotaPollMs).toBe(1_000)
    expect(resolved.modelCatalogPollMs).toBe(2_000)
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
