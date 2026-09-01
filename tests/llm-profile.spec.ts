// Regression coverage for the llm-pi-ai route write decision: the ground
// truth is the live resolved settings store, never a persisted write memo.
// Case A pins the field bug this suite was born from — a memo claiming the
// route was already written must not suppress the write when the store
// actually lacks the route.
import { describe, expect, it } from 'vitest'
import { desiredProfile, writeProfile, LLM_PI_AI_NAMESPACE, type DesiredProfile } from '../src/llm-profile.ts'
import { resolveConfig } from '../src/config.ts'
import { FakeLogger, FakeSettings } from './helpers/world.ts'

const ROUTE = 'sub2api'

const PROFILE: DesiredProfile = {
  apiKeyEnv: 'SUB2API_API_KEY',
  displayName: 'Sub2API (sub2api)',
  api: 'openai-completions',
  baseURL: 'http://127.0.0.1:45101/v1',
  models: [{ id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', contextWindow: 262144, maxTokens: 32768 }],
}

describe('llm-pi-ai writeProfile', () => {
  it('uses the live gateway catalog as the complete provider model list', () => {
    const config = resolveConfig({}, { DSH_HOME: '/tmp/dsh-test' })
    expect(desiredProfile(config, 45101, [
      { id: 'glm-4.5', name: 'glm-4.5' },
      { id: 'deepseek-chat', name: 'deepseek-chat' },
    ]).models).toEqual([
      { id: 'glm-4.5', name: 'glm-4.5' },
      { id: 'deepseek-chat', name: 'deepseek-chat' },
    ])
  })

  it('retains live capability metadata instead of configured fallback values', () => {
    const config = resolveConfig({}, { DSH_HOME: '/tmp/dsh-test' })
    expect(desiredProfile(config, 45101, [{
      id: 'claude-sonnet-4-5-20250929',
      name: 'Live Sonnet',
      contextWindow: 200_000,
      maxTokens: 16_000,
      input: ['text', 'image'],
      reasoningEfforts: { off: null, low: 'low', high: 'high' },
      defaultReasoningLevel: 'high',
    }]).models).toEqual([{
      id: 'claude-sonnet-4-5-20250929',
      name: 'Live Sonnet',
      contextWindow: 200_000,
      maxTokens: 16_000,
      input: ['text', 'image'],
      reasoningEfforts: { off: null, low: 'low', high: 'high' },
      defaultReasoningLevel: 'high',
    }])
  })

  it('A: writes when the store lacks the route even though a write memo exists (regression)', async () => {
    const settings = new FakeSettings()
    // Simulates the stale memo scenario: supervisor-state.json claims the
    // profile was written by a previous boot (in another DSH_HOME), while the
    // live store for THIS home has no llm-pi-ai section at all.
    const logger = new FakeLogger()
    await writeProfile(settings, ROUTE, PROFILE, logger)
    expect(settings.updates).toHaveLength(1)
    expect(settings.updates[0]?.namespace).toBe(LLM_PI_AI_NAMESPACE)
    expect(logger.lines.join('\n')).not.toContain('skipping write')
  })

  it('B: skips when the store already contains the desired route plus resolved extras', async () => {
    const settings = new FakeSettings()
    settings.sections[LLM_PI_AI_NAMESPACE] = {
      providers: { [ROUTE]: { ...PROFILE, schemaDefaultField: 'added by resolution' } },
    }
    const logger = new FakeLogger()
    await writeProfile(settings, ROUTE, PROFILE, logger)
    expect(settings.updates).toHaveLength(0)
    expect(logger.lines.join('\n')).toContain('skipping write')
  })

  it('C: rewrites when the stored route diverges (e.g. port changed)', async () => {
    const settings = new FakeSettings()
    settings.sections[LLM_PI_AI_NAMESPACE] = {
      providers: { [ROUTE]: { ...PROFILE, baseURL: 'http://127.0.0.1:9999/v1' } },
    }
    await writeProfile(settings, ROUTE, PROFILE, new FakeLogger())
    expect(settings.updates).toHaveLength(1)
  })

  it('D: writes when the llm-pi-ai section is absent entirely', async () => {
    const settings = new FakeSettings()
    await writeProfile(settings, ROUTE, PROFILE, new FakeLogger())
    expect(settings.updates).toHaveLength(1)
  })
})
