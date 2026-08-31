/**
 * The injection forwarding plane over real loopback HTTP: injected `x-api-key`
 * with client auth headers stripped, no business endpoints or rewrites
 * (status/headers/body passthrough), explicit 403/404/503/502 outcomes, and no
 * key material in any response body or log line.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { ADMIN_PROXY_PREFIX, registerAdminProxy } from '../src/proxy.ts'
import { FakeCredentials, FakeLogger } from './helpers/world.ts'
import { FakeWebServer } from './helpers/fake-webserver.ts'
import { okEnvelope, startFakeAdminApi } from './helpers/fake-admin-api.ts'
import type { FakeAdminApi } from './helpers/fake-admin-api.ts'

const ADMIN_KEY = 'admin-test-0123456789abcdef'

const servers: Array<FakeAdminApi | FakeWebServer> = []
const tempRoots: string[] = []

afterAll(async () => {
  for (const server of servers) await server.close()
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })))
})

/** Fixture options. */
interface FixtureOptions {
  /** Register the proxy with no live sidecar port (readiness refusal). */
  noSidecar?: boolean
  /** Point the proxy at a concrete port instead of the fake's. */
  sidecarPort?: number
  /** Leave the admin key out of the credential store. */
  withoutKey?: boolean
  /** Observe successful admin mutations. */
  onCatalogMutation?: () => void
}

/** One assembled fixture: fake sidecar, fake web server, credentials, logger, proxy registration. */
async function useFixture(options: FixtureOptions = {}): Promise<{
  webServer: FakeWebServer
  sidecar: FakeAdminApi
  credentials: FakeCredentials
  logger: FakeLogger
  origin: string
}> {
  const sidecar = await startFakeAdminApi({ adminKey: ADMIN_KEY })
  const webServer = new FakeWebServer()
  await webServer.listen()
  servers.push(sidecar, webServer)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sidecar-proxy-'))
  tempRoots.push(root)
  const credentials = new FakeCredentials()
  if (options.withoutKey !== true) credentials.store.set('SUB2API_ADMIN_API_KEY', ADMIN_KEY)
  const logger = new FakeLogger()
  const config = resolveConfig({
    runtimeDir: path.join(root, 'runtime'),
    portRange: { min: sidecar.port, max: sidecar.port },
    proxy: { timeoutMs: 2_000 },
  }, { DSH_HOME: root })
  registerAdminProxy({
    config,
    webServer,
    credentials,
    logger,
    sidecar: { port: options.noSidecar === true ? undefined : options.sidecarPort ?? sidecar.port },
    ...(options.onCatalogMutation === undefined ? {} : { onCatalogMutation: options.onCatalogMutation }),
  })
  return { webServer, sidecar, credentials, logger, origin: `http://127.0.0.1:${String(webServer.port)}` }
}

/** GET one proxy URL with optional extra headers. */
function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { headers: { origin: new URL(url).origin, ...headers } })
}

describe('forwarding and header injection', () => {
  it('injects the admin key, strips client auth headers, and passes the call through', { timeout: 15_000 }, async () => {
    const { webServer, sidecar } = await useFixture()
    sidecar.setRoute('GET /api/v1/admin/settings/admin-api-key', okEnvelope({ exists: true, masked_key: 'admin-te...' }))

    const response = await get(`${webServer.origin}${ADMIN_PROXY_PREFIX}/settings/admin-api-key`, {
      authorization: 'Bearer sk-attacker-key',
      cookie: 'session=attacker',
      'x-api-key': 'admin-client-supplied',
    })
    expect(response.status).toBe(200)
    const payload = await response.json() as { code: number; data: { exists: boolean } }
    expect(payload.code).toBe(0)
    expect(payload.data.exists).toBe(true)

    const forwarded = sidecar.requests.at(-1)
    expect(forwarded?.path).toBe('/api/v1/admin/settings/admin-api-key')
    expect(forwarded?.headers['x-api-key']).toBe(ADMIN_KEY)
    expect(forwarded?.headers['authorization']).toBeUndefined()
    expect(forwarded?.headers['cookie']).toBeUndefined()
    expect(forwarded?.headers['origin']).toBeUndefined()
  })

  it('forwards method, query, and JSON body unchanged', { timeout: 15_000 }, async () => {
    const onCatalogMutation = vi.fn()
    const { webServer, sidecar } = await useFixture({ onCatalogMutation })
    sidecar.setRoute('POST /api/v1/admin/groups', okEnvelope({ id: 1, name: 'g', platform: 'composite' }))

    const response = await fetch(`${webServer.origin}${ADMIN_PROXY_PREFIX}/groups?platform=composite`, {
      method: 'POST',
      headers: { origin: webServer.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'g', platform: 'composite' }),
    })
    expect(response.status).toBe(200)
    const forwarded = sidecar.requests.at(-1)
    expect(forwarded?.method).toBe('POST')
    expect(forwarded?.path).toBe('/api/v1/admin/groups?platform=composite')
    expect(forwarded?.headers['content-type']).toBe('application/json')
    expect(onCatalogMutation).toHaveBeenCalledOnce()
  })

  it('normalizes dot segments inside the prefix and refuses escapes out of it', { timeout: 15_000 }, async () => {
    const { webServer, sidecar } = await useFixture()
    sidecar.setRoute('GET /api/v1/admin/groups', okEnvelope([]))

    const inside = await get(`${webServer.origin}${ADMIN_PROXY_PREFIX}/settings/../groups`)
    expect(inside.status).toBe(200)
    expect(sidecar.requests.at(-1)?.path).toBe('/api/v1/admin/groups')

    const escaped = await get(`${webServer.origin}${ADMIN_PROXY_PREFIX}/../keys`)
    expect(escaped.status).toBe(404)
    expect(sidecar.requests.at(-1)?.path).toBe('/api/v1/admin/groups')
  })
})

