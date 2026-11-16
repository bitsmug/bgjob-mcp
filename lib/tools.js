// bgmcp —— MCP 工具（自 bgjobs/lib/core/tools.js 平移）：
//   - bgjob_submit_mcp：提交 MCP 工具调用任务（engine 固定 mcp）
//   - mcp_list_tools：列出某 server 的工具清单（原 bgjob_mcp_tools）
// 本模块只产出工具定义；注册与 deps 接线由 index.js 在阶段 2 完成。

import { MCP_DISABLED_ERROR } from './registry.js'

const errorMsg = (e) => (e && e.message ? String(e.message) : String(e))

// 与 bgjobs/lib/notify-policy.js 的协议枚举一致（该模块未从包根导出，故此处重复常量）。
const BGJOB_NOTIFY_MODES = ['off', 'on-completion', 'on-fail', 'on-exit']
const BGJOB_NOTIFY_DELIVERIES = ['wakeup', 'quiet', 'always']

/**
 * 内联 server_config 审批：agent 直接指定 command/url 等于绕过设置页登记，
 * 必须在真正 spawn 之前由用户逐次确认；登记 server 视为用户已表达过意图，不弹窗。
 * @returns {Promise<string|null>} 拒绝原因；null = 放行
 */
const requireInlineApproval = async (ctx, exec, toolName, target) => {
  if (target.name.length > 0) return null
  if (!exec || !exec.agent) {
    return '内联 server_config 需要用户审批，但当前调用没有交互会话；请改用设置页登记的 MCP server'
  }
  const approval = ctx.get('approval')
  if (!approval || typeof approval.request !== 'function') {
    return '内联 server_config 需要用户审批，但宿主未装配 approval 服务；请改用设置页登记的 MCP server'
  }
  const config = target.config && typeof target.config === 'object' ? target.config : {}
  let what = config.transport === 'streamable-http'
    ? 'url ' + String(config.url)
    : [String(config.command), ...(Array.isArray(config.args) ? config.args.map(String) : [])].join(' ')
  if (what.length > 400) what = what.slice(0, 397) + '...'
  let outcome
  try {
    outcome = await approval.request({
      agent: exec.agent,
      toolName,
      callId: exec.callId,
      reason: '启动内联 MCP server：' + what,
      ...(exec.signal === undefined ? {} : { signal: exec.signal }),
    })
  } catch (e) {
    return '内联 server_config 审批失败：' + errorMsg(e)
  }
  if (outcome === 'allowed-once') return null
  return '用户未批准内联 server_config（' + String(outcome) + '）；如需长期使用请在设置页登记该 server'
}

/**
 * 创建 MCP 工具定义。deps：
 *   - registry: createMcpRegistry() 的返回（读 MCP 总开关）
 *   - mcp: lib/mcp.js 的 api（resolveServer / tools）
 *   - submitJob: bgjobs 的提交入口（阶段 2 接线）
 *   - decideJobSandbox: bgjobs 的沙箱决策函数
 *   - waitSubmittedAny: bgjobs 的等待函数
 * 返回 { register() }：register() 逐个注册并返回 disposer 数组。
 */
