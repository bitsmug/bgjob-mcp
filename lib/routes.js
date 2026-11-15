// bgmcp —— 控制面 HTTP 路由（自 bgjobs/lib/core/web.js 的 MCP 三段平移）。
// 前缀 `/mcp-control`，三段：
//   /prefs        MCP 任务总开关（GET；POST ?enabled=0|1）
//   /servers      server 登记 CRUD / 导入 / 导出 / 探测 / 状态切换
//   /dsh-config   DSH profile 的 MCP 条目只读视图 + 一次性导入
// 只依赖 webServer 服务的 prefix register，不依赖 bgjobs 的 web 域。

import { errorMsg } from 'bgjobs'
import { readMcpConfigs, describeDshMcp, serializeServers, parseServerImport } from './dsh-config.js'

const ROUTE_PREFIX = '/mcp-control'

// 读 JSON 请求体（上限保护）；非 JSON / 空体 / 超限 / 无流（测试桩）→ null（回退 query 形式）。
const readJsonBody = (req) => new Promise((resolve) => {
  if (!req || typeof req.on !== 'function') { resolve(null); return }
  let size = 0
  const chunks = []
  let done = false
  const finish = (v) => { if (!done) { done = true; resolve(v) } }
  req.on('data', (c) => {
    size += c.length
    if (size > 100000) { try { req.destroy() } catch { /* ignore */ } finish(null); return }
    chunks.push(c)
  })
  req.on('end', () => {
    try {
      const text = Buffer.concat(chunks).toString('utf8')
      finish(text.trim().length === 0 ? null : JSON.parse(text))
    } catch { finish(null) }
  })
  req.on('error', () => finish(null))
})

/**
 * 注册控制面路由。deps：{ registry, mcp, prewarm }。
 * registry / mcp 见 lib/registry.js、lib/mcp.js；prewarm 可为 null（无预热域）。
 * 返回 apply 的 disposer。
 */
