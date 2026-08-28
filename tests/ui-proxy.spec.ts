/**
 * The embedded-console passthrough over real loopback HTTP: the HTML
 * transform (base href + shim injection, path-absolute asset rebasing),
 * byte-identical asset mapping, the sidecar's own SPA fallback relayed under
 * the prefix, admin-plane key injection (non-admin forwarding stays
 * credential-free), host-side embedded-session answers, the shared admission
 * posture, and the explicit refusals.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolveConfig } from '../src/config.ts'
import { UI_BASE_PATH, UI_PROXY_PREFIX, UI_SHIM_PATH, mapUiPath, registerUiProxy } from '../src/ui-proxy.ts'
import { UI_EMBED_SHIM } from '../src/ui-shim.ts'
import { FakeCredentials, FakeLogger } from './helpers/world.ts'
import { FakeWebServer } from './helpers/fake-webserver.ts'

const ADMIN_KEY = 'admin-test-0123456789abcdef'

/** The upstream index.html the fake sidecar serves, with absolute assets and injected config. */
const INDEX_HTML = [
  '<!doctype html>',
  '<html lang="zh-CN">',
  '  <head>',
  '    <meta charset="UTF-8" />',
  '    <link rel="icon" type="image/svg+xml" href="/logo.svg" />',
  '    <title>Sub2API</title>',
  '    <script type="module" crossorigin src="/assets/index-ABC123.js"></script>',
  '    <link rel="stylesheet" crossorigin href="/assets/index-DEF456.css">',
  '    <script>window.__APP_CONFIG__={"site_logo":"/logo.svg"};</script>',
  '  </head>',
  '  <body><div id="app"></div></body>',
  '</html>',
].join('\n')

const ASSET_JS = 'console.log("spa-entry")\n'

/** One request that reached the fake sidecar, recorded for assertions. */
interface RecordedRequest {
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

/** One started fake sidecar serving the SPA root plus the admin API. */
interface FakeSidecar {
  readonly port: number
  readonly requests: RecordedRequest[]
  close(): Promise<void>
}

/**
 * Start the fake sidecar: the SPA surface (index.html at `/` and for unknown
 * paths — the upstream SPA fallback — plus static assets) and an admin plane
 * that enforces the admin key exactly like upstream.
 */
async function startFakeSidecar(): Promise<FakeSidecar> {
  const requests: RecordedRequest[] = []
  const server: Server = createServer((req, res) => {
    res.on('error', () => {})
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const rawPath = req.url ?? '/'
      requests.push({
        method: req.method ?? '?',
        path: rawPath,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      const pathname = rawPath.split('?')[0] ?? '/'
      const answer = (): void => {
        if (pathname.startsWith('/api/v1/admin/')) {
          if (req.headers['x-api-key'] !== ADMIN_KEY) {
            res.writeHead(401, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ code: 'INVALID_ADMIN_KEY', message: 'Invalid admin API key' }))
            return
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ code: 0, message: 'success', data: { exists: true } }))
          return
        }
        if (pathname === '/' || pathname.startsWith('/admin') === true && !pathname.startsWith('/assets')) {
          // `/` and every unknown non-asset path fall back to the SPA shell.
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            etag: 'W/"fake-index"',
            'content-security-policy':
              "default-src 'self'; script-src 'self' 'nonce-fake=='; frame-ancestors 'none'; base-uri 'self'",
          })
          res.end(INDEX_HTML)
          return
        }
        if (pathname === '/assets/index-ABC123.js') {
          res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
          res.end(ASSET_JS)
          return
        }
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'no route' }))
      }
      setTimeout(answer, 0)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
}

const sidecars: FakeSidecar[] = []
const webServers: FakeWebServer[] = []
const tempRoots: string[] = []

afterAll(async () => {
  for (const sidecar of sidecars) await sidecar.close()
  for (const webServer of webServers) await webServer.close()
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })))
})

/** Fixture options. */
interface FixtureOptions {
  /** Register the passthrough with no live sidecar port. */
  noSidecar?: boolean
  /** Point the passthrough at a concrete port instead of the fake's. */
  sidecarPort?: number
  /** Leave the admin key out of the credential store. */
  withoutKey?: boolean
}

/** One assembled fixture. */
async function useFixture(options: FixtureOptions = {}): Promise<{
  webServer: FakeWebServer
  sidecar: FakeSidecar
  logger: FakeLogger
  origin: string
}> {
  const sidecar = await startFakeSidecar()
  sidecars.push(sidecar)
  const webServer = new FakeWebServer()
  await webServer.listen()
  webServers.push(webServer)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sidecar-ui-'))
  tempRoots.push(root)
  const credentials = new FakeCredentials()
  if (options.withoutKey !== true) credentials.store.set('SUB2API_ADMIN_API_KEY', ADMIN_KEY)
  const logger = new FakeLogger()
  const config = resolveConfig({
    runtimeDir: path.join(root, 'runtime'),
    portRange: { min: sidecar.port, max: sidecar.port },
    proxy: { timeoutMs: 2_000 },
  }, { DSH_HOME: root })
  registerUiProxy({
    config,
    webServer,
    credentials,
    logger,
    sidecar: { port: options.noSidecar === true ? undefined : options.sidecarPort ?? sidecar.port },
  })
  return { webServer, sidecar, logger, origin: `http://127.0.0.1:${String(webServer.port)}` }
}

