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
