/**
 * A dispatching double of the host web server seam: real `node:http` request
 * handling over a loopback listener with the real service's exact-then-
 * longest-prefix matching, so route registrations and handlers are exercised
 * over the wire exactly as the host would dispatch them.
 *
 * @module tests/helpers/fake-webserver
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { WebRoute, WebServerService } from '../../src/seam.ts'

/** One in-process web server seam double. */
export class FakeWebServer implements WebServerService {
  private readonly exact = new Map<string, WebRoute>()
  private readonly prefixes = new Map<string, WebRoute>()
  private readonly server: Server
  private listenedPort = 0

  constructor() {
    this.server = createServer((req, res) => {
      this.dispatch(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(400)
          res.end()
        } else {
          res.destroy()
        }
      })
    })
  }

  register(route: WebRoute): () => void {
    const table = route.kind === 'exact' ? this.exact : this.prefixes
    if (table.has(route.path)) throw new Error(`duplicate ${route.kind} route "${route.path}"`)
    table.set(route.path, route)
    return () => { table.delete(route.path) }
  }

  /** The listened port after {@link listen}. */
  get port(): number {
    return this.listenedPort
  }

  /** The loopback origin of this listener. */
  get origin(): string {
    return `http://127.0.0.1:${String(this.listenedPort)}`
  }

  /** The bind host, matching the real service's loopback shape. */
  get host(): '127.0.0.1' {
    return '127.0.0.1'
  }

  /** Bind the listener on an OS-assigned loopback port. */
  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject)
        this.listenedPort = (this.server.address() as AddressInfo).port
        resolve()
      })
    })
  }

  /** Close the listener and every open connection. */
  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
      this.server.closeAllConnections()
    })
  }

  /** Dispatch like the real service: exact table first, then longest prefix. */
  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const exact = this.exact.get(pathname)
    if (exact !== undefined) {
      await exact.handler(req, res)
      return
    }
    let best: WebRoute | undefined
    for (const [prefix, route] of this.prefixes) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
      if (best === undefined || prefix.length > best.path.length) best = route
    }
    if (best === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    await best.handler(req, res)
  }
}
