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

## 监督器插件

仓库根目录即可安装的 bundle（`package.json` 声明 `dsh.bundle.patch`，插件行在
`cordis.patch.yml`）。function 插件 `dsh-sub2api-sidecar` 通过 `inject` 要求宿主
提供 `subprocess`、`credentials`、`settings` 三个 seam，但对 harness 包没有 npm
依赖：所用 seam 面在 `src/seam.ts` 以结构类型钉住，因此本包可独立安装，在任何
提供这三个服务及 `llm-pi-ai` settings namespace 的组合中运行。

`apply` 执行一次受监督的启动：

1. 准备 `$DSH_HOME/sub2api/`——`data/`（sub2api `DATA_DIR`、PostgreSQL 集群）与
   `run/`（日志、socket、状态）以 `0700` 创建；包目录（`config.binaryDir`）须已
   含 `bin/{sub2api,initdb,pg_ctl}`。
2. 仅首次：对集群执行 `initdb`；随后 `pg_ctl start` 把 PostgreSQL 起在
   `127.0.0.1`，端口从 `config.portRange` 扫描分配。
3. 启动包内 `redis-server`。darwin 包目前是响亮占位（见
   `pack-sources.lock.json`），未配置跳过或外部端点时启动即报错并指名 lock 条目；
   `config.redis.skip`（记录到 `run/redis.skipped.json`）或 `config.redis.external`
   可替换内嵌组件。
4. 以 `RUN_MODE=simple`、`SERVER_HOST=127.0.0.1`、`AUTO_SETUP=true` 启动
   `sub2api`，在 `config.healthTimeoutMs` 内轮询 `/health`。
5. Bootstrap（幂等，凭据复用）：用 AUTO_SETUP 管理员凭据登录 → regenerate
   admin settings API key（`admin-…`）→ find-or-create `composite` 组 → 创建
   绑定该组的面板 API key（`sk-…`）。两把 key 经 credentials seam 存储（本地
   provider 以 `0600` 保存），绝不写日志。签发后复核约定：`sk-` key 访问 admin
   面必须 401。健康启动的最后一步：把手声明的 composite 路由写入 `llm-pi-ai`
   settings namespace（`baseURL` = sidecar 的 `/v1` 端点，`apiKeyEnv` = `sk-`
   凭据引用）。
6. 健康检查失败时全部不注册：不写 key、不写 llm-pi-ai，错误显式指名原因。

dispose（fiber 卸载、Cordis HMR 重载、宿主退出）对 sub2api 与 redis 进程树执行
SIGTERM → 宽限 → SIGKILL，并用 `pg_ctl stop`（先 fast，后 immediate）关闭
PostgreSQL。`data/` 永不删除或清空；重载复用既有 key，不重复正确的步骤，也不会
在同一 runtime dir 下拉起第二套进程。

配置（cordis.yml 插件行的 `config`；所有字段可选）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 时插件保持惰性。 |
| `runtimeDir` | `$DSH_HOME/sub2api` | 可变状态根目录。 |
| `binaryDir` | `<runtimeDir>/runtime` | 运行时包解包位置。 |
| `portRange` | `{min: 45100, max: 45199}` | postgres、redis、server 的回环端口扫描段。 |
| `healthTimeoutMs` / `healthPollMs` | `120000` / `500` | `/health` 预算与探测间隔。 |
| `stopGraceMs` | `8000` | SIGTERM→SIGKILL 宽限与 `pg_ctl` stop 等待。 |
| `adminEmail` / `adminPassword` | `admin@sub2api.local` / 随机生成 | AUTO_SETUP 管理员账号；生成的密码保存在 `run/admin-password`（`0600`）供后续登录，绝不写日志。 |
| `group.name` / `group.description` | `dsh-composite` | bootstrap 确保的 composite 组。 |
| `route.name` / `route.api` / `route.displayName` / `route.models` | `sub2api` / `openai-completions` / `Sub2API (sub2api)` / 一个 Claude 模型 | 写入 `llm-pi-ai` 的手声明路由；`models` 请按部署实际服务的模型调整。 |
| `redis.skip` / `redis.external` | `false` / – | 跳过内嵌组件（留痕），或指向外部 Redis。 |
| `credentials.adminRef` / `credentials.inferenceRef` | `SUB2API_ADMIN_API_KEY` / `SUB2API_API_KEY` | 两把 key 的凭据引用。 |

管理员登录账号只因上游 AUTO_SETUP 的要求而存在，不对用户暴露；产品面只有两把
key（规格 v1.1，gestaltrun/deepseek-harness-gestalt#346）。

### 开发

```sh
pnpm install
pnpm test        # vitest：生命周期、约定、redis、配置四套测试
pnpm typecheck
pnpm build       # tsc 产出 lib/（ESM，Node >= 22）
```

测试经由真实的进程树 subprocess provider 驱动假 sub2api（`node:http` 实现
登录、admin key、组、面板 key 端点并复刻上游鉴权分流）、假 `initdb`/`pg_ctl`
脚本与假 redis 监听器，因此 dispose 与幂等断言观察到的是真实进程退出。
