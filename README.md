# bgmcp — MCP 控制面与 `mcp` 后台任务引擎

[![npm version](https://img.shields.io/npm/v/bgmcp)](https://www.npmjs.com/package/bgmcp)
[![GitHub tag](https://img.shields.io/github/v/tag/bitsmug/dsh-bgmcp)](https://github.com/bitsmug/dsh-bgmcp/tags)
[![publish](https://github.com/bitsmug/dsh-bgmcp/actions/workflows/publish.yml/badge.svg)](https://github.com/bitsmug/dsh-bgmcp/actions/workflows/publish.yml)
[![License](https://img.shields.io/npm/l/bgmcp)](LICENSE)

bgjobs 的可选扩展插件：把 **一次 MCP 工具调用** 提交成由 `schtasks` 托管的后台任务，并提供 MCP server 的登记、预热与设置页。

代码从 `bgjobs` 拆出，二者通过 **engine 能力缝** 对接：

| 角色 | 归属 |
|---|---|
| Service Definition / Provider（`BgjobEngine`、`ctx.bgjobEngines` registry、schtasks 提交管线、沙箱 wiring） | `bgjobs` |
| `mcp` engine 实现、MCP 工具、控制面路由、MCP 设置页 | 本包 |

**fail-closed**：未安装本包时 bgjobs 不注册任何 MCP 能力——工具不可见、engine 枚举只有 `bat` / `pwsh`、`submitJob({ engine: 'mcp' })` 返回 `engine "mcp" not registered`。没有降级路径。

## 前置

- Windows（任务由 `schtasks` 托管）
- `bgjobs`（硬依赖：`inject = ['tools', 'bgjobEngines']`）
- Node.js（任务经 Node runner 调 MCP server；`resolveNodeExe` 从 PATH / 当前进程解析）

## 安装

**插件管理器**：在 DSH 插件的「添加插件」里输入 `bgmcp`。

**CLI**：

```sh
dsh plugin --profile <profile> add bgmcp
```

**本地源码**：把仓库放到插件目录，并在 profile 的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: bgjob-engine-mcp
      name: bgmcp
```

装完需**完全退出并重启 DSH**。`name` 必须是包根名（client 半由 `package.json` 的 `dsh.client` 定位）。

## 提供的能力

### 工具

| 工具 | 说明 |
|---|---|
| `bgjob_submit_mcp` | 提交一次 MCP 工具调用任务。`server`（登记名）与 `server_config`（内联 JSON）二选一，另需 `tool`，可选 `workdir`（缺省=当前会话工作目录）/ `arguments` / `timeout_seconds`。退出码：`0` 成功 / `1` 工具报错 / `2` 连接或调用失败 / `3` 超时 |
| `mcp_list_tools` | 列出某 server 的工具名 / 描述 / 必填字段（带缓存，可强制刷新）。提交前先查，避免猜工具名 |

两者都常驻注册、运行时校验总开关：关掉即时生效，无需重启 DSH；关闭时统一返回 `MCP jobs are disabled; …`。

### `mcp` engine

注册进 `ctx.bgjobEngines`，`id = 'mcp'`，走 bgjobs 的**描述符链**（执行输入全在任务定义里）。除钩子外还声明三个**契约字段**（bgjobs 只读声明，不按 engine id 特判）：

| 字段 | 值 | 含义 |
|---|---|---|
| `sandboxPolicy` | `inherit` | 跟随会话策略；沙箱只包住 MCP server 进程（见「安全须知」的混合模型） |
| `pidFiles` | `[{ name: 'run.pid', owned: true }, { name: 'mcp-server.pid', owned: false }]` | 优先 host 的 `run.pid`（`/T` 一次杀穿 runner + server）；`mcp-server.pid` 命令行为孙进程，`owned:false` 只判存活 |
| `resultFile` | `result.json` | 收尾结果文件（bgjobs 读取 `channel` 字段用于展示） |

三个钩子：

- `resolve` — 解析 node、把 server/tool/arguments/timeout 与（可选的）预热回环端点写成任务自包含 spec；沙箱开启时在提交期调一次 `sandbox.confine()`，把 server 的启动 argv 烘焙成 `spec.serverLaunch`
- `buildMeta` — 产出 `meta.mcp`（server / tool / transport / prewarm），并把 spec 落盘为 `mcp.json`（**同步**返回：bgjobs 0.4.1-beta 不 await 这个钩子）
- `buildDescriptor` — `{ m: 'direct', e: 'pwsh', o: 'utf8', c: "& '<node>' '<runner>' '<spec>'" }`：为了直跑 node 且不扩描述符引擎枚举，用 pwsh 包一层

任务目录与 bgjobs 一致：`<workdir>\.dsh\bgjobs\<jobId>\`，其中 `mcp.json` 是 runner 的输入、`result.json` 记录结果；`job.json` / `cmd.ps1` 分别是任务记录与命令记录（仅供人读），不再生成 `cmd.bat` / `run.bat` / `launch.vbs`。

### 控制面路由

以 `/mcp-control` 前缀注册到 `webServer`：

| 路由 | 用途 |
|---|---|
| `/prefs` | MCP 任务总开关（`GET`；`POST ?enabled=0|1`） |
| `/servers` | server 登记 CRUD、导入 / 导出、探测、三态切换 |
| `/dsh-config` | 当前 profile / 全局 `cordis.patch.yml` 里 MCP 条目的只读视图 + 一次性导入 |

### 设置页「MCP 任务」

总开关（默认关）；server 登记（名字 + JSON 配置；stdio：`command`/`args`/`env`，streamable-http：`url`/`headers`）；每行三态 **预热 / 冷启动 / 禁用**；编辑（含明文 env/headers）、列出工具、删除；导出为 DSH YAML 片段或原生 JSON；从 DSH 已有配置一键导入（`!!js` 条目不会求值，需手工补全）。监控面板标题栏的数据齿轮可直达本页。

**预热**：在 DSH 进程内为该 server 保持一条常驻连接，任务经 `127.0.0.1` 回环代理复用它（token 鉴权）。只在 DSH 存活期有效；失败自动回退任务内冷启动，不影响正确性；**已发出的调用失败或超时不会重跑**（避免重复副作用）。

## 数据与迁移

| 文件 | 内容 |
|---|---|
| `$DSH_HOME/mcp-hub/prefs.json` | 总开关 |
| `$DSH_HOME/mcp-hub/servers.json` | server 登记（含明文 env/headers） |
| `$DSH_HOME/mcp-hub/tools-cache.json` | 工具清单缓存 |

拆分前这些数据在 `$DSH_HOME/bgjobs/mcp-prefs.json`、`mcp-servers.json`。首次读取时若新文件不存在、旧文件存在，会**复制一次**；旧文件不删、不改、不双写。

## 安全须知

- `env` / `headers` 里的密钥以**明文**保存在 `servers.json`，并随任务写入任务目录的 `mcp.json`；导出文本同样含明文，分享或归档前请脱敏。
- **沙箱（混合模型）**：匿名管道由**父进程**创建、子进程只继承句柄，所以把 runner 留在容器外、只把 MCP server 包进沙箱（`wxc-exec --config-base64 <policy> -- <server.exe> ...`，由 `spec.serverLaunch` 承载），stdio MCP 就可用——`wxc-exec --probe` 报 `base-container` 档的 Win11 上实测通过（读/写隔离生效、退出码透传）。runner 因此仍是 `m:'direct'`（它必须在宿主侧建管道），隔离只覆盖真正跑第三方代码的那一段。
- 沙箱下 **server 的 `command` 必须是原生 `.exe`**（可用绝对路径，或能在 `PATH` 里找到的 `*.exe`）：容器不继承宿主 PATH，`.cmd`/`.bat` 包装器（如 `npx`、`pnpm`）无法被直接执行 ⇒ 提交期直接失败（fail closed，不静默降级为不沙箱）。需要这类包装器时请改用登记了原生 exe 的 server，或对该任务关闭沙箱。
- 沙箱只约束 MCP server 进程：预热连接在 DSH 进程内建立，仍以当前用户权限运行。
- 受限会话（read-only / workspace-write）里 MCP 任务按会话策略走沙箱；未挂沙箱策略服务时不降级、直接拒绝（fail closed）；用户拒批则不提交。
- `server_config` 内联配置会在**每次** `bgjob_submit_mcp` / `mcp_list_tools` 之前请求用户审批，弹窗展示 `command`+`args` 或 `url`；设置页登记过的 server 不弹窗。宿主未装配 approval 服务时内联配置一律拒绝。
- 历史 MCP 任务目录的 `cmd.bat` 里烘焙的是 `bgjobs/lib/mcp-runner.mjs` 的绝对路径；该文件现在只是转发到本包的 `runner.mjs`。未安装本包时这类旧任务以 `ERR_MODULE_NOT_FOUND` 失败，不会重跑。

## 开发

```sh
node --test "tests/**/*.test.js"   # 单元 / 接线测试
node scripts/build-client.mjs      # 重建 lib/client.js（来自 lib/client-src）
```

客户端文案在 `lib/client-src/i18n.js`（zh/en 两套键）；服务端入口 `lib/index.js` 的 `apply` 依次注册 engine、工具、路由、systemPrompt 指引，并返回统一 disposer。

开发纪律与发布流程见 [docs/developer.md](docs/developer.md)。
