# dsh-sub2api-sidecar

English | [中文](README.zh.md)

Desktop-installable DeepSeek Harness plugin that supervises a local Sub2API
sidecar (account pool + Composite routing) and registers it as a Gestalt
provider. The Go/Postgres/Redis runtime pack is downloaded on enablement and
is not part of the Desktop Bundle.

This repository is the product source. Gestalt pins a revision from
`plugins/dsh-sub2api-sidecar` as a Git submodule.

## Runtime pack

`scripts/build-runtime-pack.mjs` assembles the per-os/arch runtime pack that the
sidecar installer downloads on enablement. It downloads the pinned upstream
binaries, verifies every SHA256 against `pack-sources.lock.json`, and emits a
reproducible tarball plus its checksum into `dist/`:

```
runtime-pack-<sub2api-ver>-<os>-<arch>.tar.gz
├── bin/                     sub2api, postgres, initdb, pg_ctl, redis-server
├── lib/                     PostgreSQL shared libraries
├── share/
│   ├── config.template.yaml run_mode=simple, binds 127.0.0.1; data lives in
│   │                        $DSH_HOME/sub2api/data, separate from this pack
│   └── postgresql/          PostgreSQL timezones and extension metadata
└── SHA256SUMS
```

Source strategy (full rationale in `pack-sources.lock.json`):

- **Sub2API** — official goreleaser assets from the `Wei-Shaw/sub2api` GitHub
  release, pinned in the lock file; `--sub2api-version` can override the pin,
  in which case the release's own `checksums.txt` is trusted.
- **PostgreSQL** — `zonky/embedded-postgres-binaries` artifacts on Maven
  Central (PG 17.x), the only maintained distribution covering darwin arm64 and
  amd64 with checksum sidecars.
- **Redis** — no official or trustworthy portable darwin binary exists today
  (Homebrew bottles are `/opt/homebrew`-linked; valkey publishes source only),
  so the pack ships a `redis-server` stub that fails loudly and points at the
  lock-file TODO.

Reproduce locally (Node >= 22):

```sh
node scripts/build-runtime-pack.mjs --os darwin --arch arm64
shasum -a 256 -c dist/SHA256SUMS
```

CI (`.github/workflows/runtime-pack.yml`) builds the same pack on push and
`workflow_dispatch`, verifies the extracted `SHA256SUMS`, and uploads `dist/`
as a workflow **artifact**. Publishing a GitHub Release, tag, or Release asset
is a release mutation that requires separate user approval and is out of scope
here.

## Supervisor plugin

The repository root is the installable bundle (`dsh.bundle.patch` in
`package.json`, plugin rows in `cordis.patch.yml`). The function plugin
`dsh-sub2api-sidecar` requires the host seams `subprocess`, `credentials`,
`settings`, and `webServer` (declared via `inject`) and mounts no npm
dependency on the harness packages: the seam surfaces it uses are pinned
structurally in `src/seam.ts`, so the bundle installs standalone and runs
inside any composition that provides the four services plus the `llm-pi-ai`
settings namespace.

On `apply` it runs one supervised boot:

1. Prepare `$DSH_HOME/sub2api/` — `data/` (sub2api `DATA_DIR`, PostgreSQL
   cluster) and `run/` (logs, sockets, state) are created `0700`; the pack
   directory (`config.binaryDir`) must already carry `bin/{sub2api,initdb,pg_ctl}`.
2. First use only: `initdb` the cluster; then `pg_ctl start` PostgreSQL bound
   to `127.0.0.1` on a port scanned from `config.portRange`.
3. Start the pack's `redis-server`. The darwin pack ships a loud placeholder
   (see `pack-sources.lock.json`), so the boot fails naming the lock entry
   unless `config.redis.skip` (recorded in `run/redis.skipped.json`) or
   `config.redis.external` replaces the bundled component.