describe('upstream passthrough', () => {
  it('relays upstream 401 semantics verbatim, including headers and body', { timeout: 15_000 }, async () => {
    const { webServer, sidecar } = await useFixture()
    sidecar.setRoute('GET /api/v1/admin/step-up', {
      status: 401,
      body: { code: 'STEP_UP_REQUIRED', message: '2fa' },
      headers: { 'x-upstream-marker': 'yes' },
    })
    // The injected key authenticates (the fake's admin gate passes) and the
    // upstream endpoint itself answers 401 step-up, which must reach the
    // caller unchanged: no bypass, no rewrite.
    const response = await get(`${webServer.origin}${ADMIN_PROXY_PREFIX}/step-up`)
    expect(response.status).toBe(401)
    expect(response.headers.get('x-upstream-marker')).toBe('yes')
    const payload = await response.json() as { code: string }
    expect(payload.code).toBe('STEP_UP_REQUIRED')
    expect(sidecar.requests.at(-1)?.headers['x-api-key']).toBe(ADMIN_KEY)
  })
})

describe('refusals', () => {
  it('answers 403 for a cross-origin request and never reaches the sidecar', { timeout: 15_000 }, async () => {
    const { webServer, sidecar } = await useFixture()
    const requestsBefore = sidecar.requests.length
    const response = await fetch(`${webServer.origin}${ADMIN_PROXY_PREFIX}/settings`, {
      headers: { origin: 'http://evil.example' },
    })
    expect(response.status).toBe(403)
    const payload = await response.json() as { code: string }
    expect(payload.code).toBe('PROXY_FORBIDDEN')
    expect(sidecar.requests.length).toBe(requestsBefore)
  })

  it('answers 403 for a non-loopback peer decision (pure check wired into the handler)', { timeout: 15_000 }, async () => {
    // A real non-loopback connection cannot be dialed from this host, so the
    // wired decision is proven through the same pure function the handler
    // calls, alongside the unit suite in trust.spec.ts.
    const { admit } = await import('../src/trust.ts')
    const decision = admit(
      { remoteAddress: '192.168.1.10', origin: undefined, host: '127.0.0.1:5173' },
      { allowedOrigins: new Set<string>() },
    )
    expect(decision).toEqual({ allowed: false, reason: 'loopback-peer' })
  })

  it('answers 503 while the sidecar port is unknown', { timeout: 15_000 }, async () => {
    const fixture = await useFixture({ noSidecar: true })
    const response = await get(`${fixture.webServer.origin}${ADMIN_PROXY_PREFIX}/settings`)
    expect(response.status).toBe(503)
    expect(((await response.json()) as { code: string }).code).toBe('SIDECAR_UNAVAILABLE')
  })

  it('answers 502 when the sidecar port has no listener', { timeout: 15_000 }, async () => {
    const dead = await startFakeAdminApi()
    const deadPort = dead.port
    await dead.close()
    const fixture = await useFixture({ sidecarPort: deadPort })
    const response = await get(`${fixture.webServer.origin}${ADMIN_PROXY_PREFIX}/settings`)
    expect(response.status).toBe(502)
    expect(((await response.json()) as { code: string }).code).toBe('SIDECAR_UNREACHABLE')
  })

  it('answers 503 when the admin key is not provisioned', { timeout: 15_000 }, async () => {
    const fixture = await useFixture({ withoutKey: true })
    const response = await get(`${fixture.webServer.origin}${ADMIN_PROXY_PREFIX}/settings`)
    expect(response.status).toBe(503)
    expect(((await response.json()) as { code: string }).code).toBe('ADMIN_KEY_UNAVAILABLE')
  })
})

describe('no key material in responses or logs', () => {
  it('never echoes the injected key into a body, header, or log line', { timeout: 15_000 }, async () => {
    const { webServer, sidecar, logger } = await useFixture()
    sidecar.setRoute('GET /api/v1/admin/settings/admin-api-key', okEnvelope({ exists: true }))
    const good = await get(`${webServer.origin}${ADMIN_PROXY_PREFIX}/settings/admin-api-key`)
    expect(good.status).toBe(200)
    const forbidden = await get(`${webServer.origin}${ADMIN_PROXY_PREFIX}/settings`, { origin: 'http://evil.example' })
    expect(forbidden.status).toBe(403)

    for (const response of [good, forbidden]) {
      expect(await response.text()).not.toContain(ADMIN_KEY)
      expect([...response.headers.values()].join(',')).not.toContain(ADMIN_KEY)
    }
    for (const line of logger.lines) {
      expect(line).not.toContain(ADMIN_KEY)
    }
  })
})
