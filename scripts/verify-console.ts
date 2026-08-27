/**
 * Local verification rig for the embedded console (not part of the shipped
 * package; run with tsx). Assembles the real composition the desktop runs —
 * real subprocess provider, file-backed credentials, real loopback web
 * server dispatch, built `lib/` — against the real runtime pack, and serves
 * a minimal embed-fixture page that loads the built client bundle through a
 * module-loader double so a real browser can exercise the settings section.
 *
 * @module scripts/verify-console
 */

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME_DIR = process.env['VERIFY_RUNTIME_DIR'] ?? `${os.homedir()}/.dsh/sub2api`
const FIXTURE_NS = '/plugins/dsh-sub2api/embed-fixture'

/** File-backed credentials store (0600), stable across rig restarts. */
class FileCredentials {
  private readonly filePath: string
  private readonly store = new Map<string, string>()

  constructor(filePath: string) {
    this.filePath = filePath
  }

  async load(): Promise<void> {
    const text = await fsp.readFile(this.filePath, 'utf8').catch(() => null)
    if (text === null) return
    const parsed = JSON.parse(text) as Record<string, string>
    for (const [key, value] of Object.entries(parsed)) this.store.set(key, value)
  }

  async resolve(ref: string): Promise<{ value: string; source: string } | undefined> {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'verify-file' }
  }

  async set(ref: string, value: string): Promise<void> {
    this.store.set(ref, value)
    await fsp.writeFile(this.filePath, `${JSON.stringify(Object.fromEntries(this.store), null, 2)}\n`, { mode: 0o600 })
  }
}

/** Wait until the snapshot reports ready, or fail with the last payload. */
async function waitUntilReady(origin: string): Promise<void> {
  for (let i = 0; i < 240; i++) {
    const response = await fetch(`${origin}/plugins/dsh-sub2api/quota-snapshot`)
    const body = await response.json() as { status: string; reason?: string }
    if (body.status === 'ready') return
    if (i % 20 === 0) console.log(`[verify] snapshot: ${body.status} (${body.reason ?? 'ok'})`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('snapshot never became ready')
}

async function main(): Promise<void> {
  const { makeSubprocessService } = await import('../tests/helpers/subprocess-local.ts')
  const { FakeWebServer } = await import('../tests/helpers/fake-webserver.ts')
  const plugin = await import('../lib/index.js')

  const credentials = new FileCredentials(path.join(RUNTIME_DIR, 'run', 'verify-credentials.json'))
  await credentials.load()
  const webServer = new FakeWebServer()
  await webServer.listen()
  const origin = `http://127.0.0.1:${String(webServer.port)}`

  const clientJs = await fsp.readFile(path.join(PACKAGE_ROOT, 'lib', 'client.js'), 'utf8')

  // Embed fixture: a module-loader double plus minimal slots/locale service
  // doubles, so the built client bundle runs its real apply and the section
  // component renders against the real host routes.
  const fixtureHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>订阅账号池 embed fixture</title>
<script src="${FIXTURE_NS}/react"></script>
<script>
window.__DSH_FIXTURE_TABLE__ = {
  'react': () => window.React,
  'react/jsx-runtime': () => ({
    Fragment: window.React.Fragment,
    jsx: (type, config, key) => window.React.createElement(type, key === undefined ? config : { ...config, key }, config.children),
    jsxs: (type, config, key) => window.React.createElement(type, key === undefined ? config : { ...config, key }, config.children),
  }),
}
window.__ModuleLoader__ = {
  factories: {},
  load({ id, factory }) { this.factories[id] = factory },
  instantiate(id) {
    return this.factories[id]((name) => window.__DSH_FIXTURE_TABLE__[name]())
  },
}
</script>
<script src="${FIXTURE_NS}/client.js"></script>
</head><body>
<div style="height: 90vh; border: 1px solid #ddd; position: relative;">
  <div id="root" style="height: 100%;"></div>
</div>
<script>
(async () => {
  const mod = window.__ModuleLoader__.instantiate('dsh-sub2api-sidecar')
  const contributions = []
  const dictionaries = {}
  const ctx = {
    effect: (execute) => execute(),
    locale: {
      register: (ns, dict) => { dictionaries[ns] = dict; return () => {} },
      bind: (ns) => (key) => (dictionaries[ns] && dictionaries[ns].zh && dictionaries[ns].zh[key]) || key,
    },
    slots: {
      register: (options, component) => { contributions.push({ options, component }); return () => {} },
      inject: (slot, register) => { register() },
    },
  }
  mod.apply(ctx)
  const section = contributions.find((c) => c.options.id === 'sub2api')
  window.__DSH_FIXTURE__ = { contributions, section, mod }
  const root = window.ReactDOM.createRoot(document.getElementById('root'))
  root.render(window.React.createElement(section.component, { t: (k) => k }))
})()
</script>
</body></html>`

  webServer.register({
    kind: 'exact',
    path: FIXTURE_NS,
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(fixtureHtml)
    },
  })
  webServer.register({
    kind: 'exact',
    path: `${FIXTURE_NS}/client.js`,
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
      res.end(clientJs)
    },
  })
  webServer.register({
    kind: 'exact',
    path: `${FIXTURE_NS}/react`,
    handler: async (_req, res) => {
      const umd = path.join(PACKAGE_ROOT, 'node_modules', 'react', 'umd', 'react.production.min.js')
      const text = await fsp.readFile(umd, 'utf8').catch(() => 'window.React = window.React || {}')
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
      res.end(text)
    },
  })

  const context = {
    subprocess: makeSubprocessService(),
    credentials,
    settings: {
      async update(namespace: string, patch: object): Promise<void> {
        console.log(`[verify] settings.update(${namespace})`)
      },
    },
    logger: {
      info: (formatter: string, ...args: unknown[]) => console.log(`[sidecar] ${formatter.replace(/%[sd]/g, () => String(args.shift()))}`),
      warn: (formatter: string, ...args: unknown[]) => console.warn(`[sidecar] ${formatter.replace(/%[sd]/g, () => String(args.shift()))}`),
      error: (formatter: string, ...args: unknown[]) => console.error(`[sidecar] ${formatter.replace(/%[sd]/g, () => String(args.shift()))}`),
    },
    webServer,
    effect: (execute: () => () => unknown) => execute(),
  }

  const rawConfig = {
    runtimeDir: RUNTIME_DIR,
    binaryDir: path.join(RUNTIME_DIR, 'runtime'),
    redis: { external: { host: '127.0.0.1', port: 6379 } },
    quotaPollMs: 5_000,
    healthTimeoutMs: 180_000,
    proxy: { timeoutMs: 30_000 },
  }

  console.log(`[verify] apply against ${RUNTIME_DIR}`)
  await (plugin as { apply(ctx: unknown, config: unknown): Promise<void> }).apply(context, rawConfig)
  console.log(`[verify] host routes at ${origin}`)
  console.log(`[verify] embedded console: ${origin}/plugins/dsh-sub2api/ui/`)
  console.log(`[verify] embed fixture:   ${origin}${FIXTURE_NS}`)
  await waitUntilReady(origin)
  console.log('[verify] snapshot ready; rig is live. Press Ctrl+C to stop.')
  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    if (line.trim() === 'snapshot') void (async () => {
      const response = await fetch(`${origin}/plugins/dsh-sub2api/quota-snapshot`)
      console.log(await response.text())
    })()
  })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
