import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { ProviderModelCatalogService } from '../src/model-catalog.ts'
import { FakeCredentials, FakeLogger, FakeSettings } from './helpers/world.ts'

describe('provider model catalog sync', () => {
  it('publishes only gateway models declared by accounts in the composite group', async () => {
    const config = resolveConfig({ modelCatalogPollMs: 10_000 }, { DSH_HOME: '/tmp/dsh-test' })
    const credentials = new FakeCredentials()
    credentials.store.set(config.credentials.inferenceRef, 'sk-test')
    credentials.store.set(config.credentials.adminRef, 'admin-test')
    const settings = new FakeSettings()
    const service = new ProviderModelCatalogService({
      config,
      credentials,
      settings,
      logger: new FakeLogger(),
      sidecar: { port: 45101 },
      fetchImpl: async (input) => {
        const path = new URL(String(input)).pathname
        if (path === '/api/v1/admin/groups/all') {
          return Response.json({ code: 0, data: [{ id: 7, name: config.group.name, platform: 'composite' }] })
        }
        if (path === '/api/v1/admin/accounts') {
          return Response.json({
            code: 0,
            data: {
              items: [{
                group_ids: [7],
                credentials: {
                  model_mapping: {
                    'account-backed': 'account-backed',
                    'not-account-backed': 'not-account-backed',
                  },
                },
                extra: {
                  upstream_model_metadata: {
                    models: { 'account-backed': { id: 'account-backed' } },
                  },
                },
              }],
            },
          })
        }
        return Response.json({
          object: 'list',
          data: [
            { id: 'account-backed', object: 'model' },
            { id: 'not-account-backed', object: 'model' },
          ],
        })
      },
    })

    await service.refresh()

    const profile = settings.updates[0]?.patch['providers'] as Record<string, { models: unknown[] }>
    expect(profile['sub2api']?.models).toEqual([{ id: 'account-backed', name: 'account-backed' }])
  })

  it('unregisters a stale provider when the group-bound gateway serves no models', async () => {
    const config = resolveConfig({ modelCatalogPollMs: 10_000 }, { DSH_HOME: '/tmp/dsh-test' })
    const credentials = new FakeCredentials()
    credentials.store.set(config.credentials.inferenceRef, 'sk-test')
    credentials.store.set(config.credentials.adminRef, 'admin-test')
    const settings = new FakeSettings()
    settings.sections['llm-pi-ai'] = {
      providers: {
        sub2api: {
          api: 'openai-completions',
          baseURL: 'http://127.0.0.1:45101/v1',
          models: [{ id: 'not-account-backed' }],
        },
      },
    }
    const service = new ProviderModelCatalogService({
      config,
      credentials,
      settings,
      logger: new FakeLogger(),
      sidecar: { port: 45101 },
      fetchImpl: async (input) => {
        const path = new URL(String(input)).pathname
        if (path === '/api/v1/admin/groups/all') {
          return Response.json({ code: 0, data: [{ id: 7, name: config.group.name, platform: 'composite' }] })
        }
        if (path === '/api/v1/admin/accounts') return Response.json({ code: 0, data: { items: [] } })
        return Response.json({ object: 'list', data: [] })
      },
    })

    await service.refresh()

    expect(settings.sections['llm-pi-ai']).toEqual({ providers: {} })
  })

  it('rewrites the provider when the live Sub2API model list changes', async () => {
    const config = resolveConfig({ modelCatalogPollMs: 10_000 }, { DSH_HOME: '/tmp/dsh-test' })
    const credentials = new FakeCredentials()
    credentials.store.set(config.credentials.inferenceRef, 'sk-test')
    credentials.store.set(config.credentials.adminRef, 'admin-test')
    const settings = new FakeSettings()
    const logger = new FakeLogger()
    let models = ['glm-4.5']
    const service = new ProviderModelCatalogService({
      config,
      credentials,
      settings,
      logger,
      sidecar: { port: 45101 },
      fetchImpl: async (input) => {
        const path = new URL(String(input)).pathname
        if (path === '/api/v1/admin/groups/all') {
          return Response.json({ code: 0, data: [{ id: 7, name: config.group.name, platform: 'composite' }] })
        }
        if (path === '/api/v1/admin/accounts') {
          return Response.json({
            code: 0,
            data: {
              items: [{
                group_ids: [7],
                extra: {
                  upstream_model_metadata: {
                    models: Object.fromEntries(models.map(id => [id, { id }])),
                  },
                },
              }],
            },
          })
        }
        return Response.json({ object: 'list', data: models.map(id => ({ id, object: 'model' })) })
      },
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

  it('projects live model capacities, modalities, and reasoning levels into llm-pi-ai', async () => {
    const config = resolveConfig({ modelCatalogPollMs: 10_000 }, { DSH_HOME: '/tmp/dsh-test' })
    const credentials = new FakeCredentials()
    credentials.store.set(config.credentials.inferenceRef, 'sk-test')
    credentials.store.set(config.credentials.adminRef, 'admin-test')
    const settings = new FakeSettings()
    const service = new ProviderModelCatalogService({
      config,
      credentials,
      settings,
      logger: new FakeLogger(),
      sidecar: { port: 45101 },
      fetchImpl: async (input) => {
        const path = new URL(String(input)).pathname
        if (path === '/api/v1/admin/groups/all') {
          return Response.json({ code: 0, data: [{ id: 7, name: config.group.name, platform: 'composite' }] })
        }
        if (path === '/api/v1/admin/accounts') {
          return Response.json({
            code: 0,
            data: {
              items: [{
                group_ids: [7],
                extra: {
                  upstream_model_metadata: {
                    models: { 'vision-coder': { id: 'vision-coder' } },
                  },
                },
              }],
            },
          })
        }
        return Response.json({ object: 'list', data: [{
          id: 'vision-coder',
          display_name: 'Vision Coder',
          context_window: 256_000,
          max_output_tokens: 32_768,
          reasoning: true,
          default_reasoning_level: 'ultra',
          supported_reasoning_levels: ['none', 'low', 'medium', 'high', 'ultra'],
          input_modalities: ['text', 'image'],
        }] })
      },
    })

    await service.refresh()

    const profile = settings.updates[0]?.patch['providers'] as Record<string, { models: unknown[] }>
    expect(profile['sub2api']?.models).toEqual([{
      id: 'vision-coder',
      name: 'Vision Coder',
      contextWindow: 256_000,
      maxTokens: 32_768,
      input: ['text', 'image'],
      reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'ultra' },
      defaultReasoningLevel: 'max',
    }])
  })
})
