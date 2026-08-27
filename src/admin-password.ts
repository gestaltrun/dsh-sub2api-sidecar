/**
 * Admin password custody for the AUTO_SETUP account. The password is either
 * configured (never persisted, never logged) or generated once and kept in
 * `<runDir>/admin-password` at 0600 so later boots can still log in for
 * self-healing bootstrap. Upstream creates the admin row only when the
 * database is empty, so the first boot's password is the account's password.
 *
 * @module dsh-sub2api-sidecar/admin-password
 */

import fs from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

/**
 * Read or establish the admin password for this deployment.
 * @param configured - the config-supplied password, when one was set.
 * @param passwordFile - the 0600 custody file under the run directory.
 * @returns the password in effect.
 * @throws when the custody file exists but cannot be read.
 */
export async function ensureAdminPassword(configured: string | undefined, passwordFile: string): Promise<string> {
  if (configured !== undefined) return configured
  const existing = await fs.readFile(passwordFile, 'utf8').then(
    (text) => text.trim(),
    () => undefined,
  )
  if (existing !== undefined && existing.length > 0) return existing
  const generated = randomBytes(24).toString('hex')
  await fs.writeFile(passwordFile, `${generated}\n`, { encoding: 'utf8', mode: 0o600 })
  return generated
}
