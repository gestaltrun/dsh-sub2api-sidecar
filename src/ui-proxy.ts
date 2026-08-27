/**
 * The embedded-console passthrough. One prefix route on the web server seam
 * maps `/plugins/dsh-sub2api/ui/*` onto the supervised sidecar's root, where
 * the sidecar process serves its own bundled Vue admin console (SPA plus the
 * `/api/*` plane it talks to). Serving the console under the host's own
 * origin is what lets the injection plane carry its authentication: admin
 * paths arriving under this prefix are forwarded with the injected
 * `x-api-key: admin-…` key, exactly like the admin proxy; everything else is
 * forwarded verbatim with no injected credential, so upstream's own
 * unauthenticated/step-up semantics stay authoritative.
 *
 * The renderer never holds the key: it is resolved from the credentials seam
 * per request, forwarded upstream only, and never echoed into a response, a
 * log line, or an error message. Client-supplied authentication headers are
 * stripped, and upstream session cookies never become host-origin cookies.
 *
 * HTML responses (the SPA's `index.html`, including its own SPA-fallback
 * answers for history-mode routes) are transformed for service under the
 * prefix: path-absolute asset references are rebased, and `<base href>` plus
 * the runtime shim are injected (see {@link ui-html}, {@link ui-shim}).
 *
 * @module dsh-sub2api-sidecar/ui-proxy
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { admit } from './trust.ts'
import type { TrustPolicy } from './trust.ts'
import type { SidecarConfig } from './config.ts'
import { answerJson, forwardRequestHeaders, relayResponseHeaders } from './proxy.ts'
import { MAX_PROXY_BODY_BYTES, UPSTREAM_ADMIN_PREFIX } from './proxy.ts'
import type { CredentialsService, LoggerLike, WebRoute, WebServerService } from './seam.ts'
import { transformUiHtml } from './ui-html.ts'
import { UI_EMBED_SHIM } from './ui-shim.ts'

/** Host-side pathname prefix owned by the embedded-console passthrough. */
export const UI_PROXY_PREFIX = '/plugins/dsh-sub2api/ui'

/** The prefix with a trailing slash: the console's base path under the host. */
export const UI_BASE_PATH = `${UI_PROXY_PREFIX}/`

/**
 * Reserved path the passthrough answers itself with the runtime shim script.
 * The shim must be an external same-origin script because upstream's CSP
 * allows scripts from 'self' and nonced inline tags only.
 */
export const UI_SHIM_PATH = '/plugins/dsh-sub2api/ui/dsh-embed-shim.js'

/** The upstream sidecar root path the bare prefix lands on. */
const UPSTREAM_ROOT = '/'

/** Dependencies of one passthrough registration; the same seams the admin proxy takes. */
export interface UiProxyOptions {
  /** Resolved plugin configuration (proxy group and credentials reference). */
  readonly config: SidecarConfig
  /** The host web server seam to register the prefix route on. */
  readonly webServer: WebServerService
  /** Credential seam resolving the injected `admin-` key. */
  readonly credentials: CredentialsService
  /** Host logger; receives method, path, and status only. */
  readonly logger: LoggerLike
  /** The live sidecar port source. */
  readonly sidecar: { readonly port: number | undefined }
}

/** One registered passthrough instance. */
export interface UiProxyRegistration {
  /** The route registered on the web server seam. */
  readonly route: WebRoute
  /** Stop answering the prefix; the web server seam disposer removes the route. */
  readonly dispose: () => void
}

/** One upstream path this surface answers itself instead of forwarding. */
interface AuthStub {
  /** The fabricated `{ code, message, data }` envelope. */
  readonly envelope: unknown
}

/**
 * The embedded session's fabricated auth answers. The upstream SPA's router
 * guard and its session refresh run against these instead of the sidecar's
 * account endpoints, so the embedded console never reaches the login page;
 * the fabricated identity is display-only and authorizes nothing upstream —
 * admin data is fetched with the injected key, non-admin data is refused by
 * upstream itself.
 */
