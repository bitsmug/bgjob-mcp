// bgmcp —— mcp engine（BgjobEngine seam 的 MCP 实现）。
// 钩子签名对齐 bgjobs/lib/core/engines.js：
//   resolve(ctx, { workdir, extra }) → resolveOut | { error }
//   buildMeta(ctx, baseMeta, resolveOut, extra) → 合并进 job.meta 的字段（**必须同步**：
//     bgjobs 0.4.1-beta 直接 Object.assign 不 await；异步的沙箱 confine 放在 resolve 里）
//   buildDescriptor(ctx, { meta, ... }) → { m, e, o, c }（描述符链路，bgjobs v0.4+）
// 纯对象即可：registry.registerEngine 会 new BgjobEngine(overrides)。
//
// 执行输入全部进描述符（任务定义），jobDir 只留记录与产物。为了直跑 node 而不扩展
// 描述符的引擎枚举（`e` 是安全边界：host 只从固定候选里解析解释器），这里用 `e: 'pwsh'`
// 包一层 `& '<node>' '<runner>' '<spec>'`；退出码由信封按 $LASTEXITCODE 收尾。

import path from 'node:path'
import { existsSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveNodeExe, probeNodeVersion } from 'bgjobs'

/** runner 默认路径：本包的 lib/runner.mjs（提交时烘焙进 job.meta）。 */
export const DEFAULT_MCP_RUNNER_PATH = fileURLToPath(new URL('./runner.mjs', import.meta.url))

