/**
 * The dual-credential bootstrap. Idempotent by construction: stored keys are
 * reused whenever they still authenticate, and a reissue happens only per key
 * that fails validation. Reissue order follows the dependency chain — admin
 * login (JWT) → admin-api-key regenerate (`admin-…` key) → composite group
 * find-or-create → panel key bound to that group (`sk-…` key) — and ends with
 * the auth-convention check: the `sk-` key must be refused with 401 on the
 * admin endpoint it must never open.
 *
 * @module dsh-sub2api-sidecar/bootstrap
 */

import { readStored, storeKey } from './credentials.ts'
import type { SidecarCredentials } from './credentials.ts'
import { writeProfile, desiredProfile } from './llm-profile.ts'
import type { DesiredProfile } from './llm-profile.ts'
import { Sub2apiApiError, Sub2apiClient } from './client.ts'
import type { Auth, GroupSummary } from './client.ts'
import type { SidecarConfig } from './config.ts'
import type { CredentialsService, LoggerLike, SettingsService } from './seam.ts'

/** Everything one ensureBootstrap run needs. */
export interface BootstrapIo {
  /** Client pointed at the healthy sidecar. */
  readonly client: Sub2apiClient
  /** Host credentials seam. */
  readonly credentials: CredentialsService
  /** Host settings seam. */
  readonly settings: SettingsService
  /** Host logger. */
  readonly logger: LoggerLike
  /** Resolved plugin configuration. */
  readonly config: SidecarConfig
  /** Admin password in effect for login. */
  readonly adminPassword: string
  /** The profile the previous boot wrote, when known. */
  readonly lastWrittenProfile: DesiredProfile | undefined
  /** Loopback port the server is listening on this boot. */
  readonly serverPort: number
}

/** Summary of one ensureBootstrap run. */
export interface BootstrapResult {
  /** Whether the admin key was reused rather than reissued. */
  readonly reusedAdminKey: boolean
  /** Whether the inference key was reused rather than reissued. */
  readonly reusedInferenceKey: boolean
  /** The composite group id the inference key is bound to; present only when a key was issued this run. */
  readonly groupId: number | undefined
  /** The llm-pi-ai profile in effect after the run. */
  readonly writtenProfile: DesiredProfile
}

/**
 * Validate a stored admin key against the running sidecar.
 * @param client - the sidecar client.
 * @param key - the stored key.
 * @returns whether the key currently authenticates the admin endpoint.
 */
async function adminKeyValid(client: Sub2apiClient, key: string): Promise<boolean> {
  try {
    return (await client.getAdminApiKeyStatus({ kind: 'adminKey', key })).exists
  } catch (error) {
    if (error instanceof Sub2apiApiError && error.isUnauthorized) return false
    throw error
  }
}

/**
 * Find the configured composite group or create it.
 * @param client - the sidecar client.
 * @param auth - an authenticated caller.
 * @param config - the resolved plugin configuration.
 * @returns the group id.
 * @throws when listing or creation fails.
 */
async function ensureCompositeGroup(client: Sub2apiClient, auth: Auth, config: SidecarConfig): Promise<GroupSummary> {
  const groups = await client.listGroups(auth, 'composite')
  const existing = groups.find((group) => group.name === config.group.name)
  if (existing) return existing
  return client.createGroup(auth, {
    name: config.group.name,
    description: config.group.description,
    platform: 'composite',
    rateMultiplier: 1,
  })
}

/**
 * Clear the upstream administrator compliance gate when it is armed. The
 * AUTO_SETUP account is machine-created, so the acknowledgement rides the
 * boot: the exact phrase upstream issued in its status is echoed back, the
 * document URL is logged, and `compliance.acceptOnBoot: false` turns the
 * gate into a loud boot failure naming the document instead.
 * @param client - the sidecar client.
 * @param config - the resolved plugin configuration.
 * @param login - the bootstrap login.
 * @param logger - host logger.
 * @throws when the acknowledgement is required, `acceptOnBoot` is false, and
 * the status cannot be cleared.
 */
