/**
 * In-process fake of the sidecar admin API surface the proxy and the quota
 * poller drive: the upstream `{ code, message, data }` envelope, the
 * admin-key auth split on `/api/v1/admin/*`, and a per-request record of what
 * actually arrived (method, path, headers) for injection and stripping
 * assertions.
 *
 * @module tests/helpers/fake-admin-api
 */

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One request that reached the fake, recorded for assertions. */
export interface RecordedRequest {
  /** HTTP method. */
  method: string
  /** Path including the query string. */
  path: string
  /** Request headers as received (lowercased names, raw values). */
  headers: Record<string, string | string[] | undefined>
}

/** One canned route answer. */
export interface FakeRoute {
  /** HTTP status to answer. */
  status: number
  /** JSON body to answer with. */
  body: unknown
  /** Extra response headers. */
  headers?: Record<string, string>
}

/** One started fake admin API. */
export interface FakeAdminApi {
  /** The OS-assigned loopback port. */
  readonly port: number
  /** Every request received so far, in arrival order. */
  readonly requests: RecordedRequest[]
  /** Register or replace one canned route (`METHOD /path`). */
  setRoute(key: string, route: FakeRoute): void
  /** Remove one canned route. */
  removeRoute(key: string): void
  /** Set the admin key the fake enforces on admin paths; undefined disables enforcement. */
  setAdminKey(adminKey: string | undefined): void
  /** Make every admin answer fail until {@link setAdminKey} is called again. */
  failAdmin(fail: boolean): void
  /** Close the listener and every open connection. */
  close(): Promise<void>
}

/** Options for one fake admin API. */
export interface FakeAdminApiOptions {
  /** The admin key enforced on `/api/v1/admin/*`; omit to disable enforcement. */
  adminKey?: string
}

/**
 * Start one fake admin API on an OS-assigned loopback port.
 * @param options - the admin key to enforce, if any.
 * @returns the fake handle.
 */
export async function startFakeAdminApi(options: FakeAdminApiOptions = {}): Promise<FakeAdminApi> {
  const requests: RecordedRequest[] = []
  const routes = new Map<string, FakeRoute>()
  let adminKey: string | undefined = options.adminKey
  let failing = false

  const server: Server = createServer((req, res) => {
    res.on('error', () => {})
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const path = req.url ?? '/'
      requests.push({ method: req.method ?? '?', path, headers: req.headers })
      const answer = (): void => {
        if (failing) {
          send(res, 503, { code: 'FAKE_DOWN', message: 'fake admin api is failing' })
          return
        }
        const isAdmin = path.startsWith('/api/v1/admin/')
        if (isAdmin && adminKey !== undefined && req.headers['x-api-key'] !== adminKey) {
          send(res, 401, { code: 'INVALID_ADMIN_KEY', message: 'Invalid admin API key' })
          return
        }
        const route = routes.get(`${req.method} ${path.split('?')[0] ?? ''}`)
        if (route === undefined) {
          send(res, 404, { code: 'NOT_FOUND', message: `no route: ${String(req.method)} ${path}` })
          return
        }
        for (const [name, value] of Object.entries(route.headers ?? {})) res.setHeader(name, value)
        send(res, route.status, route.body)
      }
      // Respond a tick later so concurrent request records settle first.
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

  const port = (server.address() as AddressInfo).port
  return {
    port,
    requests,
    setRoute(key: string, route: FakeRoute): void { routes.set(key, route) },
    removeRoute(key: string): void { routes.delete(key) },
    setAdminKey(next: string | undefined): void { adminKey = next },
    failAdmin(next: boolean): void { failing = next },
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  }
}

/** Send one JSON answer. */
function send(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Convenience builders for the upstream envelope. */
export function okEnvelope(data: unknown): FakeRoute {
  return { status: 200, body: { code: 0, message: 'success', data } }
}
