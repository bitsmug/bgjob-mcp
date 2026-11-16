// bgmcp —— 阶段 1 冒烟测试：包可独立导入、engine/工具/路由形状正确、配置迁移只复制不双写。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as pkg from '../lib/index.js'
import { createMcpEngine } from '../lib/engine.js'
import { createMcpTools } from '../lib/tools.js'
import { createMcpRegistry, mcpHubPaths } from '../lib/registry.js'
import { createProxy } from '../lib/proxy.js'

test('包入口导出骨架与各模块工厂', () => {
  assert.equal(pkg.name, 'bgjob-mcp')
  assert.equal(typeof pkg.apply, 'function')
  assert.deepEqual(pkg.inject, ['tools', 'bgjobEngines', 'bgjobs'])
  for (const fn of ['createMcpEngine', 'createMcpTools', 'createRoutes', 'createMcpRegistry', 'createMcp', 'createProxy', 'createMcpPrewarm']) {
    assert.equal(typeof pkg[fn], 'function', fn + ' should be exported')
  }
})

/** 客户端产物的形状守卫：DSH 客户端模块运行时把 factory 的返回值直接交给 cordis，
 *  apply 不是函数时报 `invalid plugin … received object`（client-src 被当成 ESM 打包时就会这样）。 */
test('client bundle 导出可直接加载的插件对象（apply 为函数）', () => {
  const code = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
  // factory 的 require 只解析模块表词（react / primitives），相对依赖已在构建期内联
  const requireStub = (id) => (id === 'react' ? { createElement: () => ({}) } : {})
  let registration
  const previous = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (m) => { registration = m } } }
  try {
    new Function('require', code)(requireStub)
    assert.ok(registration, 'bundle 应通过 window.__ModuleLoader__.load 注册')
    assert.equal(registration.id, 'bgjob-mcp')
    const plugin = registration.factory(requireStub)
    assert.equal(plugin.name, 'bgjob-mcp-client')
    assert.deepEqual(plugin.inject, ['slots'])
    assert.equal(typeof plugin.apply, 'function')
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
})

test('mcp engine 具备三钩子与三个契约声明且 id 正确', () => {
  const engine = createMcpEngine({ prewarm: null })
  assert.equal(engine.id, 'mcp')
  assert.equal(engine.supportsSandbox, true)
  // bgjobs 只读这些声明、不按 id 特判（见 bgjobs/docs/plan-bgmcp-engine-contract.md）
  assert.equal(engine.sandboxPolicy, 'inherit')
  assert.deepEqual(engine.pidFiles, [{ name: 'run.pid', owned: true }, { name: 'mcp-server.pid', owned: false }])
  assert.equal(engine.resultFile, 'result.json')
  for (const hook of ['resolve', 'buildMeta', 'buildDescriptor']) {
    assert.equal(typeof engine[hook], 'function', hook + ' should be implemented')
  }
  assert.match(pkg.DEFAULT_MCP_RUNNER_PATH, /runner\.mjs$/)
})

test('工具名：bgjob_submit_mcp + mcp_list_tools', () => {
  const ctx = { tools: { register: () => ({ dispose() {} }) } }
  const registry = { readMcpPrefs: async () => ({ enabled: false }) }
  const tools = createMcpTools(ctx, {
    registry,
    mcp: { resolveServer: async () => ({}), tools: async () => ({ ok: true, tools: [] }) },
    submitJob: async () => ({ ok: false }),
    decideJobSandbox: async () => 'off',
    waitSubmittedAny: async () => ({ ok: false }),
  })
  assert.deepEqual(tools.defs.map((d) => d.name), ['bgjob_submit_mcp', 'mcp_list_tools'])
})

/** 工具层接线：ctx 只提供 approval，deps 全部为桩。 */
function makeToolHarness(approval) {
  const submitted = []
  const ctx = { get: (name) => (name === 'approval' ? approval : undefined), tools: { register: () => ({ dispose() {} }) } }
  const deps = {
    registry: { readMcpPrefs: async () => ({ enabled: true }) },
    mcp: {
      resolveServer: async (args) => (typeof args.server === 'string'
        ? { name: args.server, config: { transport: 'stdio', command: 'node', args: ['registered.js'] } }
        : { name: '', config: args.server_config }),
      tools: async () => ({ ok: true, tools: [{ name: 'run' }] }),
    },
    submitJob: async (...a) => { submitted.push(a); return { ok: true, jobId: 'job-1' } },
    decideJobSandbox: async () => 'off',
    waitSubmittedAny: async () => ({ ok: true }),
  }
  const tools = createMcpTools(ctx, deps)
  return {
    submitted,
    submit: tools.defs.find((d) => d.name === 'bgjob_submit_mcp'),
    list: tools.defs.find((d) => d.name === 'mcp_list_tools'),
  }
}

