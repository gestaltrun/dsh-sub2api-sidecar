/**
 * Dual-credential storage and reuse. The `admin-` management key and the `sk-`
 * composite inference key are stored once through the credentials seam (whose
 * local provider keeps them in a 0600 file inside 0700 directories) and reused
 * on every later boot; regeneration happens only when a stored key no longer
 * authenticates. Neither key value is ever logged or written to the state file.
 *
 * @module dsh-sub2api-sidecar/credentials
 */

import type { CredentialsService, LoggerLike } from './seam.ts'

/** The two references and their current values, as a boot sees them. */
export interface SidecarCredentials {
  /** Reference for the `admin-` management key. */
  readonly adminRef: string
  /** Reference for the `sk-` inference key. */
  readonly inferenceRef: string
  /** Current admin key value, when the store has one. */
  adminKey: string | undefined
  /** Current inference key value, when the store has one. */
  inferenceKey: string | undefined
}

/**
 * Read both keys from the credential store.
 * @param credentials - the host credentials seam.
 * @param refs - the two configured references.
 * @returns the store's current view of both keys.
 */
export async function readStored(
  credentials: CredentialsService,
  refs: { adminRef: string; inferenceRef: string },
): Promise<SidecarCredentials> {
  const [admin, inference] = await Promise.all([
    credentials.resolve(refs.adminRef),
    credentials.resolve(refs.inferenceRef),
  ])
  return {
    adminRef: refs.adminRef,
    inferenceRef: refs.inferenceRef,
    adminKey: admin?.value,
    inferenceKey: inference?.value,
  }
}

/**
 * Persist one key under its reference.
 * @param credentials - the host credentials seam.
 * @param ref - the reference to store under.
 * @param value - the key value.
 * @param logger - host logger; logs the reference, never the value.
 */
export async function storeKey(
  credentials: CredentialsService,
  ref: string,
  value: string,
  logger: LoggerLike,
): Promise<void> {
  await credentials.set(ref, value)
  logger.info('dsh-sub2api-sidecar: stored credential "%s" (value redacted)', ref)
}
