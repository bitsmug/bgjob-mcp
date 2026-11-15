// bgmcp —— 阶段 2 接线测试：apply 注册 mcp engine/工具/路由、runner 端到端、
// 以及「不装本包时 bgjobs 不提供 mcp 能力」的 fail-closed 行为。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as pkg from '../lib/index.js'
import { createMcpEngine } from '../lib/engine.js'
import { apply as applyBgjobs, setSchtasksRunner } from 'bgjobs'

const RUNNER = fileURLToPath(new URL('../lib/runner.mjs', import.meta.url))
const DEMO = fileURLToPath(new URL('./fixtures/demo-mcp-server.mjs', import.meta.url))

/** 隔离 DSH_HOME，避免读写真实用户配置。 */
async function withIsolatedHome(fn) {
  const previous = process.env.DSH_HOME
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcp-control-test-'))
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
}

/** bgjobs apply 可用的最小 ctx（与 bgjobs tests/helpers/common.js 的 makeCtx 同形）。 */
function makeHostCtx() {
  const services = new Map()
  const tools = []
  const sections = []
  return {
    tools,
    sections,
    ctx: {
      get: (name) => services.get(name),
      provide: (name, value) => { services.set(name, value); return () => { services.delete(name) } },
      interval: () => () => {},
      on: () => () => {},
      inject: () => () => {},
      tools: { register(def) { tools.push(def); return () => {} } },
      systemPrompt: { section(def) { sections.push(def); return () => {} } },
    },
  }
}

test('apply：注册 mcp engine + 两个工具，并声明硬依赖', async () => {
  await withIsolatedHome(async () => {
    const registered = []
    const tools = []
    const { ctx } = makeHostCtx()
    const hostCtx = {
      ...ctx,
      tools: { register(def) { tools.push(def); return () => {} } },
      bgjobEngines: {
        registerEngine(engine) { registered.push(engine); return () => {} },
      },
      bgjobs: {
        submitJob: async () => ({ ok: false }),
        decideJobSandbox: async () => 'off',
        waitSubmittedAny: async () => ({ ok: false }),
      },
    }
    const dispose = pkg.apply(hostCtx)
    assert.equal(typeof dispose, 'function')
    assert.deepEqual(pkg.inject, ['tools', 'bgjobEngines', 'bgjobs'])
    assert.deepEqual(registered.map((e) => e.id), ['mcp'])
    assert.deepEqual(tools.map((d) => d.name).sort(), ['bgjob_submit_mcp', 'mcp_list_tools'])
    dispose()
  })
})

test('submitJob(engine=mcp)：描述符链落盘 mcp.json / cmd.ps1 并登记任务', async () => {
  await withIsolatedHome(async () => {
    setSchtasksRunner(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const { ctx } = makeHostCtx()
    const dispose = applyBgjobs(ctx)
    const workdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bgmcp-work-'))
    try {
      ctx.get('bgjobEngines').registerEngine(createMcpEngine({ prewarm: null }))
      const res = await ctx.get('bgjobs').submitJob(
        'mcp job', 'mcp: demo → echo', workdir, 's1', 'mcp', 'off', 'off', 'wakeup', {
          mcpSpec: { transport: 'stdio', command: process.execPath, args: [DEMO], server: 'demo', tool: 'echo', arguments: { text: 'hi' } },
          serverName: 'demo',
          outputEncoding: 'utf8',
        },
      )
      assert.equal(res.ok, true, res.error)
      const jobDir = path.join(workdir, '.dsh', 'bgjobs', res.jobId)
      const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
      assert.equal(meta.engine, 'mcp')
      assert.equal(meta.logCodePage, 65001)
      assert.equal(meta.mcp.server, 'demo')
      assert.equal(meta.recordPath, path.join(jobDir, 'cmd.ps1'))
      assert.deepEqual(meta.pidFiles.map((p) => p.name), ['run.pid', 'mcp-server.pid'])
      assert.equal(JSON.parse(await fsp.readFile(path.join(jobDir, 'mcp.json'), 'utf8')).tool, 'echo')
      assert.match(await fsp.readFile(path.join(jobDir, 'cmd.ps1'), 'utf8'), /mcp: demo/)
    } finally {
      dispose()
      await fsp.rm(workdir, { recursive: true, force: true })
    }
  })
})

test('bgjobs 未装本包：engine 枚举只有 bat/pwsh，engine="mcp" 报 not registered', async () => {
  await withIsolatedHome(async () => {
    setSchtasksRunner(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const { ctx } = makeHostCtx()
    const dispose = applyBgjobs(ctx)
    try {
      assert.deepEqual(ctx.get('bgjobEngines').list().map((e) => e.id).sort(), ['bat', 'pwsh'])
      assert.equal(ctx.get('bgjobEngines').get('mcp'), null)
      const workdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bgmcp-work-'))
      try {
        const res = await ctx.get('bgjobs').submitJob('x', 'echo hi', workdir, 's1', 'mcp', 'off', 'off', 'wakeup')
        assert.equal(res.ok, false)
        assert.match(res.error, /engine "mcp" not registered/)
      } finally {
        await fsp.rm(workdir, { recursive: true, force: true })
      }
    } finally {
      dispose()
    }
  })
})

test('routes：以 /mcp-control 前缀注册到 webServer', async () => {
  const registered = []
  const ctx = {
    inject(_names, cb) {
      cb({ webServer: { register(def) { registered.push(def); return () => {} } } })
      return () => {}
    },
  }
  const registry = { readMcpPrefs: async () => ({ enabled: false }), readMcpServers: async () => ({ servers: {} }) }
  const routes = pkg.createRoutes(ctx, { registry, mcp: {}, prewarm: null })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].kind, 'prefix')
  assert.equal(registered[0].path, '/mcp-control')
  assert.equal(typeof routes.warmPrewarmServers, 'function')
})

test('runner：冷启动调用 demo server，退出码 0 且写 result.json', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcp-control-run-'))
  try {
    const specPath = path.join(dir, 'mcp.json')
    await fsp.writeFile(specPath, JSON.stringify({
      transport: 'stdio',
      command: process.execPath,
      args: [DEMO],
      server: 'demo',
      tool: 'echo',
      arguments: { text: 'hello runner' },
    }), 'utf8')
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [RUNNER, specPath], { windowsHide: true })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (c) => { stdout += c.toString('utf8') })
      child.stderr.on('data', (c) => { stderr += c.toString('utf8') })
      child.on('error', (e) => resolve({ code: null, stdout, stderr: String(e && e.message) }))
      child.on('close', (code) => resolve({ code, stdout, stderr }))
    })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /hello runner/)
    const written = JSON.parse(await fsp.readFile(path.join(dir, 'result.json'), 'utf8'))
    assert.equal(written.ok, true)
    assert.match(JSON.stringify(written), /hello runner/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})
