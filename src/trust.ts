/**
 * Admission control for the host-side HTTP surfaces this plugin registers on
 * the web server seam: the admin proxy prefix and the quota snapshot route.
 * A request is admitted only from a loopback peer carrying a trusted origin,
 * the same posture the harness web client plugins apply to privileged routes.
 *
 * The check runs before any forwarding or snapshot read, so a denied request
 * never reaches the sidecar and never produces a response or log line that
 * carries credential material.
 *
 * @module dsh-sub2api-sidecar/trust
 */

/**
 * The request facts admission needs, taken from the connection and headers.
 * `remoteAddress` is the kernel-reported peer address and cannot be spoofed
 * by headers; `origin` and `host` are the client-supplied `Origin` and
 * `Host` header values.
 */
export interface RequestFacts {
  /** Peer address of the TCP connection; absent on a half-open socket. */
  readonly remoteAddress: string | undefined
  /** The request's `Origin` header; absent on non-browser and navigation requests. */
  readonly origin: string | undefined
  /** The request's `Host` header (`host[:port]`). */
  readonly host: string | undefined
}

/** The trust policy admission enforces for one route. */
export interface TrustPolicy {
  /** Additional absolute origins trusted besides the host's own. */
  readonly allowedOrigins: ReadonlySet<string>
}

/** One admission outcome; `allowed: false` carries the denial reason code. */
export interface AdmissionDecision {
  /** Whether the request may reach the protected surface. */
  readonly allowed: boolean
  /** Stable denial code; `loopback-peer`, `invalid-origin`, `untrusted-origin`, or `untrusted-host`. */
  readonly reason: string
}

/** Loopback IPv4 addresses: the whole 127.0.0.0/8 block. */
const IPV4_LOOPBACK = /^127\.(?:\d{1,3}\.){2}\d{1,3}$/

/** Hostnames a browser may use to reach a loopback server (no port). */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * Check whether a peer address is a loopback address.
 * @param remoteAddress - the kernel-reported peer address.
 * @returns true for 127.0.0.0/8, `::1`, and the IPv4-mapped loopback form.
 */
export function isLoopbackAddress(remoteAddress: string): boolean {
  if (remoteAddress === '::1') return true
  const mapped = remoteAddress.startsWith('::ffff:') ? remoteAddress.slice('::ffff:'.length) : remoteAddress
  return IPV4_LOOPBACK.test(mapped)
}

/**
 * Check whether an origin or host header names a loopback host.
 * @param hostOrOriginHost - a `host[:port]` value, IPv6 hosts in brackets.
 * @returns true when the host part is a loopback literal or `localhost`.
 */
export function isLoopbackHost(hostOrOriginHost: string): boolean {
  const host = hostOrOriginHost.replace(/:\d+$/, '')
  return LOOPBACK_HOSTNAMES.has(host)
}

/**
 * Decide whether one request may reach a protected surface. Denied requests
 * must be answered with 403 and no diagnostics beyond the reason code.
 * @param facts - connection peer and header facts.
 * @param policy - the route's trust policy.
 * @returns the admission decision.
 */
export function admit(facts: RequestFacts, policy: TrustPolicy): AdmissionDecision {
  if (facts.remoteAddress === undefined || !isLoopbackAddress(facts.remoteAddress)) {
    return { allowed: false, reason: 'loopback-peer' }
  }
  if (facts.origin === undefined) {
    // No Origin header: the caller is not a page fetch. A DNS-rebinding
    // attack arrives exactly this way, so the Host header must still name a
    // loopback host for the request to be trusted.
    if (facts.host === undefined || !isLoopbackHost(facts.host)) {
      return { allowed: false, reason: 'untrusted-host' }
    }
    return { allowed: true, reason: 'ok' }
  }
  let origin: string
  try {
    origin = new URL(facts.origin).origin
  } catch {
    return { allowed: false, reason: 'invalid-origin' }
  }
  if (policy.allowedOrigins.has(origin)) return { allowed: true, reason: 'ok' }
  // Same-origin requests carry the host's own origin; anything else —
  // including other loopback ports, which are a different origin to a
  // browser — is untrusted.
  if (facts.host !== undefined && origin === `http://${facts.host}`) return { allowed: true, reason: 'ok' }
  return { allowed: false, reason: 'untrusted-origin' }
}

/**
 * Parse one configured origin string into its absolute origin form.
 * @param value - a configured `scheme://host[:port]` value.
 * @returns the normalized origin.
 * @throws when the value is not an absolute http(s) origin.
 */
export function parseAllowedOrigin(value: string): string {
  const parsed = new URL(value)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`dsh-sub2api-sidecar: allowed origin must be http(s): ${value}`)
  }
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '' || parsed.username !== '' || parsed.password !== '') {
    throw new Error(`dsh-sub2api-sidecar: allowed origin must be a bare origin without path, query, or credentials: ${value}`)
  }
  return parsed.origin
}