const AUTH_STUBS = new Map<string, AuthStub>([
  ['GET /api/v1/auth/me', { envelope: meEnvelope() }],
  ['POST /api/v1/auth/login', { envelope: sessionEnvelope() }],
  ['POST /api/v1/auth/refresh', { envelope: sessionEnvelope() }],
  ['POST /api/v1/auth/logout', { envelope: { code: 0, message: 'success', data: null } }],
])

/**
 * The display-only embedded admin identity (upstream `User` subset plus the
 * standard run mode). `run_mode: "standard"` keeps the console's full
 * management surface reachable — upstream gates the composite-groups UI on
 * it client-side only, and the admin plane itself is run-mode agnostic; the
 * supervised gateway process stays `RUN_MODE=simple`.
 */
function embeddedUser(): Record<string, unknown> {
  return {
    id: 0,
    username: 'dsh-embedded',
    email: 'dsh-embedded@localhost',
    role: 'admin',
    balance: 0,
    concurrency: 0,
    status: 'active',
    allowed_groups: null,
    balance_notify_enabled: false,
    balance_notify_threshold: null,
    balance_notify_extra_emails: [],
    created_at: '1970-01-01T00:00:00.000Z',
    updated_at: '1970-01-01T00:00:00.000Z',
  }
}

/** The `/auth/me` answer: the identity plus the run mode upstream echoes. */
function meEnvelope(): unknown {
  return { code: 0, message: 'success', data: { ...embeddedUser(), run_mode: 'standard' } }
}

/** The login/refresh answer: a placeholder session over the same identity. */
function sessionEnvelope(): unknown {
  return {
    code: 0,
    message: 'success',
    data: {
      access_token: 'dsh-embedded-session',
      refresh_token: 'dsh-embedded-session',
      token_type: 'Bearer',
      expires_in: 400 * 24 * 60 * 60,
      user: { ...embeddedUser(), run_mode: 'standard' },
    },
  }
}

/** Whether one upstream path is inside the sidecar's admin plane. */
function isAdminPath(upstreamPath: string): boolean {
  const bare = upstreamPath.split('?')[0] ?? ''
  return bare === UPSTREAM_ADMIN_PREFIX || bare.startsWith(`${UPSTREAM_ADMIN_PREFIX}/`)
}

/**
 * Register the embedded-console passthrough prefix route. Admission (loopback
 * peer, trusted origin) runs before anything else; a denied request is
 * answered with 403 and never forwarded.
 * @param options - config, seams, and the live sidecar source.
 * @returns the registration with its disposer.
 */
export function registerUiProxy(options: UiProxyOptions): UiProxyRegistration {
  const policy: TrustPolicy = { allowedOrigins: new Set(options.config.proxy.allowedOrigins) }
  const route: WebRoute = {
    kind: 'prefix',
    path: UI_PROXY_PREFIX,
    handler: (req, res) => { void handle(req, res, options, policy) },
  }
  const disposeRoute = options.webServer.register(route)
  return { route, dispose: disposeRoute }
}