export function createMcpTools(ctx, deps) {
  const { registry, mcp, submitJob, decideJobSandbox, waitSubmittedAny } = deps

  /** mcp 引擎提交主体。 */
  const runMcpSubmit = async (args, exec) => {
    // ① 总开关（fail closed；工具常驻注册 + 运行时校验，关掉即时生效、无需重启 DSH）。
    if ((await registry.readMcpPrefs()).enabled !== true) return { ok: false, error: MCP_DISABLED_ERROR }
    // ② 解析 server（登记名或内联）。
    let target
    try { target = await mcp.resolveServer(args) } catch (e) { return { ok: false, error: errorMsg(e) } }
    // ③ 内联配置审批：必须先于任何 spawn（下面的工具清单探测会真的启动 server）。
    const inlineDenied = await requireInlineApproval(ctx, exec, 'bgjob_submit_mcp', target)
    if (inlineDenied !== null) return { ok: false, error: inlineDenied }
    // ④ tool 名纠错：解析出工具清单后校验，避免模型反复猜名字；探测失败不阻断提交
    //    （任务自身会报出真实错误），只有"清单拿到了但没这个 tool"才拒绝。
    try {
      const listing = await mcp.tools(target)
      if (listing && listing.ok === true && Array.isArray(listing.tools) && listing.tools.length > 0) {
        const wanted = String(args.tool)
        if (!listing.tools.some((t) => t.name === wanted)) {
          const names = listing.tools.map((t) => t.name)
          const shown = names.slice(0, 30).join(', ')
          const more = names.length > 30 ? ' (+' + String(names.length - 30) + ' more)' : ''
          return { ok: false, error: 'unknown MCP tool "' + wanted + '" on server "' + (target.name || 'inline') + '"; available tools: ' + shown + more }
        }
      }
    } catch (e) { /* 探测失败忽略：任务里会重新连接并报真实原因 */ }
    // 超时：显式参数 > server 登记值 > 不限时（不写 timeoutMs，runner 视为无限）。
    const timeoutArg = Number(args.timeout_seconds)
    const timeoutMs = Number.isFinite(timeoutArg) && timeoutArg > 0
      ? timeoutArg * 1000
      : (typeof target.timeoutMs === 'number' && target.timeoutMs > 0 ? target.timeoutMs : undefined)
    const serverLabel = target.name.length > 0 ? target.name : 'inline'
    const spec = {
      ...target.config,
      server: serverLabel,
      tool: String(args.tool),
      arguments: args.arguments && typeof args.arguments === 'object' ? args.arguments : {},
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }
    const createdBySession = exec && exec.agent && exec.agent.session ? String(exec.agent.session.id) : ''
    // workdir 可省：缺省用「当前会话的工作目录」（与 bgjob_submit 同口径）。
    let workdir = typeof args.workdir === 'string' ? args.workdir.trim() : ''
    if (workdir.length === 0) {
      const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
        ? exec.agent.session.header.cwd : undefined
      if (typeof cwd === 'string' && cwd.length > 0) workdir = cwd
    }
    if (workdir.length === 0) return { ok: false, error: 'workdir 必填（当前会话没有可用的工作目录）' }
    // 本引擎 sandboxPolicy=inherit 但恒提交 off（MCP 不经宿主隔离通道）：受限会话里
    // bgjobs 会走逐次升权审批；拒绝/取消/未挂沙箱服务都会抛错，统一转成工具错误。
    let mode
    try {
      mode = await decideJobSandbox(
        {
          ...args,
          sandbox: 'off',
          justification: 'MCP server 由官方 SDK 直接 spawn，stdio transport 依赖匿名管道，无法在 bgjobs 沙箱内执行',
        },
        exec, 'bgjob_submit_mcp', 'mcp',
      )
    } catch (e) { return { ok: false, error: errorMsg(e) } }
    const res = await submitJob(
      args.name, 'mcp: ' + serverLabel + ' → ' + String(args.tool), workdir, createdBySession,
      'mcp', mode, args.notify, args.notify_mode,
      // sandboxMode 随 extra 进引擎 resolve：提交期 confine（把 server 包进隔离 argv）只能在
      // resolve 里做 —— bgjobs 0.4.1-beta 的 buildMeta 是同步调用。
      { mcpSpec: spec, serverName: target.name, outputEncoding: 'utf8', sandboxMode: mode },
    )
    // wait=秒：任意正数秒；0/非法值=不等待。
    const waitArg = Number(args.wait)
    const waitSec = Number.isFinite(waitArg) && waitArg > 0 ? waitArg : 0
    if (res.ok && waitSec > 0) return waitSubmittedAny(res.jobId, exec, waitSec * 1000)
    return res.ok ? { ...res, engine: 'mcp', server: serverLabel, tool: String(args.tool) } : res
  }

  const submitDef = {
    name: 'bgjob_submit_mcp',
    description: 'MCP 任务入口：server|server_config + tool + arguments + timeout_seconds（另需 name）。bgjob_submit 不接受 mcp 参数，mcp 任务必须从本工具提交。',
    presentCall: (args) => ({
      card: 'generic',
      title: '提交 MCP 工具调用',
      kind: 'execute',
      rawInput: args && typeof args.name === 'string' ? args.name : undefined,
    }),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: '任务名（显示在监控面板与完成通知里）' },
        workdir: { type: 'string', description: '可选：工作目录绝对路径（DSH 工作区内）。缺省=当前会话的工作目录；任务文件在 <workdir>/.dsh/bgjobs/<id>/' },
        tool: { type: 'string', description: '要调用的 MCP 工具名（先用 mcp_list_tools 查看该 server 的工具清单）' },
        arguments: { type: 'object', additionalProperties: true, description: '可选：工具参数对象（缺省 {}）' },
        server: { type: 'string', description: '设置页登记的 MCP server 名；与 server_config 二选一' },
        server_config: { type: 'object', additionalProperties: true, description: '内联 MCP server 配置（自包含）；与 server 二选一。stdio: {transport:"stdio",command,args,env,cwd}；http: {transport:"streamable-http",url,headers}。**每次提交前都会请求用户审批**（登记 server 不弹窗）' },
        timeout_seconds: { type: 'number', description: '可选：工具调用超时秒数。**缺省（不传）＝不限时**——一直等到工具返回；该 server 在设置页登记了 timeoutMs 时，以登记值为缺省（显式传值仍覆盖）。传任意正数秒（含小数）；超时任务退出码 3' },
        wait: { type: 'number', default: 0, description: '可选：提交成功后原地等待的秒数。0/缺省=不等待立即返回；>0 则内部按 bgjob_wait「全缺省」等待（有会话任务时等 notify 视图任一先交付即返回）。可传任意正数秒，不设上限；超时返回 timedOut:true 快照可续等；等待期间用户点停止/打断会让本次调用**以错误结束**（任务继续后台运行、不标记已交付，可改用 bgjob_wait 续等）。' },
        notify: { type: 'string', enum: BGJOB_NOTIFY_MODES, default: 'off', description: '可选：任务结束后是否通知创建它的 agent 会话。off=不通知（缺省，仅网页 Toast）；on-completion=仅成功（exit 0）时通知；on-fail=仅异常退出（exit≠0）时通知；on-exit=任何退出都通知。' },
        notify_mode: { type: 'string', enum: BGJOB_NOTIFY_DELIVERIES, default: 'wakeup', description: '可选：通知送达方式（仅 notify≠off 时有意义）。wakeup=缺省；quiet=仅排入收件箱不唤醒；always=空闲恒唤醒。' },
      },
      required: ['name', 'tool'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          jobId: { type: 'string' },
          taskName: { type: 'string' },
          logPath: { type: 'string' },
          engine: { type: 'string' },
          server: { type: 'string' },
          tool: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      return runMcpSubmit(args, exec)
    },
  }

  const listToolsDef = {
    name: 'mcp_list_tools',
    description: '列出某 MCP server 的注册工具（名 + 描述 + 必填字段）。server 与 server_config 二选一；refresh:true 绕过 10 分钟缓存。返回 source: registry|cache|probe。',
    presentCall: (args) => ({
      card: 'generic',
      title: '列出 MCP 工具',
      kind: 'execute',
      rawInput: (args && (typeof args.server === 'string' ? args.server : undefined)) || undefined,
    }),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        server: { type: 'string', description: '设置页登记的 MCP server 名；与 server_config 二选一' },
        server_config: { type: 'object', additionalProperties: true, description: '内联 MCP server 配置（自包含）；与 server 二选一。**每次调用前都会请求用户审批**（登记 server 不弹窗）' },
        refresh: { type: 'boolean', default: false, description: '可选：true 绕过 10 分钟工具列表缓存强制重取' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          server: { type: 'string' },
          transport: { type: 'string' },
          source: { type: 'string' },
          channel: { type: 'string' },
          tools: { type: 'array' },
          fetchedAt: { type: 'number' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if ((await registry.readMcpPrefs()).enabled !== true) return { ok: false, error: MCP_DISABLED_ERROR }
      let target
      try { target = await mcp.resolveServer(args) } catch (e) { return { ok: false, error: errorMsg(e) } }
      const denied = await requireInlineApproval(ctx, exec, 'mcp_list_tools', target)
      if (denied !== null) return { ok: false, error: denied }
      return await mcp.tools(target, { refresh: args.refresh === true })
    },
  }

  return {
    defs: [submitDef, listToolsDef],
    register: () => [ctx.tools.register(submitDef), ctx.tools.register(listToolsDef)],
  }
}