/** GET one passthrough URL with optional extra headers. */
function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { headers: { origin: new URL(url).origin, ...headers } })
}

describe('html transform', () => {
  it('injects base href and the shim script, rebases assets, and drops anti-framing CSP', { timeout: 15_000 }, async () => {
    const { webServer, sidecar } = await useFixture()
    const response = await get(`${webServer.origin}${UI_BASE_PATH}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('etag')).toBeNull()
    const csp = response.headers.get('content-security-policy') ?? ''
    expect(csp).not.toContain('frame-ancestors')
    expect(csp).toContain("script-src 'self' 'nonce-fake=='")
    expect(response.headers.get('x-frame-options')).toBeNull()
    const body = await response.text()
    expect(body).toContain('<base href="/plugins/dsh-sub2api/ui/">')
    expect(body).toContain(`<script src="${UI_SHIM_PATH}"></script>`)
    expect(body).not.toContain(UI_EMBED_SHIM.slice(0, 40))
    expect(body).toContain(`src="${UI_BASE_PATH}assets/index-ABC123.js"`)
    expect(body).toContain(`href="${UI_BASE_PATH}logo.svg"`)
    expect(body).toContain(`href="${UI_BASE_PATH}assets/index-DEF456.css"`)
    // Injected inline config JSON keeps its path-absolute value untouched.
    expect(body).toContain('{"site_logo":"/logo.svg"}')
    // The base tag lands in the head, before the entry module script.
    expect(body.indexOf('<base href=')).toBeLessThan(body.indexOf('src='))
    expect(sidecar.requests.at(-1)?.path).toBe('/')
  })

  it('answers the reserved shim asset itself', { timeout: 15_000 }, async () => {
    const { webServer, sidecar } = await useFixture()
    const response = await get(`${webServer.origin}${UI_SHIM_PATH}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('javascript')
    expect(await response.text()).toBe(UI_EMBED_SHIM)
    expect(sidecar.requests.at(-1)).toBeUndefined()
  })

  it('serves the bare prefix without a trailing slash as the SPA root', { timeout: 15_000 }, async () => {
    const { webServer, sidecar } = await useFixture()
    const response = await get(`${webServer.origin}${UI_PROXY_PREFIX}`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<base href=')
    expect(sidecar.requests.at(-1)?.path).toBe('/')
  })

  it('relays the sidecar SPA fallback for history-mode routes, transformed', { timeout: 15_000 }, async () => {
    const { webServer, sidecar } = await useFixture()
    const response = await get(`${webServer.origin}${UI_BASE_PATH}admin/dashboard`)
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('<base href=')
    expect(sidecar.requests.at(-1)?.path).toBe('/admin/dashboard')
  })

  it('leaves HEAD answers header-only', { timeout: 15_000 }, async () => {
    const { webServer } = await useFixture()
    const response = await fetch(`${webServer.origin}${UI_BASE_PATH}`, { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
  })
})

describe('asset and api mapping', () => {
  it('maps assets byte-identically onto the sidecar root', { timeout: 15_000 }, async () => {
    const { webServer, sidecar } = await useFixture()
    const response = await get(`${webServer.origin}${UI_BASE_PATH}assets/index-ABC123.js`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(ASSET_JS)
    const forwarded = sidecar.requests.at(-1)
    expect(forwarded?.path).toBe('/assets/index-ABC123.js')
  })

  it('injects the admin key only on the upstream admin plane', { timeout: 15_000 }, async () => {
    const { webServer, sidecar } = await useFixture()
    const admin = await get(`${webServer.origin}${UI_BASE_PATH}api/v1/admin/settings/admin-api-key`, {
      authorization: 'Bearer client-supplied',
    })
    expect(admin.status).toBe(200)
    const adminCall = sidecar.requests.at(-1)
    expect(adminCall?.path).toBe('/api/v1/admin/settings/admin-api-key')
    expect(adminCall?.headers['x-api-key']).toBe(ADMIN_KEY)
    expect(adminCall?.headers['authorization']).toBeUndefined()

    const plain = await get(`${webServer.origin}${UI_BASE_PATH}api/v1/settings/public`)
    expect(plain.status).toBe(404)
    const plainCall = sidecar.requests.at(-1)
    expect(plainCall?.path).toBe('/api/v1/settings/public')
    expect(plainCall?.headers['x-api-key']).toBeUndefined()
  })

  it('answers the embedded-session auth endpoints itself and never forwards them', { timeout: 15_000 }, async () => {
    const { webServer, sidecar } = await useFixture()
    const before = sidecar.requests.length
    const me = await get(`${webServer.origin}${UI_BASE_PATH}api/v1/auth/me`)
    expect(me.status).toBe(200)
    const meBody = await me.json() as { code: number; data: { role: string; run_mode: string } }
    expect(meBody.code).toBe(0)
    expect(meBody.data.role).toBe('admin')
    expect(meBody.data.run_mode).toBe('standard')

    const login = await fetch(`${webServer.origin}${UI_BASE_PATH}api/v1/auth/login`, {
      method: 'POST',
      headers: { origin: webServer.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.c', password: 'x' }),
    })
    expect(login.status).toBe(200)
    const loginBody = await login.json() as { code: number; data: { token_type: string; user: { role: string } } }
    expect(loginBody.data.token_type).toBe('Bearer')
    expect(loginBody.data.user.role).toBe('admin')

    const refresh = await fetch(`${webServer.origin}${UI_BASE_PATH}api/v1/auth/refresh`, {
      method: 'POST',
      headers: { origin: webServer.origin },
    })
    expect(refresh.status).toBe(200)
    expect(sidecar.requests.slice(before)).toHaveLength(0)
  })

  it('never echoes the injected key into a transformed page, stub, or log line', { timeout: 15_000 }, async () => {
    const { webServer, sidecar, logger } = await useFixture()
    sidecar.requests.length = 0
    const page = await get(`${webServer.origin}${UI_BASE_PATH}`)
    const stub = await get(`${webServer.origin}${UI_BASE_PATH}api/v1/auth/me`)
    for (const response of [page, stub]) {
      expect(await response.text()).not.toContain(ADMIN_KEY)
    }
    for (const line of logger.lines) expect(line).not.toContain(ADMIN_KEY)
  })
})

describe('admission and refusals', () => {
  it('answers 403 for a cross-origin request and never reaches the sidecar', { timeout: 15_000 }, async () => {
    const { webServer, sidecar } = await useFixture()
    const requestsBefore = sidecar.requests.length
    const response = await fetch(`${webServer.origin}${UI_BASE_PATH}`, {
      headers: { origin: 'http://evil.example' },
    })
    expect(response.status).toBe(403)
    expect(((await response.json()) as { code: string }).code).toBe('UI_FORBIDDEN')
    expect(sidecar.requests.length).toBe(requestsBefore)
  })

  it('answers 503 while the sidecar port is unknown', { timeout: 15_000 }, async () => {
    const fixture = await useFixture({ noSidecar: true })
    const response = await get(`${fixture.webServer.origin}${UI_BASE_PATH}`)
    expect(response.status).toBe(503)
    expect(((await response.json()) as { code: string }).code).toBe('SIDECAR_UNAVAILABLE')
  })

  it('answers 502 when the sidecar port has no listener', { timeout: 15_000 }, async () => {
    const dead = await startFakeSidecar()
    const deadPort = dead.port
    await dead.close()
    const fixture = await useFixture({ sidecarPort: deadPort })
    const response = await get(`${fixture.webServer.origin}${UI_BASE_PATH}`)
    expect(response.status).toBe(502)
    expect(((await response.json()) as { code: string }).code).toBe('SIDECAR_UNREACHABLE')
  })

  it('answers 503 when the admin key is not provisioned', { timeout: 15_000 }, async () => {
    const fixture = await useFixture({ withoutKey: true })
    const response = await get(`${fixture.webServer.origin}${UI_BASE_PATH}`)
    expect(response.status).toBe(503)
    expect(((await response.json()) as { code: string }).code).toBe('ADMIN_KEY_UNAVAILABLE')
  })

  it('normalizes dot segments inside the prefix and refuses escapes out of it', { timeout: 15_000 }, async () => {
    const { webServer, sidecar } = await useFixture()
    const inside = await get(`${webServer.origin}${UI_BASE_PATH}assets/../admin/dashboard`)
    expect(inside.status).toBe(200)
    expect(sidecar.requests.at(-1)?.path).toBe('/admin/dashboard')

    const escaped = await get(`${webServer.origin}${UI_PROXY_PREFIX}/../admin/settings`)
    // The escape lands outside the passthrough prefix; this fixture has no
    // route there, so the web server answers its bare 404.
    expect(escaped.status).toBe(404)
    expect(sidecar.requests.at(-1)?.path).toBe('/admin/dashboard')
  })
})

describe('path mapping', () => {
  it('maps the prefix onto the root and flags the admin plane', () => {
    expect(mapUiPath('/plugins/dsh-sub2api/ui')).toEqual({
      upstreamPath: '/', pathname: '/plugins/dsh-sub2api/ui', adminPlane: false,
    })
    expect(mapUiPath('/plugins/dsh-sub2api/ui/api/v1/admin/groups?platform=x')).toEqual({
      upstreamPath: '/api/v1/admin/groups?platform=x',
      pathname: '/plugins/dsh-sub2api/ui/api/v1/admin/groups',
      adminPlane: true,
    })
    expect(mapUiPath('/plugins/dsh-sub2api/ui/api/v1/admin').adminPlane).toBe(true)
    expect(mapUiPath('/plugins/dsh-sub2api/ui/assets/x.js').adminPlane).toBe(false)
    expect(() => mapUiPath('/plugins/dsh-sub2api/other')).toThrow()
  })
})