4. Start `sub2api` with `RUN_MODE=simple`, `SERVER_HOST=127.0.0.1`, and
   `AUTO_SETUP=true`; poll `/health` until it answers within
   `config.healthTimeoutMs`.
5. Bootstrap (idempotent, reusing stored keys): log in with the AUTO_SETUP
   admin credentials → regenerate the admin settings API key (`admin-…`) →
   find-or-create the `composite` group → create the panel API key bound to
   that group (`sk-…`). Both keys are stored through the credentials seam
   (its local provider keeps them `0600`) and never logged. After issuance the
   convention is re-verified: the `sk-` key must be refused with 401 on the
   admin plane. A healthy boot ends by writing the hand-declared composite
   route into the `llm-pi-ai` settings namespace (`baseURL` = the sidecar's
   `/v1` endpoint, `apiKeyEnv` = the `sk-` credential reference).
6. On health failure none of this registers: no key is written, no settings
   write happens, and the boot error names the cause.

Disposal (fiber unload, Cordis HMR reload, or host shutdown) terminates the
sub2api and redis process trees (SIGTERM → grace → SIGKILL) and shuts
PostgreSQL down through `pg_ctl stop` (fast, then immediate). `data/` is never
deleted or emptied; a reload reuses the running keys, re-runs nothing that is
already correct, and never starts a second process set behind one runtime dir.

Configuration (cordis.yml `config` on the plugin row; every field optional):

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | When `false` the plugin stays inert. |
| `runtimeDir` | `$DSH_HOME/sub2api` | Root of the mutable state. |
| `binaryDir` | `<runtimeDir>/runtime` | Unpacked runtime pack location. |
| `portRange` | `{min: 45100, max: 45199}` | Loopback scan range for postgres, redis, and the server. |
| `healthTimeoutMs` / `healthPollMs` | `120000` / `500` | `/health` budget and probe interval. |
| `stopGraceMs` | `8000` | SIGTERM→SIGKILL grace and `pg_ctl` stop wait. |
| `adminEmail` / `adminPassword` | `admin@sub2api.local` / generated | AUTO_SETUP admin account; a generated password is kept in `run/admin-password` (`0600`) for later logins and never logged. |
| `group.name` / `group.description` | `dsh-composite` | The composite group the bootstrap ensures. |
| `route.name` / `route.api` / `route.displayName` / `route.models` | `sub2api` / `openai-completions` / `Sub2API (sub2api)` / one Claude model | The hand-declared provider route written into `llm-pi-ai`; set `models` to what your deployment actually serves. |
| `redis.skip` / `redis.external` | `false` / – | Skip the bundled component (recorded), or point at an external Redis. |
| `credentials.adminRef` / `credentials.inferenceRef` | `SUB2API_ADMIN_API_KEY` / `SUB2API_API_KEY` | Credential references for the two keys. |
| `proxy.enabled` | `true` | Mount the admin injection proxy prefix and the quota snapshot route. |
| `proxy.allowedOrigins` | `[]` | Extra absolute origins trusted by both host-side routes besides the host's own. |
| `proxy.timeoutMs` | `30000` | Per-request upstream budget for one forwarded call or quota probe. |
| `quotaPollMs` | `60000` | Interval between quota snapshot polls. |

