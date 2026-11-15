// bgmcp —— DSH 插件入口。
// 职责：把 mcp engine 注册进 bgjobs 的 engine registry，并注册 MCP 工具 / 控制面路由。
// 未安装本包时 bgjobs 不注册任何 MCP 能力（fail-closed，无降级）。

import { readFileSync } from 'node:fs'
import { resolveDshHome, resolveMcpHubHome } from './home.js'
import { createMcpRegistry } from './registry.js'
import { createMcp } from './mcp.js'
import { createMcpEngine } from './engine.js'
import { createMcpTools } from './tools.js'
import { createRoutes } from './routes.js'
import { newPrewarm } from './pool.js'

export { resolveDshHome, resolveMcpHubHome }
export { createMcpRegistry, mcpHubPaths, MCP_DISABLED_ERROR, mcpServerDisabledError } from './registry.js'
export { createMcp } from './mcp.js'
export { createMcpEngine, DEFAULT_MCP_RUNNER_PATH } from './engine.js'
export { createMcpTools } from './tools.js'
export { createRoutes } from './routes.js'
export { createProxy } from './proxy.js'
export { createMcpPrewarm, setPrewarmFactory, newPrewarm, missingCommandPath } from './pool.js'
export * from './runtime.js'
export {
  MCP_CLIENT_PLUGIN, SELF_PLUGIN_NAME, profileFromArgv, listProfiles, detectActiveProfile,
  extractMcpServers, readMcpConfigs, describeDshMcp, serializeServers, parseServerImport,
} from './dsh-config.js'

/** 插件名（cordis.patch.yml 的 name 必须是包根名，见包 README）。 */
export const name = 'bgmcp'

/** bgjobs 的 engine registry 与提交服务是硬依赖：未安装 bgjobs 时本插件不应用。
 *  cordis 4 里服务必须由 bgjobs 用 ctx.provide 提供；直接给 ctx 赋值会抛错。 */
export const inject = ['tools', 'bgjobEngines', 'bgjobs']

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

/** 释放回调逐个尽力执行：单个失败不阻断其余清理。 */
const run = (fn) => { try { fn() } catch { /* noop */ } }

/**
 * 注册 mcp engine、MCP 工具与控制面路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx cordis 上下文
 * @returns {() => void} 释放本插件注册的全部能力
 */
export function apply(ctx) {
  const version = () => VERSION
  const registry = createMcpRegistry()
  const prewarm = newPrewarm({
    resolveConfig: async (serverName) => (await registry.readMcpServers()).servers[String(serverName)] || null,
    version,
  })
  const mcp = createMcp({ ctx, registry, prewarm: prewarm.api, version, cachePath: () => registry.paths.toolsCache })
  const tools = createMcpTools(ctx, {
    registry,
    mcp: mcp.api,
    submitJob: ctx.bgjobs.submitJob,
    decideJobSandbox: ctx.bgjobs.decideJobSandbox,
    waitSubmittedAny: ctx.bgjobs.waitSubmittedAny,
  })
  const routes = createRoutes(ctx, { registry, mcp: mcp.api, prewarm: prewarm.api })
  const disposeEngine = ctx.bgjobEngines.registerEngine(createMcpEngine({ prewarm: prewarm.api }))
  const disposeTools = tools.register()
  // 模型可见的使用指引：仅在 systemPrompt 服务就绪时补一段（本包不硬依赖它）。
  const disposeGuidance = ctx.inject(['systemPrompt'], (c) => c.systemPrompt.section({
    name: 'tool:mcp-control',
    order: 151,
    text: [
      '【MCP 后台任务】',
      '- bgjob_submit_mcp：把一次 MCP 工具调用提交为后台任务（需先在「MCP 任务」设置页开启总开关）；server 与 server_config 二选一；退出码 0 成功 / 1 工具报错 / 2 连接或调用失败 / 3 超时；timeout_seconds 缺省不限时。',
      '- mcp_list_tools：列出某 MCP server 的注册工具（名/描述/必填字段）——提交前先用它确认工具名与参数形状。',
    ].join('\n'),
  }))

  // 预热只做加速：失败不影响任务正确性，故不向调用方传播。
  const startPrewarm = async () => {
    const started = await prewarm.api.init()
    if (!started.ok) return
    if ((await registry.readMcpPrefs()).enabled !== true) return
    await routes.warmPrewarmServers()
  }
  startPrewarm().catch(() => {})

  return () => {
    for (const dispose of disposeTools) dispose()
    for (const dispose of routes.dispose) dispose()
    for (const dispose of prewarm.dispose) dispose()
    run(disposeGuidance)
    disposeEngine()
  }
}
