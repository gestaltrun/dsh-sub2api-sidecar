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
提供 `subprocess`、`credentials`、`settings`、`webServer` 四个 seam，但对 harness
包没有 npm 依赖：所用 seam 面在 `src/seam.ts` 以结构类型钉住，因此本包可独立
安装，在任何提供这四个服务及 `llm-pi-ai` settings namespace 的组合中运行。

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
| `proxy.enabled` | `true` | 是否挂载注入转发面前缀与额度快照路由。 |
| `proxy.allowedOrigins` | `[]` | 除宿主自身 origin 外，两条宿主路由额外信任的绝对 origin。 |
| `proxy.timeoutMs` | `30000` | 单次转发调用或额度探测的上游预算。 |
| `quotaPollMs` | `60000` | 额度快照的轮询间隔。 |

管理员登录账号只因上游 AUTO_SETUP 的要求而存在，不对用户暴露；产品面只有两把
key（规格 v1.1，gestaltrun/deepseek-harness-gestalt#346）。

## Host 半服务

健康启动后，插件在 web server seam 上挂载两个 Host 侧服务。两者共用同一准入
姿态：仅回环对端可入；浏览器 `Origin` 头必须是宿主自身 origin 或
`proxy.allowedOrigins` 中的条目（另一个回环端口对浏览器而言是不同且不受信的
origin）；无 `Origin` 的请求仍必须携带回环 `Host` 头——这正是阻断 DNS
rebinding 的一道闸。被拒请求得到 `403`，绝不触达 sidecar。

### 注入转发面

`/plugins/dsh-sub2api/admin/*` 映射到 `http://127.0.0.1:<sidecarPort>/api/v1/admin/*`：

- 每次转发统一注入 `x-api-key: <admin-…>`，按凭据引用（`credentials.adminRef`）
  现场解析；renderer 永不接触 key，key 也不会出现在任何响应体、响应头或日志行。
- 转发前剥离客户端自带的 `authorization`、`cookie`、`x-api-key`，以及 `origin`、
  `referer` 与逐跳头。
- 纯转发：方法、路径、查询、请求体、状态码与载荷原样透传，上游 401/403/step-up
  语义原样到达调用方。无任何业务端点、无任何改写；`set-cookie` 被丢弃，上游会话
  不会变成宿主 origin 的 cookie。
- sidecar 未运行或 key 未就绪时，转发面回答 `503`（`SIDECAR_UNAVAILABLE` /
  `ADMIN_KEY_UNAVAILABLE`）；sidecar 不可达呈现为 `502`。绝不伪造成功。
- 仅 HTTP：WebSocket upgrade 不在转发范围内。

### 额度快照

`GET /plugins/dsh-sub2api/quota-snapshot` 返回聚合后的只读快照（其他方法
`405`）：

```json
{
  "status": "ready | unavailable",
  "reason": "不可用时给出原因",
  "generatedAt": "本快照构建时间（ISO）",
  "lastSuccessAt": "最近一次完整成功轮询时间（ISO）",
  "accounts": [
    { "id": 1, "name": "...", "platform": "anthropic", "accountType": "oauth",
      "status": "active", "schedulable": true, "quota": { "tier": "..." } }
  ]
}
```

- 轮询：每 `quotaPollMs` 读取一次 sidecar admin API——accounts 列表加各账号的
  平台 quota 端点——并原子替换已发布快照。
- 平台分档（规格 v1.1）：`openai`、`grok` 与国产三家（`kimi`/`zhipu`/`deepseek`）
  为 `remote-probed`，取自各自上游 quota 端点（用量 `windows`，按量付费另含
  `balance`）；其余平台为 `local-derived`，从 accounts 列表自有字段映射
  （`rateLimitResetAt`、`overloadUntil`、`sessionWindow` 与 API-key 的
  `apiQuota` 限额）。单账号端点失败只在该账号上记录 `error`，不拖垮整轮轮询。
- 显式不可用：凡非完整成功轮询产出的快照一律 `unavailable` 并带 `reason`
  （`sidecar-not-ready`、`admin-key-unavailable`、`accounts-list-failed`）。
  上一次的 accounts 与 `lastSuccessAt` 保留，过期数据始终带标签；首次成功之前
  `accounts` 为空——绝不拿空数据冒充成功。
- 快照是字段白名单：上游凭证形态的字段不可能进入快照，任何 key 明文都不会出现。

### 开发

```sh
pnpm install
pnpm test        # vitest：生命周期、约定、redis、配置、host 半服务各套测试
pnpm typecheck
pnpm build       # tsc 产出 lib/（ESM，Node >= 22）
```

测试经由真实的进程树 subprocess provider 驱动假 sub2api（`node:http` 实现
登录、admin key、组、面板 key 端点并复刻上游鉴权分流）、假 `initdb`/`pg_ctl`
脚本与假 redis 监听器，因此 dispose 与幂等断言观察到的是真实进程退出。host 半
各套测试另有进程内假 admin API（逐请求记录请求头）与可派发的 web server seam
替身，注入、剥离、准入与快照新鲜度都在真实回环 HTTP 上断言。
