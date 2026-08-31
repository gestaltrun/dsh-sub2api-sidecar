/**
 * The host-side injection forwarding plane. One prefix route on the web
 * server seam maps `/plugins/dsh-sub2api/admin/*` onto the supervised
 * sidecar's `/api/v1/*` and injects the `admin-` management key resolved
 * from the credentials seam on every forwarded call. There are no business
 * endpoints here and nothing is rewritten: method, path, query, body, status,
 * and payload pass through untouched, so upstream 401/403/step-up semantics
 * reach the caller verbatim.
 *
 * Client-supplied authentication and tracking headers are stripped before
 * forwarding and the injected key is never echoed into a response, a log
 * line, or an error message.
 *
 * @module dsh-sub2api-sidecar/proxy
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { admit } from './trust.ts'
import type { TrustPolicy } from './trust.ts'
import type { SidecarConfig } from './config.ts'
import type { CredentialsService, LoggerLike, WebRoute, WebServerService } from './seam.ts'

/** Host-side pathname prefix owned by the admin proxy. */
export const ADMIN_PROXY_PREFIX = '/plugins/dsh-sub2api/admin'

/** Sidecar pathname prefix every proxied call lands on: the upstream admin plane. */
export const UPSTREAM_ADMIN_PREFIX = '/api/v1/admin'

/** Upper bound for one buffered request body; larger uploads are refused with 413. */
export const MAX_PROXY_BODY_BYTES = 64 * 1024 * 1024

/** Request headers never forwarded upstream. */
const STRIPPED_REQUEST_HEADERS = new Set([
  // Hop-by-hop and connection-scoped headers.
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host',
  // Client-supplied credentials and tracking: the plane injects its own key.
  'authorization', 'cookie', 'x-api-key', 'origin', 'referer',
])

/** Response headers never relayed back to the client. */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade',
  // Upstream sessions must not become host-origin cookies: every proxied call
  // authenticates through the injected key instead.
  'set-cookie',
])

/** The live sidecar facts the proxy reads per request; all owned by the supervisor. */
export interface SidecarSource {
  /** The loopback port the supervised server listens on, or undefined while down. */
  readonly port: number | undefined
}

/** Dependencies of one admin proxy registration. */
export interface AdminProxyOptions {
  /** Resolved plugin configuration (proxy group and credentials reference). */
  readonly config: SidecarConfig
  /** The host web server seam to register the prefix route on. */
  readonly webServer: WebServerService
  /** Credential seam resolving the injected `admin-` key. */
  readonly credentials: CredentialsService
  /** Host logger; receives method, path, and status only. */
  readonly logger: LoggerLike
  /** The live sidecar port source. */
  readonly sidecar: SidecarSource
  /** Notify catalog ownership after one successful admin mutation. */
  readonly onCatalogMutation?: () => void
}

/** One registered proxy instance. */
export interface AdminProxyRegistration {
  /** The route registered on the web server seam. */
  readonly route: WebRoute
  /** Stop answering the prefix; the web server seam disposer removes the route. */
  readonly dispose: () => void
}

/**
 * Register the admin proxy prefix route. Admission (loopback peer, trusted
 * origin) runs before anything else; a denied request is answered with 403
 * and never forwarded.
 * @param options - config, seams, and the live sidecar source.
 * @returns the registration with its disposer.
 */
export function registerAdminProxy(options: AdminProxyOptions): AdminProxyRegistration {
  const policy: TrustPolicy = { allowedOrigins: new Set(options.config.proxy.allowedOrigins) }
  const route: WebRoute = {
    kind: 'prefix',
    path: ADMIN_PROXY_PREFIX,
    handler: (req, res) => { void handle(req, res, options, policy) },
  }
  const disposeRoute = options.webServer.register(route)
  return { route, dispose: disposeRoute }
}

/** Answer with a JSON error envelope carrying no request or credential detail. */
export function answerJson(res: ServerResponse, status: number, code: string, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ code, message }))
}

