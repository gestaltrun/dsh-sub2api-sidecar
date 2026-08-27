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
 * Write the hand-declared route into the `llm-pi-ai` settings namespace when
 * it differs from the last written profile.
 * @param settings - the host settings seam.
 * @param routeName - the provider route key (the dict key under `providers`).
 * @param profile - the desired profile payload.
 * @param lastWritten - the profile written by the previous boot, when known.
 * @param logger - host logger for the skip and write diagnostics.
 * @returns the profile now recorded as written.
 * @throws when the settings seam refuses the write (e.g. llm-pi-ai not mounted).
 */
export async function writeProfile(
  settings: SettingsService,
  routeName: string,
  profile: DesiredProfile,
  lastWritten: DesiredProfile | undefined,
  logger: LoggerLike,
): Promise<DesiredProfile> {
  if (lastWritten !== undefined && deepEqualJson(lastWritten, profile)) {
    logger.info('dsh-sub2api-sidecar: llm-pi-ai route "%s" already matches this boot; skipping settings write', routeName)
    return profile
  }
  await settings.update(LLM_PI_AI_NAMESPACE, { providers: { [routeName]: profile } })
  logger.info('dsh-sub2api-sidecar: wrote llm-pi-ai route "%s" pointing at %s', routeName, profile.baseURL)
  return profile
}