async function ensureComplianceAcknowledgement(
  client: Sub2apiClient,
  config: SidecarConfig,
  login: () => Promise<Auth>,
  logger: LoggerLike,
): Promise<void> {
  const status = await client.getComplianceStatus(await login())
  if (!status.required) return
  if (!config.compliance.acceptOnBoot) {
    throw new Error(
      'dsh-sub2api-sidecar: upstream requires the administrator compliance acknowledgement'
        + ` (version ${status.version}); acknowledge it in the console or set compliance.acceptOnBoot: true.`
        + ` Document: ${status.documentUrlZh ?? status.documentUrlEn ?? 'unavailable'}`,
    )
  }
  const phrase = status.ackPhraseZh ?? status.ackPhraseEn
  if (phrase === undefined) {
    throw new Error(
      'dsh-sub2api-sidecar: upstream requires the administrator compliance acknowledgement'
        + ' but reported no acknowledgement phrase; acknowledge it in the console.',
    )
  }
  await client.acceptCompliance(await login(), phrase, status.ackPhraseZh !== undefined ? 'zh' : 'en')
  logger.info(
    'dsh-sub2api-sidecar: acknowledged upstream compliance %s on boot (document: %s)',
    status.version,
    status.documentUrlZh ?? status.documentUrlEn ?? 'unavailable',
  )
}

/**
 * Run the idempotent bootstrap against a healthy sidecar.
 * @param io - client, seams, config, and admin password.
 * @returns what the run reused or issued.
 * @throws when login is refused, an upstream call fails, or the auth
 * convention check does not hold (the `sk-` key opened an admin endpoint).
 */
export async function ensureBootstrap(io: BootstrapIo): Promise<BootstrapResult> {
  const { client, credentials, logger, config, adminPassword } = io
  const stored: SidecarCredentials = await readStored(credentials, config.credentials)
  let jwt: string | undefined

  /** Log in lazily; at most once per run. */
  const login = async (): Promise<Auth> => {
    if (jwt === undefined) {
      jwt = await client.login(config.adminEmail, adminPassword)
      logger.info('dsh-sub2api-sidecar: logged in as %s for bootstrap', config.adminEmail)
    }
    return { kind: 'bearer', token: jwt }
  }

  let reusedAdminKey = true
  if (stored.adminKey === undefined || !(await adminKeyValid(client, stored.adminKey))) {
    reusedAdminKey = false
    // The compliance gate blocks the reissue itself, and an acknowledged
    // state persists upstream, so the check rides the reissue path only — a
    // boot that reuses a valid key performs no auth round trip at all.
    await ensureComplianceAcknowledgement(client, config, login, logger)
    const adminKey = await client.regenerateAdminApiKey(await login())
    await storeKey(credentials, config.credentials.adminRef, adminKey, logger)
    stored.adminKey = adminKey
    logger.info('dsh-sub2api-sidecar: issued a new admin- management key')
  } else {
    logger.info('dsh-sub2api-sidecar: reusing the stored admin- management key')
  }

  let reusedInferenceKey = true
  let groupId: number | undefined
  if (stored.inferenceKey === undefined || !(await client.gatewayKeyValid(stored.inferenceKey))) {
    reusedInferenceKey = false
    const group = await ensureCompositeGroup(client, await login(), config)
    groupId = group.id
    const inferenceKey = await client.createApiKey(await login(), {
      name: `dsh-${config.route.name}`,
      groupId: group.id,
    })
    await storeKey(credentials, config.credentials.inferenceRef, inferenceKey, logger)
    stored.inferenceKey = inferenceKey
    logger.info('dsh-sub2api-sidecar: issued a new sk- inference key bound to composite group "%s"', config.group.name)
  } else {
    logger.info('dsh-sub2api-sidecar: reusing the stored sk- inference key')
  }

  // Auth-convention check: the sk- key must never open the admin plane. The
  // upstream middleware accepts only the settings-stored admin- key here, so
  // anything but 401 means the deployment's auth split is broken.
  const adminStatus = await client.adminEndpointStatus(stored.inferenceKey)
  if (adminStatus !== 401) {
    throw new Error(
      `dsh-sub2api-sidecar: auth convention violated — the sk- inference key got HTTP ${String(adminStatus)}`
        + ' on an admin endpoint; expected 401. Refusing to register the provider.',
    )
  }

  const writtenProfile = await writeProfile(
    io.settings,
    config.route.name,
    desiredProfile(config, io.serverPort),
    io.lastWrittenProfile,
    logger,
  )

  return {
    reusedAdminKey,
    reusedInferenceKey,
    groupId,
    writtenProfile,
  }
}