// 测试路径一律由临时目录派生：不出现真实盘符，也不要求这些路径真实存在。
const WORKDIR = path.join(os.tmpdir(), 'bgmcp-smoke-work')
const RUNNER_PATH = path.join(os.tmpdir(), 'bgmcp-test-lib', 'runner.mjs')
const NODE_EXE = path.join(os.tmpdir(), 'bgmcp-test-node', 'node.exe')
const NODE_EXE_WITH_SPACE = path.join(os.tmpdir(), 'bgmcp test nodejs', 'node.exe')
const EXEC = { agent: { session: { id: 's1', header: { cwd: WORKDIR } } }, callId: 'c1' }
const INLINE_CONFIG = { transport: 'stdio', command: 'npx', args: ['-y', 'third-party-mcp'] }

test('内联 server_config：无 approval 服务时 fail closed（提交与探测都拒绝）', async () => {
  const h = makeToolHarness(undefined)
  const res = await h.submit.execute({ name: 't', tool: 'run', workdir: WORKDIR, server_config: INLINE_CONFIG }, EXEC)
  assert.equal(res.ok, false)
  assert.match(res.error, /审批/)
  assert.equal(h.submitted.length, 0)
  const listed = await h.list.execute({ server_config: INLINE_CONFIG }, EXEC)
  assert.equal(listed.ok, false)
})

test('内联 server_config：用户拒绝则不提交，弹窗展示真实命令', async () => {
  const reasons = []
  const h = makeToolHarness({ request: async (req) => { reasons.push(req.reason); return 'rejected' } })
  const res = await h.submit.execute({ name: 't', tool: 'run', workdir: WORKDIR, server_config: INLINE_CONFIG }, EXEC)
  assert.equal(res.ok, false)
  assert.match(res.error, /未批准/)
  assert.equal(h.submitted.length, 0)
  assert.match(reasons[0], /npx -y third-party-mcp/)
})

test('内联 server_config：allowed-once 放行；登记 server 不弹审批', async () => {
  let asked = 0
  const h = makeToolHarness({ request: async () => { asked += 1; return 'allowed-once' } })
  const ok = await h.submit.execute({ name: 't', tool: 'run', workdir: WORKDIR, server_config: INLINE_CONFIG }, EXEC)
  assert.equal(ok.ok, true)
  assert.equal(asked, 1)
  assert.equal(h.submitted.length, 1)
  const registered = await h.submit.execute({ name: 't2', tool: 'run', workdir: WORKDIR, server: 'demo' }, EXEC)
  assert.equal(registered.ok, true)
  assert.equal(asked, 1)
})

test('配置首次读取：从 bgjobs/mcp-servers.json 复制到 mcp-hub/servers.json，旧文件保留', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'bgmcp-'))
  try {
    const paths = mcpHubPaths(home)
    await fsp.mkdir(path.dirname(paths.legacyServers), { recursive: true })
    await fsp.writeFile(paths.legacyServers, JSON.stringify({ servers: { demo: { transport: 'stdio', command: 'node' } } }), 'utf8')
    const registry = createMcpRegistry(home)
    const { servers } = await registry.readMcpServers()
    assert.deepEqual(Object.keys(servers), ['demo'])
    const copied = JSON.parse(await fsp.readFile(paths.servers, 'utf8'))
    assert.deepEqual(Object.keys(copied.servers), ['demo'])
    // 旧文件不删、不改
    assert.equal(JSON.parse(await fsp.readFile(paths.legacyServers, 'utf8')).servers.demo.command, 'node')
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('回环代理：token 鉴权、/tools 与 /call 的 attempted 透传', async () => {
  const proxy = createProxy({
    token: 'secret',
    listTools: async (server) => [{ name: server + '-tool' }],
    call: async () => { const e = new Error('boom'); e.attempted = true; throw e },
  })
  const started = await proxy.init()
  try {
    assert.equal(started.ok, true)
    const ep = proxy.endpoint()
    assert.ok(ep && ep.url.endsWith('/call'))
    const post = (body, token) => fetch(ep.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bgjobs-token': token },
      body: JSON.stringify(body),
    })
    assert.equal((await post({ server: 'demo' }, 'wrong')).status, 401)
    const toolsUrl = ep.url.replace('/call', '/tools')
    const tools = await (await fetch(toolsUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bgjobs-token': 'secret' },
      body: JSON.stringify({ server: 'demo' }),
    })).json()
    assert.deepEqual(tools, { ok: true, tools: [{ name: 'demo-tool' }] })
    const called = await (await post({ server: 'demo', tool: 'x', arguments: {} }, 'secret')).json()
    assert.deepEqual(called, { ok: false, error: 'boom', attempted: true })
  } finally {
    await proxy.dispose()
  }
})