export function createRoutes(ctx, deps) {
  const { registry, mcp } = deps
  const prewarm = deps.prewarm || null
  const {
    readMcpPrefs, setMcpPrefs, readMcpServers, setMcpServer, deleteMcpServer, setMcpServerState,
  } = registry

  // 对「已登记、启用且 prewarm: true」的 server 预连（MCP 总开关开启时才有意义；纯加速，失败即回退冷启动）。
  const warmPrewarmServers = async () => {
    if (prewarm === null) return
    const { servers } = await readMcpServers()
    for (const [name, cfg] of Object.entries(servers)) {
      if (cfg && cfg.prewarm === true && cfg.enabled !== false) prewarm.warm(name).catch(() => {})
    }
  }

  const disposeRoutes = ctx.inject(['webServer'], (webCtx) => {
    const handler = async (req, res) => {
      const url = new URL(String(req.url || '/'), 'http://localhost')
      const pathname = url.pathname
      const writeJson = (code, body) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(body))
      }
      if (pathname === ROUTE_PREFIX + '/prefs') {
        // GET → MCP 任务总开关（默认关）；POST ?enabled=0|1 → 切换。开关即时生效（工具常驻注册 +
        // 运行时校验）。联动预热：开启 → 对 prewarm 的 server 预连；关闭 → 断开全部常驻连接。
        if (req.method === 'POST') {
          const raw = url.searchParams.get('enabled')
          if (raw === null) { writeJson(400, { ok: false, error: 'missing enabled' }); return }
          const enabled = raw === '1' || raw === 'true'
          const res2 = await setMcpPrefs({ enabled })
          if (enabled) await warmPrewarmServers()
          else if (prewarm !== null) await prewarm.unwarmAll()
          writeJson(200, res2)
        } else {
          writeJson(200, { ok: true, enabled: (await readMcpPrefs()).enabled })
        }
        return
      }
      if (pathname === ROUTE_PREFIX + '/servers') {
        const name = url.searchParams.get('name') || ''
        if (req.method === 'POST') {
          // 删除登记（存在常驻连接一并断开）
          if (url.searchParams.get('delete') === '1') {
            const res2 = await deleteMcpServer(name)
            if (res2.ok && prewarm !== null) await prewarm.unwarm(name)
            writeJson(200, res2.ok ? { ok: true, name } : res2)
            return
          }
          // 每 server 状态按钮（?enabled=0|1 与/或 ?prewarm=0|1）：预热态才预连，其余（含禁用）断开常驻连接
          const enabledRaw = url.searchParams.get('enabled')
          const prewarmRaw = url.searchParams.get('prewarm')
          if (enabledRaw !== null || prewarmRaw !== null) {
            const patch = {}
            if (enabledRaw !== null) patch.enabled = enabledRaw === '1' || enabledRaw === 'true'
            if (prewarmRaw !== null) patch.prewarm = prewarmRaw === '1' || prewarmRaw === 'true'
            const res2 = await setMcpServerState(name, patch)
            if (!res2.ok) { writeJson(200, res2); return }
            const saved = res2.servers[name]
            if (prewarm !== null) {
              if (saved.enabled !== false && saved.prewarm === true) prewarm.warm(name).catch(() => {})
              else await prewarm.unwarm(name)
            }
            writeJson(200, { ok: true, name, enabled: saved.enabled !== false, prewarm: saved.prewarm === true })
            return
          }
          // 从粘贴/上传的文本导入（?import=1；body { text, mode:'skip'|'overwrite', force }）：
          // 兼容 DSH patch 片段 / bgjobs 原生 JSON / 单个配置 / 配置数组；含 !!js 默认拒导（force=1 才导）。
          if (url.searchParams.get('import') === '1') {
            const body = await readJsonBody(req)
            const text = body && typeof body.text === 'string' ? body.text : ''
            const mode = (body && body.mode === 'overwrite') || url.searchParams.get('mode') === 'overwrite' ? 'overwrite' : 'skip'
            const force = (body && body.force === true) || url.searchParams.get('force') === '1'
            const parsed = parseServerImport(text)
            if (parsed.error !== undefined) { writeJson(200, { ok: false, source: parsed.source, error: parsed.error }); return }
            const imported = []
            const skipped = []
            const rejected = []
            for (const row of parsed.servers) {
              if (row.needsAttention === true && !force) {
                rejected.push({ name: row.name, reason: row.attentionReason || 'needs manual attention' })
                continue
              }
              const exists = (await readMcpServers()).servers[row.name] !== undefined
              if (exists && mode !== 'overwrite') { skipped.push({ name: row.name, reason: 'already registered' }); continue }
              const res2 = await setMcpServer(row.name, row.config)
              if (!res2.ok) { rejected.push({ name: row.name, reason: res2.error }); continue }
              imported.push(row.name)
              const saved = res2.servers[row.name]
              if (prewarm !== null && saved && saved.prewarm === true && saved.enabled !== false) prewarm.warm(row.name).catch(() => {})
            }
            writeJson(200, { ok: true, source: parsed.source, hasJsTag: parsed.hasJsTag === true, imported, skipped, rejected })
            return
          }
          // 「列出工具」：用户显式操作 → 不受 MCP 总开关限制（refresh 强制重取）；禁用 server 也允许手动探测
          if (url.searchParams.get('probe') === '1') {
            try {
              const target = await mcp.resolveServer({ server: name }, { allowDisabled: true })
              writeJson(200, await mcp.tools(target, { refresh: true }))
            } catch (e) {
              writeJson(200, { ok: false, error: errorMsg(e) })
            }
            return
          }
          // 新增/覆盖：?config=<urlencoded JSON>，或 JSON body { name, config }
          const rawConfig = url.searchParams.get('config')
          const body = rawConfig === null ? await readJsonBody(req) : null
          let config = null
          let key = name
          if (rawConfig !== null) {
            try { config = JSON.parse(rawConfig) } catch { writeJson(400, { ok: false, error: 'invalid config json' }); return }
          } else if (body && typeof body === 'object' && body.config && typeof body.config === 'object') {
            config = body.config
            if (typeof body.name === 'string' && body.name.trim().length > 0) key = body.name.trim()
          }
          if (config === null) { writeJson(400, { ok: false, error: 'missing config' }); return }
          const res2 = await setMcpServer(key, config)
          if (!res2.ok) { writeJson(200, res2); return }
          const saved = res2.servers[key]
          if (prewarm !== null) {
            if (saved && saved.prewarm === true && saved.enabled !== false) prewarm.warm(key).catch(() => {})
            else await prewarm.unwarm(key)
          }
          writeJson(200, { ok: true, name: key, server: saved })
          return
        }
        // GET → 登记清单（**不回传 env/headers 的值**，只回传键名，防泄漏）
        // 出口三态：?export=yaml|json（导出）→ ?name=<n>（单条明细，编辑用，**含值**）→ 列表。
        const exportFmt = url.searchParams.get('export')
        if (exportFmt !== null) {
          const { servers } = await readMcpServers()
          const out = serializeServers(servers, { name: url.searchParams.get('name') || '*' })
          writeJson(200, { ok: true, format: exportFmt === 'json' ? 'json' : 'yaml', names: out.names, text: exportFmt === 'json' ? out.json : out.yaml })
          return
        }
        const detailName = url.searchParams.get('name')
        if (detailName !== null && detailName !== '') {
          const { servers } = await readMcpServers()
          const cfg = servers[detailName]
          if (cfg === undefined || cfg === null) { writeJson(200, { ok: false, error: 'server not found: ' + detailName }); return }
          writeJson(200, { ok: true, name: detailName, config: cfg })
          return
        }
        const { servers } = await readMcpServers()
        const cache = await mcp.readCache()
        const warmState = new Map((prewarm === null ? [] : prewarm.status()).map((s) => [s.name, s]))
        const rows = Object.entries(servers).map(([n, cfg]) => {
          const registryTools = mcp.registryTools(n)
          const cached = cache[n]
          const warmRec = warmState.get(n)
          const toolCount = registryTools !== null
            ? registryTools.length
            : (cached && Array.isArray(cached.tools) ? cached.tools.length : null)
          return {
            name: n,
            transport: cfg.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
            target: cfg.transport === 'streamable-http'
              ? String(cfg.url || '')
              : [String(cfg.command || ''), ...(Array.isArray(cfg.args) ? cfg.args : [])].join(' '),
            envKeys: Object.keys(cfg.env || {}),
            headerKeys: Object.keys(cfg.headers || {}),
            timeoutMs: typeof cfg.timeoutMs === 'number' ? cfg.timeoutMs : null,
            prewarm: cfg.prewarm === true,
            enabled: cfg.enabled !== false,
            warm: !!(warmRec && warmRec.warm),
            status: warmRec ? warmRec.status : null,
            lastError: warmRec && warmRec.lastError ? warmRec.lastError : null,
            toolCount,
            toolSource: registryTools !== null ? 'registry' : (cached !== undefined ? 'cache' : null),
          }
        })
        writeJson(200, { ok: true, servers: rows })
        return
      }
      if (pathname === ROUTE_PREFIX + '/dsh-config') {
        // GET → 活动 profile 判定 + 各 scope 的 DSH MCP 条目（只读，含 !!js/disabled 标注）；
        // POST ?action=import&scope=<active|global|profile:NAME>&name=<serverName|*>&force=0|1
        //      → 一次性导入成 bgmcp server 登记（同名不覆盖；含 !!js 的默认拒导，force=1 才导）。
        if (req.method === 'POST') {
          if (url.searchParams.get('action') !== 'import') { writeJson(400, { ok: false, error: 'unknown action' }); return }
          const scopeRaw = url.searchParams.get('scope') || 'active'
          const scope = scopeRaw.startsWith('profile:') ? scopeRaw.slice('profile:'.length) : scopeRaw
          const want = url.searchParams.get('name') || '*'
          const force = url.searchParams.get('force') === '1'
          const cfg = await readMcpConfigs(scope)
          if (!cfg.exists) {
            writeJson(200, { ok: false, error: cfg.parseError ? ('parse failed: ' + cfg.parseError) : ('no DSH MCP config found for scope ' + scopeRaw) })
            return
          }
          const current = await readMcpServers()
          const imported = []
          const skipped = []
          const rejected = []
          for (const row of cfg.servers || []) {
            if (want !== '*' && row.serverName !== want) continue
            if (current.servers[row.serverName] !== undefined) { skipped.push({ name: row.serverName, reason: 'already registered' }); continue }
            if (row.needsAttention === true && !force) {
              rejected.push({ name: row.serverName, reason: row.attentionReason || 'needs manual attention (re-import with force=1 then fill in env/headers)' })
              continue
            }
            const res2 = await setMcpServer(row.serverName, row.config)
            if (res2.ok) imported.push(row.serverName)
            else rejected.push({ name: row.serverName, reason: res2.error })
          }
          writeJson(200, { ok: true, scope: cfg.scope, imported, skipped, rejected })
          return
        }
        const data = await describeDshMcp({ includeOthers: url.searchParams.get('all') === '1' })
        const { servers } = await readMcpServers()
        writeJson(200, { ok: true, existing: Object.keys(servers), ...data })
        return
      }
      res.writeHead(404)
      res.end()
    }
    return webCtx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
  })

  return { dispose: [disposeRoutes], warmPrewarmServers }
}
