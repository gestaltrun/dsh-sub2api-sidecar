/**
 * Admission control decisions: loopback peer requirement, trusted-origin
 * rules (own origin, configured origins), the Origin-absent Host check that
 * blocks DNS rebinding, and configured-origin normalization.
 */

import { describe, expect, it } from 'vitest'
import { admit, isLoopbackAddress, isLoopbackHost, parseAllowedOrigin } from '../src/trust.ts'

const POLICY = { allowedOrigins: new Set(['https://desktop.example']) }

describe('loopback peer requirement', () => {
  it.each(['127.0.0.1', '127.9.9.9', '::1', '::ffff:127.0.0.1'])('admits loopback peer %s', (address) => {
    expect(isLoopbackAddress(address)).toBe(true)
  })

  it.each(['192.168.1.10', '10.0.0.2', '::ffff:192.168.1.10', 'fe80::1', undefined])('rejects non-loopback peer %s', (address) => {
    const decision = admit({ remoteAddress: address, origin: undefined, host: '127.0.0.1:5173' }, POLICY)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('loopback-peer')
  })
})

describe('origin rules', () => {
  it('admits the host’s own origin', () => {
    const decision = admit(
      { remoteAddress: '127.0.0.1', origin: 'http://127.0.0.1:5173', host: '127.0.0.1:5173' },
      POLICY,
    )
    expect(decision).toEqual({ allowed: true, reason: 'ok' })
  })

  it('admits a configured origin', () => {
    const decision = admit(
      { remoteAddress: '127.0.0.1', origin: 'https://desktop.example', host: '127.0.0.1:5173' },
      POLICY,
    )
    expect(decision).toEqual({ allowed: true, reason: 'ok' })
  })

  it('rejects another loopback port: a different browser origin', () => {
    const decision = admit(
      { remoteAddress: '127.0.0.1', origin: 'http://localhost:9999', host: '127.0.0.1:5173' },
      POLICY,
    )
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('untrusted-origin')
  })

  it('rejects a malformed origin', () => {
    const decision = admit(
      { remoteAddress: '127.0.0.1', origin: 'not-an-origin', host: '127.0.0.1:5173' },
      POLICY,
    )
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('invalid-origin')
  })
})

describe('origin-absent requests', () => {
  it('admits a loopback Host header', () => {
    const decision = admit({ remoteAddress: '127.0.0.1', origin: undefined, host: 'localhost:5173' }, POLICY)
    expect(decision).toEqual({ allowed: true, reason: 'ok' })
  })

  it('rejects a rebound non-loopback Host header', () => {
    const decision = admit({ remoteAddress: '127.0.0.1', origin: undefined, host: 'attacker.example' }, POLICY)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('untrusted-host')
  })
})

describe('host helpers', () => {
  it('recognizes loopback hosts with or without ports', () => {
    expect(isLoopbackHost('127.0.0.1:45123')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('[::1]:5173')).toBe(true)
    expect(isLoopbackHost('attacker.example')).toBe(false)
  })

  it('normalizes configured origins and rejects non-origins', () => {
    expect(parseAllowedOrigin('https://desktop.example/')).toBe('https://desktop.example')
    expect(() => parseAllowedOrigin('file:///x')).toThrow(/http\(s\)/)
    expect(() => parseAllowedOrigin('https://desktop.example/path')).toThrow(/bare origin/)
  })
})