The admin login account exists only because upstream AUTO_SETUP requires one;
it is not surfaced to the user, and the product surfaces are the two keys
(spec v1.1, gestaltrun/deepseek-harness-gestalt#346).

## Host-half services

After a healthy boot the plugin mounts three host-side services on the web
server seam (the admin injection proxy, the embedded-console passthrough, and
the quota snapshot). All share one admission posture: only loopback peers are
admitted, a browser `Origin` header must be the host's own origin or a
`proxy.allowedOrigins` entry (another loopback port is a different, untrusted
origin), and an origin-absent request must still carry a loopback `Host`
header — which is what blocks DNS rebinding. Denied requests get `403` and
never reach the sidecar.

### Admin injection proxy

`/plugins/dsh-sub2api/admin/*` maps onto `http://127.0.0.1:<sidecarPort>/api/v1/admin/*`:

- Every forwarded call injects `x-api-key: <admin-…>`, resolved from the
  credential reference (`credentials.adminRef`); the renderer never touches
  the key and it never appears in a response body, header, or log line.
- Client-supplied `authorization`, `cookie`, and `x-api-key` are stripped
  before forwarding, along with `origin`, `referer`, and hop-by-hop headers.
- Pure forwarding: method, path, query, body, status, and payload pass
  through unchanged, so upstream 401/403/step-up semantics reach the caller
  verbatim. There are no business endpoints and no rewrites; `set-cookie` is
  dropped so no upstream session can become a host-origin cookie.
- While the sidecar is down or the key is not provisioned the proxy answers
  `503` (`SIDECAR_UNAVAILABLE` / `ADMIN_KEY_UNAVAILABLE`); an unreachable
  sidecar surfaces as `502`. It never fabricates a success.
- HTTP only: WebSocket upgrades are not proxied.

### Embedded-console passthrough

`/plugins/dsh-sub2api/ui/*` maps onto the sidecar's root, where the sidecar
process serves its own bundled Vue admin console (the SPA plus the `/api/*`
plane it talks to). Serving the console under the host's own origin is what
lets the injection plane carry its authentication:

- Upstream paths under `/api/v1/admin/` are forwarded with the injected
  `x-api-key: <admin-…>` (same key source, same header stripping, same
  pass-through posture as the admin proxy). Every other path is forwarded
  verbatim with **no** injected credential — upstream's own unauthenticated
  and step-up semantics stay authoritative, and no client can reach the admin
  plane or the gateway with a borrowed key.
- HTML responses (the SPA's `index.html`, including its own SPA-fallback
  answers for history-mode routes such as `/admin/dashboard`) are transformed
  for service under the prefix: path-absolute asset references (`src=`/`href=`
  and friends) are rebased onto `/plugins/dsh-sub2api/ui/`, and
  `<base href="/plugins/dsh-sub2api/ui/">` plus the runtime shim are injected
  right after `<head>`. Non-HTML assets pass through byte-identically.
- The runtime shim (`src/ui-shim.ts`) is the whole browser-side login bypass
  (spec v1.1 Q18=2): it seeds upstream's local-storage session keys
  (`auth_token`, `refresh_token`, `token_expires_at`, `auth_user` with
  `role: "admin"`) before the SPA boots, and rewrites the SPA's
  path-absolute `/api/v1/*` API calls onto the passthrough prefix, which
  `<base href>` cannot do. It contains no key material and grants no
  upstream authorization — admin data flows through the injected key.
- The embedded-session endpoints `GET /api/v1/auth/me` and `POST
  /api/v1/auth/{login,refresh,logout}` arriving under the prefix are answered
  by the passthrough itself with a fabricated display-only admin identity
  (`run_mode: "simple"`) and never reach the sidecar: this is what keeps the
  embedded console off the login page. Upstream upgrade response: if the
  storage keys or these endpoints change upstream, update `src/ui-shim.ts`
  and the stub table in `src/ui-proxy.ts` — both are host-side, so no
  frontend fork is ever needed. Known limits: non-admin (panel) endpoints
  still hit upstream unauthenticated and fail with its own 401; upstream
  session cookies are dropped, so cookie-authenticated panel features remain
  unavailable inside the embed.
- Admission, refusals, and error codes mirror the admin proxy (`UI_FORBIDDEN`
  replaces `PROXY_FORBIDDEN`).

### Quota snapshot

`GET /plugins/dsh-sub2api/quota-snapshot` serves the aggregated read-only
snapshot (other methods get `405`):

```json
{
  "status": "ready | unavailable",
  "reason": "present when unavailable",
  "generatedAt": "ISO time this snapshot was built",
  "lastSuccessAt": "ISO time of the last fully successful poll",
  "sidecarPort": 45123,
  "accounts": [
    { "id": 1, "name": "...", "platform": "anthropic", "accountType": "oauth",
      "status": "active", "schedulable": true, "quota": { "tier": "..." } }
  ]
}
```

`sidecarPort` carries the supervised server's loopback port while it runs
this poll; the desktop embed uses it for the direct-console fallback link.

- Polling: every `quotaPollMs` the service reads the sidecar admin API — the
  accounts list plus each account's platform quota endpoint — and atomically
  replaces the published snapshot.
- Platform tiers (spec v1.1 分档): `openai`, `grok`, and the CN providers
  (`kimi`/`zhipu`/`deepseek`) are `remote-probed` from their upstream quota
  endpoints (usage `windows` and, for pay-as-you-go, `balance`); every other
  platform is `local-derived` from the accounts list's own fields
  (`rateLimitResetAt`, `overloadUntil`, `sessionWindow`, and the API-key
  `apiQuota` limits). A per-account endpoint failure records `error` on that
  account instead of failing the poll.
- Explicit unavailability: a snapshot not produced by a fully successful poll
  is `unavailable` with a `reason` (`sidecar-not-ready`,
  `admin-key-unavailable`, `accounts-list-failed`). The previous accounts and
  `lastSuccessAt` are retained so stale data stays labeled; before the first
  success `accounts` is empty — never empty data dressed up as ready.
- The snapshot is a field whitelist: credential-shaped upstream fields cannot
  appear in it, and no key material is ever included.

## Embedded console (browser half)

The package carries a browser face next to the node half, following the
harness client contract: the `dsh.client` manifest in `package.json`
(`platform: "web"`, service edges `slots` and `locale`) and a self-contained
lazy-CJS bundle at `lib/client.js` (`pnpm bundle`), which registers itself
through `window.__ModuleLoader__.load({ id, factory })` and resolves its only
externals — `react` and `react/jsx-runtime` — from the loader module table
(react is an optional peer dependency). The harness client-runtime surfaces
the plugin calls are pinned structurally in `src/client/client-seams.d.ts`,
the browser counterpart of `src/seam.ts`.

The browser half registers one entry — 订阅账号池 — in the settings shell's
`settings.section` slot. The section owns no business UI:

- While the readiness poll reports an unhealthy sidecar, the container shows
  an actionable state instead of a blank frame: status copy derived from the
  snapshot's `reason`, a retry action, and — when the snapshot carries the
  supervised server's port — the 「打开本地管理台直连」 loopback link that
  opens the sidecar's own console (with its native login page) in a new tab.
- Once the snapshot is `ready`, the console fills the section in an iframe
  pointed at the same-origin passthrough `/plugins/dsh-sub2api/ui/`; the
  container keeps polling at a slow cadence so a later sidecar stop flips it
  back to the fallback card.

Development adds `pnpm bundle` (tsdown) next to the existing commands; the
bundle compiles CSS Modules with lightningcss inside the artifact, so no
separate stylesheet is shipped.

### Development

```sh
pnpm install
pnpm test        # vitest: lifecycle, convention, redis, config, host services, client suites
pnpm typecheck
pnpm build       # tsc emits lib/ (ESM, Node >= 22)
pnpm bundle      # tsdown emits lib/client.js (the browser half)
```

The tests run a fake sub2api (an `node:http` server implementing the login,
admin-key, group, and panel-key endpoints with the upstream auth split), fake
`initdb`/`pg_ctl` scripts, and a fake redis listener through a real
process-tree subprocess provider, so dispose and idempotency assertions
observe real process exits. The host-half suites add an in-process fake admin
API with per-request header recording and a dispatching web server seam
double, so injection, stripping, admission, and snapshot freshness are
asserted over real loopback HTTP.