test('engine：mcp.json 落盘 + 描述符 direct/pwsh/utf8 + pid 优先级', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bgmcp-job-'))
  try {
    const engine = createMcpEngine({ prewarm: null, runnerPath: RUNNER_PATH })
    const spec = { transport: 'stdio', command: 'node', args: ['srv.js'], server: 'demo', tool: 'echo', arguments: { text: 'hi' } }
    const base = { jsonPath: path.join(dir, 'job.json'), workdir: dir, taskName: 'dsh-bgj-test' }
    const engineMeta = engine.buildMeta(null, base, { nodeExe: NODE_EXE, nodeExeVersion: '24.0.0', spec })
    // bgjobs 0.4.1-beta 的 buildMeta 是同步调用（不 await）⇒ 必须返回普通对象而不是 Promise。
    assert.equal(typeof engineMeta.then, 'undefined')
    const meta = { ...base, ...engineMeta }
    assert.equal(meta.recordPath, path.join(dir, 'cmd.ps1'))
    assert.equal(meta.mcp.server, 'demo')
    assert.deepEqual(JSON.parse(await fsp.readFile(path.join(dir, 'mcp.json'), 'utf8')), spec)

    meta.nodeExe = NODE_EXE_WITH_SPACE
    const d = engine.buildDescriptor(null, { meta, sandbox: 'off', backend: 'dsh', resolveOut: {}, extra: {} })
    assert.equal(d.m, 'direct')
    assert.equal(d.e, 'pwsh')
    assert.equal(d.o, 'utf8')
    assert.equal(d.c, "& '" + NODE_EXE_WITH_SPACE + "' '" + RUNNER_PATH + "' '" + path.join(dir, 'mcp.json') + "'")
    assert.deepEqual(engine.pidFiles.map((p) => p.name), ['run.pid', 'mcp-server.pid'])
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('engine 沙箱：提交期把 server 包进 confined argv；缺服务/非 exe 时 fail closed', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bgmcp-job-sbx-'))
  try {
    const engine = createMcpEngine({ prewarm: null, runnerPath: RUNNER_PATH })
    const spec = { transport: 'stdio', command: process.execPath, args: ['srv.js'], server: 'demo', tool: 'echo' }
    const base = { jsonPath: path.join(dir, 'job.json'), workdir: dir, taskName: 't', sandbox: 'workspace-write' }
    const extra = { mcpSpec: spec, sandboxMode: 'workspace-write' }
    const calls = []
    const ctx = {
      get: (name) => (name === 'sandbox'
        ? { confine: async (argv, policy) => { calls.push({ argv, policy }); return { argv: ['wxc.exe', '--config-base64', 'x', '--'].concat(argv), enforcement: 'partial' } } }
        : undefined),
    }
    // confine 在 resolve（两种 bgjobs 契约都 await）里施加，结果烘进 spec.serverLaunch
    const resolveOut = await engine.resolve(ctx, { workdir: dir, extra })
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].policy, { mode: 'workspace-write', workspaceRoot: dir })
    assert.equal(calls[0].argv[0], process.execPath)
    const meta = engine.buildMeta(ctx, base, resolveOut)
    assert.equal(meta.enforcement, 'partial')
    const written = JSON.parse(await fsp.readFile(path.join(dir, 'mcp.json'), 'utf8'))
    assert.equal(written.serverLaunch.command, 'wxc.exe')
    assert.deepEqual(written.serverLaunch.args.slice(0, 3), ['--config-base64', 'x', '--'])

    // 没有 sandbox 服务 ⇒ 提交失败（不得静默降级为不沙箱）
    const noSvc = await engine.resolve(null, { workdir: dir, extra })
    assert.match(noSvc.error, /ctx\.sandbox/)
    // 解析不到原生 .exe（如 npx.cmd）⇒ 提交失败
    const shell = await engine.resolve(ctx, { workdir: dir, extra: { ...extra, mcpSpec: { ...spec, command: 'npx -y third-party-mcp' } } })
    assert.match(shell.error, /native \.exe/)
    // streamable-http 不起进程 ⇒ 不需要 serverLaunch，也不要求 sandbox 服务
    const http = engine.buildMeta(null, base, await engine.resolve(null, {
      workdir: dir,
      extra: { ...extra, mcpSpec: { transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp', server: 'demo', tool: 'echo' } },
    }))
    assert.equal(http.mcp.transport, 'streamable-http')
    assert.equal(http.enforcement, undefined)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('runtime：serverLaunch 透传给 StdioClientTransport，未设置时回落到 command/args', async () => {
  const { normalizeConfig, createTransport } = await import('../lib/runtime.js')
  const launched = normalizeConfig({ transport: 'stdio', command: 'node', args: ['srv.js'], serverLaunch: { command: 'wxc.exe', args: ['--config-base64', 'x', '--', 'node'] } })
  assert.deepEqual(launched.serverLaunch, { command: 'wxc.exe', args: ['--config-base64', 'x', '--', 'node'] })
  assert.equal(launched.command, 'node')
  const plain = normalizeConfig({ transport: 'stdio', command: 'node', args: ['srv.js'] })
  assert.equal(plain.serverLaunch, undefined)
  const t = createTransport({ transport: 'stdio', command: 'node', args: ['srv.js'], serverLaunch: { command: 'wxc.exe', args: ['--x'] } })
  assert.equal(t._serverParams.command, 'wxc.exe')
  assert.deepEqual(t._serverParams.args, ['--x'])
})
