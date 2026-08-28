/**
 * The `llm-pi-ai` settings contribution: one hand-declared provider route
 * whose baseURL is the sidecar's loopback endpoint and whose `apiKeyEnv` names
 * the `sk-` inference credential reference. The write goes through the
 * settings seam's `update` (a per-provider dict merge), and repeats only when
 * the desired profile differs from the last written one, so an unchanged boot
 * does not churn the namespace revision.
 *
 * @module dsh-sub2api-sidecar/llm-profile
 */

import { deepEqualJson } from './json-equal.ts'
import type { SidecarConfig } from './config.ts'
import type { LoggerLike, SettingsService } from './seam.ts'

/** The settings namespace llm-pi-ai owns. */
export const LLM_PI_AI_NAMESPACE = 'llm-pi-ai'

/** The provider-profile payload written under the route key. */
export interface DesiredProfile {
  /** Credential reference resolved per request by the llm-pi-ai adapter. */
  readonly apiKeyEnv: string
  /** Display name for configuration surfaces. */
  readonly displayName: string
  /** Wire protocol every route model speaks. */
  readonly api: string
  /** The sidecar's loopback `/v1` endpoint. */
  readonly baseURL: string
  /** The advertised model list. */
  readonly models: ReadonlyArray<{ id: string; name: string; contextWindow: number; maxTokens: number }>
}

/**
 * Build the desired profile for the current boot.
 * @param config - the resolved plugin configuration.
 * @param serverPort - the sidecar server port allocated this boot.
 * @returns the profile payload for the route key.
 */
export function desiredProfile(config: SidecarConfig, serverPort: number): DesiredProfile {
  return {
    apiKeyEnv: config.credentials.inferenceRef,
    displayName: config.route.displayName,
    api: config.route.api,
    baseURL: `http://127.0.0.1:${serverPort}/v1`,
    models: config.route.models,
  }
}

/**
 * Whether every leaf in `desired` deep-equals the same path in `stored`.
 * Extra keys in `stored` are ignored: the resolved settings section layers
 * schema defaults over the user patch, so the route may legitimately carry
 * fields this writer never sets.
 */
function desiredIsStored(desired: unknown, stored: unknown): boolean {
  if (stored === undefined || stored === null) return false
  if (typeof desired !== 'object' || desired === null || Array.isArray(desired)) {
    return deepEqualJson(desired, stored)
  }
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return false
  return Object.entries(desired as Record<string, unknown>).every(([key, value]) =>
    desiredIsStored(value, (stored as Record<string, unknown>)[key]),
  )
}

/**
 * Ensure the hand-declared route is present in the `llm-pi-ai` settings
 * namespace, judged against the **live resolved store**: the write repeats
 * whenever the stored route is absent or diverges from the desired profile,
 * and skips only when the store already contains it. A persisted memo of
 * previous writes is deliberately not consulted — it cannot know whether the
 * settings document survived (different DSH_HOME, manual reset), and a stale
 * memo silently strands the provider route.
 * @param settings - the host settings seam.
 * @param routeName - the provider route key (the dict key under `providers`).
 * @param profile - the desired profile payload.
 * @param logger - host logger for the skip and write diagnostics.
 * @throws when the settings seam refuses the write (e.g. llm-pi-ai not mounted).
 */
export async function writeProfile(
  settings: SettingsService,
  routeName: string,
  profile: DesiredProfile,
  logger: LoggerLike,
): Promise<void> {
  const section = settings.get(LLM_PI_AI_NAMESPACE) as { providers?: Record<string, unknown> } | undefined
  const stored = section?.providers?.[routeName]
  if (desiredIsStored(profile, stored)) {
    logger.info('dsh-sub2api-sidecar: llm-pi-ai route "%s" already present in settings; skipping write', routeName)
    return
  }
  await settings.update(LLM_PI_AI_NAMESPACE, { providers: { [routeName]: profile } })
  logger.info('dsh-sub2api-sidecar: wrote llm-pi-ai route "%s" pointing at %s', routeName, profile.baseURL)
}
