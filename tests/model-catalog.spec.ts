import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { ProviderModelCatalogService } from '../src/model-catalog.ts'
import { FakeCredentials, FakeLogger, FakeSettings } from './helpers/world.ts'

describe('provider model catalog sync', () => {
  it('rewrites the provider when the live Sub2API model list changes', async () => {
    const config = resolveConfig({ modelCatalogPollMs: 10_000 }, { DSH_HOME: '/tmp/dsh-test' })
    const credentials = new FakeCredentials()
    credentials.store.set(config.credentials.inferenceRef, 'sk-test')
    const settings = new FakeSettings()
    const logger = new FakeLogger()
    let models = ['glm-4.5']
    const service = new ProviderModelCatalogService({
      config,
      credentials,
      settings,
      logger,
      sidecar: { port: 45101 },
      fetchImpl: async () => new Response(JSON.stringify({
        object: 'list',
        data: models.map(id => ({ id, object: 'model' })),
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    })

    await service.refresh()
    models = ['glm-4.5', 'deepseek-chat']
    await service.refresh()

    expect(settings.updates).toHaveLength(2)
    const profile = settings.updates[1]?.patch['providers'] as Record<string, { models: unknown[] }>
    expect(profile['sub2api']?.models).toEqual([
      { id: 'glm-4.5', name: 'glm-4.5' },
      { id: 'deepseek-chat', name: 'deepseek-chat' },
    ])
  })
})
