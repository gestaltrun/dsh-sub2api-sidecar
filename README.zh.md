# dsh-sub2api-sidecar

[English](README.md) | 中文

可安装的 DeepSeek Harness 插件：监督本机 Sub2API sidecar（账号池 + Composite
路由），并把它登记为 Gestalt 提供方。Go/Postgres/Redis 运行时包在启用时下载，
不进入 Desktop Bundle。

本仓库是产品源。Gestalt 通过 `plugins/dsh-sub2api-sidecar` Git submodule 钉住
一个修订。

## Runtime pack

`scripts/build-runtime-pack.mjs` 按 os/arch 拼装 sidecar 启用时下载的运行时包：
下载钉住的上游二进制，逐项对照 `pack-sources.lock.json` 校验 SHA256，产出可复现
的 tarball 与校验和到 `dist/`：

```
runtime-pack-<sub2api-ver>-<os>-<arch>.tar.gz
├── bin/                     sub2api、postgres、initdb、pg_ctl、redis-server
├── lib/                     PostgreSQL 动态库
├── share/
│   ├── config.template.yaml run_mode=simple、绑定 127.0.0.1；数据落在
│   │                        $DSH_HOME/sub2api/data，与本包分离
│   └── postgresql/          PostgreSQL 时区与扩展元数据
└── SHA256SUMS
```

来源策略（完整理由见 `pack-sources.lock.json`）：

- **Sub2API** — `Wei-Shaw/sub2api` GitHub Release 的官方 goreleaser 产物，版本
  在 lock 文件钉住；`--sub2api-version` 可覆盖 pin，此时信任该 Release 自带的
  `checksums.txt`。
- **PostgreSQL** — `zonky/embedded-postgres-binaries` 在 Maven Central 的产物
  （PG 17.x）：唯一同时覆盖 darwin arm64/amd64、带校验和、持续维护的发行。
- **Redis** — 当前不存在官方或可信的 darwin 便携二进制（Homebrew bottle 依赖
  `/opt/homebrew` 前缀；valkey 仅发源码），包内放置 `redis-server` 占位 stub，
  启动即报错并指向 lock 文件中的 TODO。

本地复现（Node >= 22）：

```sh
node scripts/build-runtime-pack.mjs --os darwin --arch arm64
shasum -a 256 -c dist/SHA256SUMS
```

CI（`.github/workflows/runtime-pack.yml`）在 push 与 `workflow_dispatch` 时构建
同一产物，校验解包后的 `SHA256SUMS`，并把 `dist/` 上传为 workflow **artifact**。
发布 GitHub Release / tag / Release asset 属 release mutation，需用户单独批准，
不在本票范围内。