/** The request handler; failures answer 4xx/5xx and never throw past the route. */
async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: UiProxyOptions,
  policy: TrustPolicy,
): Promise<void> {
  const decision = admit(
    { remoteAddress: req.socket.remoteAddress, origin: req.headers['origin'], host: req.headers['host'] },
    policy,
  )
  if (!decision.allowed) {
    answerJson(res, 403, 'UI_FORBIDDEN', 'request is not admitted by the console passthrough')
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
  let adminPlane: boolean
  try {
    const mapped = mapUiPath(req.url)
    upstreamPath = mapped.upstreamPath
    requestPath = mapped.pathname
    adminPlane = mapped.adminPlane
  } catch {
    answerJson(res, 404, 'UI_NOT_FOUND', 'request path is not under the console passthrough prefix')
    return
  }

  // Reserved shim asset, answered here so it stays same-origin ('self' for
  // upstream's script-src) and so the upstream SPA fallback never shadows it.
  if (new URL(`http://x${req.url ?? '/'}`).pathname === UI_SHIM_PATH) {
    res.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-cache',
    })
    res.end(UI_EMBED_SHIM)
    return
  }

  const stub = AUTH_STUBS.get(`${req.method ?? 'GET'} ${upstreamPath.split('?')[0] ?? ''}`)
  if (stub !== undefined) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(stub.envelope))
    options.logger.info('dsh-sub2api-sidecar: ui %s %s -> 200 (embedded session)', req.method ?? '?', requestPath)
    return
  }

  let body: Buffer | undefined
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      body = await readBody(req)
    } catch (error) {
      answerJson(res, error instanceof BodyTooLargeError ? 413 : 400, 'UI_BODY_ERROR', 'request body could not be read')
      return
    }
  }

  const headers = forwardRequestHeaders(req)
  if (adminPlane) headers['x-api-key'] = credential.value
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
  const contentType = upstream.headers.get('content-type') ?? ''
  if (req.method !== 'HEAD' && contentType.startsWith('text/html')) {
    clearTimeout(timer)
    await answerHtml(res, upstream, req.method, options.logger)
    return
  }
  res.writeHead(upstream.status, responseHeaders)
  options.logger.info('dsh-sub2api-sidecar: ui %s %s -> %d', req.method ?? '?', requestPath, upstream.status)
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

/** Relay one HTML response with the base-path transform applied. */
async function answerHtml(
  res: ServerResponse,
  upstream: Response,
  method: string | undefined,
  logger: LoggerLike,
): Promise<void> {
  const html = await upstream.text()
  const headers = relayResponseHeaders(upstream)
  // The upstream ETag brands the untransformed document, so it must not
  // brand the transformed one; upstream serves index.html no-cache.
  delete headers['etag']
  // frame-ancestors 'none' (and X-Frame-Options) forbid every framer; the
  // desktop embed is this surface's purpose, and its admission posture is
  // enforced by the route itself, so the anti-framing directives are dropped
  // on the transformed document.
  if (headers['content-security-policy'] !== undefined) {
    headers['content-security-policy'] = headers['content-security-policy']
      .replace(/frame-ancestors[^;]*;?/gi, '')
      .replace(/;\s*$/, '')
      .trim()
  }
  delete headers['x-frame-options']
  res.writeHead(upstream.status, headers)
  res.end(transformUiHtml(html, UI_BASE_PATH, `<script src="${UI_SHIM_PATH}"></script>`))
  logger.info('dsh-sub2api-sidecar: ui %s -> %d (transformed html)', method ?? '?', upstream.status)
}

/** Read one request body into memory, refusing oversized bodies. */
class BodyTooLargeError extends Error {}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.byteLength
    if (size > MAX_PROXY_BODY_BYTES) throw new BodyTooLargeError('request body exceeds the passthrough cap')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/**
 * Map the incoming URL onto the sidecar root. The URL parser normalizes dot
 * segments before the prefix is matched, so `..` cannot climb out of the
 * mapped subtree.
 * @param rawUrl - the request URL as delivered by the web server seam.
 * @returns the upstream path including the query string, the request
 * pathname for logging, and whether the upstream path is in the admin plane
 * (the only plane the injected key is forwarded on).
 * @throws when the pathname is not under the passthrough prefix.
 */
export function mapUiPath(rawUrl: string | undefined): { upstreamPath: string; pathname: string; adminPlane: boolean } {
  const url = new URL(rawUrl ?? '/', 'http://x')
  const pathname = url.pathname
  if (pathname !== UI_PROXY_PREFIX && !pathname.startsWith(UI_BASE_PATH)) {
    throw new Error('path outside the console passthrough prefix')
  }
  const rest = pathname === UI_PROXY_PREFIX ? UPSTREAM_ROOT : pathname.slice(UI_PROXY_PREFIX.length)
  const upstreamPath = `${rest}${url.search}`
  return { upstreamPath, pathname, adminPlane: isAdminPath(upstreamPath) }
}
