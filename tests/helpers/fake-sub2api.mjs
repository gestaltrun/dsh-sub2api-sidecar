#!/usr/bin/env node
// Stand-in for the sub2api binary in tests. Implements the exact API surface
// the bootstrap drives, with the upstream response envelope and auth split:
// admin endpoints accept only the settings-stored admin- key via x-api-key or
// the issued admin JWT via Bearer; the gateway accepts only issued sk- keys.
// State persists to FAKE_STATE_DIR so a later fake process (a simulated HMR
// reload) keeps the keys the previous boot issued.

import fs from 'node:fs'
import http from 'node:http'
import crypto from 'node:crypto'

const stateDir = process.env.FAKE_STATE_DIR
const statePath = `${stateDir}/fake-sub2api-state.json`
const bootMarker = `${stateDir}/sub2api-boots.log`
const shutdownMarker = `${stateDir}/sub2api-stopped`
const envDumpPath = `${stateDir}/sub2api-env.json`

fs.appendFileSync(bootMarker, `${process.pid}\n`)
fs.rmSync(shutdownMarker, { force: true })
fs.writeFileSync(envDumpPath, `${JSON.stringify({
  REDIS_HOST: process.env.REDIS_HOST,
  REDIS_PORT: process.env.REDIS_PORT,
  RUN_MODE: process.env.RUN_MODE,
  SERVER_HOST: process.env.SERVER_HOST,
  DATA_DIR: process.env.DATA_DIR,
}, null, 2)}\n`)

const adminEmail = process.env.FAKE_ADMIN_EMAIL ?? 'admin@sub2api.local'
const adminPassword = process.env.FAKE_ADMIN_PASSWORD ?? 'test-password'

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'))
  } catch {
    return { adminKey: null, jwt: null, groups: [], keys: [], regenerateCount: 0, loginCount: 0, accounts: [], quotaRoutes: {} }
  }
}
function saveState(state) {
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
}
let state = loadState()

function hex() {
  return crypto.randomBytes(32).toString('hex')
}
function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body)
}
function ok(res, data) {
  send(res, 200, { code: 0, message: 'success', data })
}
function bearerToken(req) {
  const header = req.headers['authorization'] ?? ''
  const parts = header.split(' ')
  return parts.length === 2 && parts[0].toLowerCase() === 'bearer' ? parts[1] : ''
}

const server = http.createServer((req, res) => {
  res.on('error', () => {})
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname

    if (path === '/health') {
      // Upstream answers the bare shape (no envelope) on this common route.
      if (process.env.FAKE_HEALTH === 'fail') send(res, 503, { status: 'unavailable' })
      else send(res, 200, { status: 'ok' })
      return
    }

    if (path === '/api/v1/auth/login' && req.method === 'POST') {
      state.loginCount += 1
      if (body.email !== adminEmail || body.password !== adminPassword) {
        send(res, 401, { code: 'UNAUTHORIZED', message: 'invalid email or password' })
        return
      }
      state.jwt = `jwt-${hex().slice(0, 16)}`
      saveState(state)
      ok(res, { access_token: state.jwt, token_type: 'Bearer', expires_in: 86400, user: { email: adminEmail, role: 'admin' } })
      return
    }

    const isAdminPath = path.startsWith('/api/v1/admin/')
    const adminKey = req.headers['x-api-key']
    if (isAdminPath) {
      if (adminKey !== undefined && adminKey !== '') {
        // Upstream convention: only the settings-stored admin- key passes here.
        if (adminKey !== state.adminKey) {
          send(res, 401, { code: 'INVALID_ADMIN_KEY', message: 'Invalid admin API key' })
          return
        }
      } else if (bearerToken(req) !== state.jwt || state.jwt === null) {
        send(res, 401, { code: 'UNAUTHORIZED', message: 'Authorization required' })
        return
      }
    } else if (path === '/api/v1/keys') {
      if (bearerToken(req) !== state.jwt || state.jwt === null) {
        send(res, 401, { code: 'UNAUTHORIZED', message: 'Authorization required' })
        return
      }
    } else if (path === '/v1/models') {
      const key = bearerToken(req) || adminKey || ''
      if (!state.keys.includes(key)) {
        send(res, 401, { code: 'INVALID_API_KEY', message: 'Invalid API key' })
        return
      }
      ok(res, [{ id: 'claude-sonnet-4-5-20250929' }])
      return
    } else {
      send(res, 404, { code: 'NOT_FOUND', message: `no route: ${req.method} ${path}` })
      return
    }

    if (path === '/api/v1/admin/settings/admin-api-key/regenerate' && req.method === 'POST') {
      state.adminKey = `admin-${hex()}`
      state.regenerateCount += 1
      saveState(state)
      ok(res, { key: state.adminKey })
      return
    }
    if (path === '/api/v1/admin/settings/admin-api-key' && req.method === 'GET') {
      ok(res, { exists: state.adminKey !== null, masked_key: state.adminKey === null ? '' : `${state.adminKey.slice(0, 9)}...` })
      return
    }
    if (path === '/api/v1/admin/groups/all' && req.method === 'GET') {
      const platform = url.searchParams.get('platform')
      const groups = platform === null ? state.groups : state.groups.filter((group) => group.platform === platform)
      ok(res, groups)
      return
    }
    // Accounts list plus per-account quota endpoints, preseedable through the
    // state file (`accounts`, `quotaRoutes`) for the host-half services.
    if (path.startsWith('/api/v1/admin/accounts') && req.method === 'GET') {
      const accounts = state.accounts ?? []
      ok(res, { items: accounts, total: accounts.length, page: 1, page_size: 100, pages: 1 })
      return
    }
    if (req.method === 'GET' && state.quotaRoutes && state.quotaRoutes[path] !== undefined) {
      ok(res, state.quotaRoutes[path])
      return
    }
    if (path === '/api/v1/admin/groups' && req.method === 'POST') {
      const group = {
        id: state.groups.length + 1,
        name: body.name,
        platform: body.platform ?? 'anthropic',
        description: body.description ?? '',
        rate_multiplier: body.rate_multiplier ?? 1,
      }
      state.groups.push(group)
      saveState(state)
      ok(res, group)
      return
    }
    if (path === '/api/v1/keys' && req.method === 'POST') {
      const key = `sk-${hex()}`
      state.keys.push(key)
      saveState(state)
      ok(res, { id: state.keys.length, key, name: body.name, group_id: body.group_id, status: 'active' })
      return
    }
    send(res, 404, { code: 'NOT_FOUND', message: `no route: ${req.method} ${path}` })
  })
})

server.listen(Number(process.env.SERVER_PORT), '127.0.0.1')
process.on('SIGTERM', () => {
  fs.writeFileSync(shutdownMarker, `${process.pid}\n`)
  server.close(() => process.exit(0))
  // A server with keep-alive sockets may not close promptly; the marker is
  // already on disk, so exit unconditionally after a short grace.
  setTimeout(() => process.exit(0), 500).unref()
})