/** The request handler; failures answer 4xx/5xx and never throw past the route. */
async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: AdminProxyOptions,
  policy: TrustPolicy,
): Promise<void> {
  const decision = admit(
    { remoteAddress: req.socket.remoteAddress, origin: req.headers['origin'], host: req.headers['host'] },
    policy,
  )
  if (!decision.allowed) {
    answerJson(res, 403, 'PROXY_FORBIDDEN', 'request is not admitted by the admin proxy')
    return
  }
  const port = options.sidecar.port
  if (port === undefined) {
    answerJson(res, 503, 'SIDECAR_UNAVAILABLE', 'the supervised sidecar is not running')
    return
  }
  const credential = await options.credentials.resolve(options.config.credentials.adminRef)
  if (credential === undefined) {
    answerJson(res, 503, 'ADMIN_KEY_UNAVAILABLE', 'the admin- management key is not provisioned yet')
    return
  }

  let upstreamPath: string
  let requestPath: string
  try {
    const mapped = mapPath(req.url)
    upstreamPath = mapped.upstreamPath
    requestPath = mapped.pathname
  } catch {
    answerJson(res, 404, 'PROXY_NOT_FOUND', 'request path is not under the admin proxy prefix')
    return
  }

  let body: Buffer | undefined
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      body = await readBody(req)
    } catch (error) {
      answerJson(res, error instanceof BodyTooLargeError ? 413 : 400, 'PROXY_BODY_ERROR', 'request body could not be read')
      return
    }
  }

  const headers = forwardRequestHeaders(req)
  headers['x-api-key'] = credential.value
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, options.config.proxy.timeoutMs)
  timer.unref()
  res.on('close', () => { controller.abort() })

  let upstream: Response
  try {
    upstream = await fetch(`http://127.0.0.1:${String(port)}${upstreamPath}`, {
      method: req.method,
      headers,
      body: body === undefined ? undefined : new Uint8Array(body),
      redirect: 'manual',
      signal: controller.signal,
    })
  } catch {
    clearTimeout(timer)
    if (!res.headersSent) {
      answerJson(res, 502, 'SIDECAR_UNREACHABLE', 'the supervised sidecar did not answer')
    } else {
      res.destroy()
    }
    return
  }

  const responseHeaders = relayResponseHeaders(upstream)
  if (upstream.ok && req.method !== 'GET' && req.method !== 'HEAD') options.onCatalogMutation?.()
  res.writeHead(upstream.status, responseHeaders)
  options.logger.info('dsh-sub2api-sidecar: proxy %s %s -> %d', req.method ?? '?', requestPath, upstream.status)
  if (upstream.body === null) {
    res.end()
    clearTimeout(timer)
    return
  }
  const stream = Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream)
  stream.on('error', () => {
    // Mid-stream failure: the status line is already out, so destroy instead
    // of fabricating a body.
    res.destroy()
  })
  stream.pipe(res)
  stream.on('end', () => { clearTimeout(timer) })
}

/**
 * Map the incoming URL onto the sidecar admin path. The URL parser normalizes
 * dot segments before the prefix is matched, so `..` cannot climb out of the
 * mapped subtree.
 * @param rawUrl - the request URL as delivered by the web server seam.
 * @returns the upstream path including the query string and the request
 * pathname for logging.
 * @throws when the pathname is not inside the proxy prefix.
 */
export function mapPath(rawUrl: string | undefined): { upstreamPath: string; pathname: string } {
  const url = new URL(rawUrl ?? '/', 'http://x')
  const pathname = url.pathname
  if (pathname !== ADMIN_PROXY_PREFIX && !pathname.startsWith(`${ADMIN_PROXY_PREFIX}/`)) {
    throw new Error('path outside the admin proxy prefix')
  }
  const rest = pathname.slice(ADMIN_PROXY_PREFIX.length)
  return { upstreamPath: `${UPSTREAM_ADMIN_PREFIX}${rest}${url.search}`, pathname }
}

/** Read one request body into memory, refusing oversized bodies. */
class BodyTooLargeError extends Error {}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.byteLength
    if (size > MAX_PROXY_BODY_BYTES) throw new BodyTooLargeError('request body exceeds the proxy cap')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/** Copy the safe request headers onto the upstream request. */
export function forwardRequestHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value !== 'string' || STRIPPED_REQUEST_HEADERS.has(name)) continue
    headers[name] = value
  }
  return headers
}

/**
 * Copy the upstream response headers that may reach the caller, dropping
 * hop-by-hop headers and upstream session cookies.
 * @param upstream - the upstream response.
 * @returns the relayed header map.
 */
export function relayResponseHeaders(upstream: Response): Record<string, string> {
  const headers: Record<string, string> = {}
  upstream.headers.forEach((value, name) => {
    if (!STRIPPED_RESPONSE_HEADERS.has(name)) headers[name] = value
  })
  return headers
}