/** PowerShell 单引号字面量：内部单引号翻倍。 */
const psQuote = (value) => "'" + String(value).replace(/'/g, "''") + "'"

/**
 * 把 server 的 `command` 解析成**原生 .exe 的绝对路径**。
 * 容器里没有宿主的 PATH，且 .cmd/.bat 需要 cmd.exe 解释、无法被 wxc-exec 直接执行 ⇒
 * 只接受 .exe；解析不到返回 null，由调用方 fail closed（提交失败，不降级为不沙箱）。
 */
function resolveExecutable(command) {
  const raw = String(command === undefined || command === null ? '' : command).trim()
  if (raw.length === 0) return null
  const exts = path.extname(raw) === '' ? ['.exe'] : ['']
  const dirs = path.isAbsolute(raw) ? [''] : String(process.env.PATH || '').split(path.delimiter)
  for (const dir of dirs) {
    for (const ext of exts) {
      const base = dir === '' ? raw : path.join(dir.replace(/^"|"$/g, ''), raw)
      const full = base + ext
      if (path.extname(full).toLowerCase() === '.exe' && existsSync(full)) return full
    }
  }
  return null
}

const errorMsg = (e) => (e && e.message ? String(e.message) : String(e))

/**
 * 创建 mcp engine。
 * @param {{ prewarm?: { endpointFor: (name: string) => ({ url: string, token: string } | null) | null } | null, runnerPath?: string }} [deps]
 *   prewarm = lib/pool.js 的 api（阶段 2 由 apply 注入；为空时任务纯冷启动）。
 * @returns 普通 engine 对象（id/label/supportsSandbox + 契约声明 + 三个钩子）。
 */
export function createMcpEngine(deps = {}) {
  const prewarm = deps.prewarm ? deps.prewarm : null
  const runnerPath = typeof deps.runnerPath === 'string' && deps.runnerPath.length > 0 ? deps.runnerPath : DEFAULT_MCP_RUNNER_PATH

  return {
    id: 'mcp',
    label: 'MCP',
    supportsSandbox: true,
    // 引擎契约声明（bgjobs 只读这些字段，不按 engine id 特判）：
    //   sandboxPolicy —— 混合模型（实测见 .trae/documents/mxc-pipe-sandbox-experiment.md）：
    //     匿名管道由**父进程**创建、子进程只继承句柄，所以把 runner 留在容器外、只把 MCP server
    //     包进 `wxc-exec`，stdio 就可用（Win11 base-container 档实测通过）。
    //     进程隔离在 resolve 的提交期 confine 里施加（烘进 spec.serverLaunch），描述符本身仍是 direct，
    //     runner 才会在宿主侧建管道。
    //     inherit = 跟随会话策略，受限会话里 MCP 任务不再被静默升成全权限。
    //   pidFiles —— 优先 run.pid（host 的 /T 一次杀穿 runner + server），其次冷启动 server 的
    //     mcp-server.pid（命令行天然不含 jobDir ⇒ owned:false 只判存活）；
    //   resultFile —— runner 收尾写的执行结果（bgjobs 只在收尾时读 channel 字段展示）。
    sandboxPolicy: 'inherit',
    pidFiles: [{ name: 'run.pid', owned: true }, { name: 'mcp-server.pid', owned: false }],
    resultFile: 'result.json',

    /** 解析 node + 构造任务自包含 spec（预热端点、沙箱 serverLaunch 都在这里烘进 spec）。
     *  ★ 异步只能落在这里：bgjobs 0.4.1-beta 的 buildMeta 是**同步调用**（不 await），
     *  0.5 起才 await；而 resolve 两种契约都 await ⇒ confine 只能在 resolve 里做。 */
    async resolve(ctx, { workdir, extra } = {}) {
      const nodeExe = await resolveNodeExe(workdir)
      if (nodeExe === null) {
        return {
          error: 'Node.js not found: MCP jobs run through a Node runner (bgmcp/lib/runner.mjs). '
            + 'Install Node 18+ on PATH, or start DSH with a node on PATH.',
        }
      }
      const nodeExeVersion = await probeNodeVersion(nodeExe)
      const raw = extra && extra.mcpSpec && typeof extra.mcpSpec === 'object' ? extra.mcpSpec : null
      if (raw === null) return { error: 'mcp engine requires an "mcpSpec" (internal error)' }
      const spec = { ...raw }
      const serverName = spec.server === undefined || spec.server === null ? '' : String(spec.server)
      // 该 server 已有可用常驻连接 → 附加 127.0.0.1 回环代理端点与 token（缺省=纯冷启动）。
      const endpoint = prewarm !== null && serverName.length > 0 ? prewarm.endpointFor(serverName) : null
      if (endpoint !== null) spec.prewarm = endpoint
      // 沙箱模式由提交方经 extra.sandboxMode 传入（resolve 拿不到 baseMeta.sandbox）：
      // 提交期把 server 包进 confine argv，结果作为 spec.serverLaunch 下发。
      const sandboxMode = extra !== undefined && extra !== null && typeof extra.sandboxMode === 'string' ? extra.sandboxMode : 'off'
      // streamable-http 不起进程 ⇒ 没有可施加隔离的执行点，也就不需要 serverLaunch。
      const isHttp = spec.transport === 'streamable-http' || typeof spec.command !== 'string'
      const base = { nodeExe, nodeExeVersion, spec }
      if (isHttp || sandboxMode === 'off') return base
      const svc = ctx !== null && typeof ctx.get === 'function' ? ctx.get('sandbox') : null
      if (svc === null || typeof svc.confine !== 'function') {
        return { error: 'sandbox "' + sandboxMode + '" requires the dsh sandbox service (ctx.sandbox), but no sandbox provider is composed in this profile' }
      }
      const exe = resolveExecutable(spec.command)
      if (exe === null) {
        return {
          error: 'sandbox "' + sandboxMode + '" requires an absolute native .exe for the MCP server, but "'
            + String(spec.command) + '" cannot be resolved to one (shell wrappers such as npx.cmd cannot run inside the '
            + 'sandbox container; register the server with an absolute .exe path, or run the job with sandbox off)',
        }
      }
      let confined
      try {
        confined = await svc.confine([exe].concat(Array.isArray(spec.args) ? spec.args.map(String) : []), { mode: sandboxMode, workspaceRoot: workdir })
      } catch (e) {
        return { error: 'sandbox confine failed: ' + errorMsg(e) }
      }
      const argv = confined && Array.isArray(confined.argv) ? confined.argv : null
      if (argv === null || argv.length === 0) return { error: 'sandbox confine returned no argv' }
      // runner 在宿主侧按 serverLaunch 起进程 ⇒ 管道由宿主令牌创建，容器只继承句柄。
      spec.serverLaunch = { command: argv[0], args: argv.slice(1) }
      return typeof confined.enforcement === 'string' ? { ...base, enforcement: confined.enforcement } : base
    },

    /** 产出 mcp 专属 meta，并把任务自包含 spec 落盘为 mcp.json。
     *  ★ 必须**同步**返回普通对象：bgjobs 0.4.1-beta 直接 `Object.assign(meta, eng.buildMeta(...))`，
     *  async 会让 meta 拿不到 recordPath，宿主写 cmd.ps1 时报 path undefined。 */
    buildMeta(_ctx, baseMeta, resolveOut) {
      const jobDir = path.dirname(baseMeta.jsonPath)
      const spec = resolveOut.spec
      const serverName = spec.server === undefined || spec.server === null ? '' : String(spec.server)
      const mcpSpecPath = path.join(jobDir, 'mcp.json')
      const isHttp = spec.transport === 'streamable-http' || typeof spec.command !== 'string'
      // 沙箱任务必须已由 resolve 施加隔离：否则宁可提交失败，也不静默降级为不沙箱。
      const sandboxMode = typeof baseMeta.sandbox === 'string' ? baseMeta.sandbox : 'off'
      if (!isHttp && sandboxMode !== 'off' && (spec.serverLaunch === undefined || spec.serverLaunch === null)) {
        throw new Error('mcp job is scheduled with sandbox "' + sandboxMode + '" but the server was never confined; '
          + 'submit it with extra.sandboxMode so the engine resolve() hook can confine it')
      }
      // 描述符链没有 writeFiles 钩子（执行输入不进工作区），mcp.json 是 runner 的输入产物：
      // jobDir 此时已建好，直接同步写。
      writeFileSync(mcpSpecPath, JSON.stringify(spec, null, 2), 'utf8')
      return {
        engine: 'mcp',
        recordPath: path.join(jobDir, 'cmd.ps1'),
        // runner 输出恒为 UTF-8：显式声明码页，读取端不按系统 ANSI 解码。
        logCodePage: 65001,
        mcpRunnerPath: runnerPath,
        nodeExe: resolveOut.nodeExe,
        nodeExeVersion: resolveOut.nodeExeVersion,
        mcpSpecPath,
        ...(resolveOut.enforcement !== undefined ? { enforcement: resolveOut.enforcement } : {}),
        mcp: {
          server: serverName,
          tool: spec.tool === undefined || spec.tool === null ? '' : String(spec.tool),
          transport: isHttp ? 'streamable-http' : 'stdio',
          prewarm: spec.prewarm !== undefined && spec.prewarm !== null,
        },
      }
    },

    /** 描述符：direct + pwsh 信封跑 node runner（runner 必须留在容器外，见 sandboxPolicy 注释）。 */
    buildDescriptor(_ctx, { meta }) {
      return {
        m: 'direct',
        e: 'pwsh',
        // runner 输出本来就是 UTF-8：显式 utf8 比 auto 少一次 28591 成像/还原。
        o: 'utf8',
        c: '& ' + [meta.nodeExe, meta.mcpRunnerPath, meta.mcpSpecPath].map(psQuote).join(' '),
      }
    },
  }
}
