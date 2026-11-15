// bgmcp —— MCP 登记数据（自 bgjobs/lib/core/store.js 的 MCP 段平移）。
// 持久化目录从 `$DSH_HOME/bgjobs/` 迁到 `$DSH_HOME/mcp-hub/`：
//   prefs.json（MCP 任务总开关，默认关）、servers.json、tools-cache.json。
// 首次惰性读取时若新文件不存在而旧文件存在 → **复制一次**；旧文件不删、不改、不双写。

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { resolveDshHome, resolveMcpHubHome } from './home.js'
import { normalizeConfig } from './runtime.js'

const errorMsg = (e) => (e && e.message ? String(e.message) : String(e))

/** MCP 任务总开关关闭时的统一文案（工具层执行与提交层共用，避免两处漂移）。 */
export const MCP_DISABLED_ERROR = 'MCP jobs are disabled; turn on the "MCP jobs" switch in the bgmcp settings page'

/** 单个 server 被设为「禁用」时的统一文案（resolveServer 抛错，两个 MCP 工具共用）。 */
export const mcpServerDisabledError = (name) =>
  'MCP server "' + name + '" is disabled; set it to "Cold start" or "Pre-warm" in the bgmcp MCP settings page'

/** 返回 MCP 控制面配置路径（tools-cache 也放这里）。 */
export function mcpHubPaths(home = resolveDshHome()) {
  const dir = path.join(home, 'mcp-hub')
  return {
    dir,
    prefs: path.join(dir, 'prefs.json'),
    servers: path.join(dir, 'servers.json'),
    toolsCache: path.join(dir, 'tools-cache.json'),
    legacyPrefs: path.join(home, 'bgjobs', 'mcp-prefs.json'),
    legacyServers: path.join(home, 'bgjobs', 'mcp-servers.json'),
  }
}

/**
 * 读取 JSON；新文件不存在时尝试从旧路径复制一次（只复制，不双写）。
 * 解析失败/缺失 → 返回 undefined（调用方回落缺省）。
 */
async function readJsonWithMigration(file, legacy, normalize) {
  try {
    return normalize(JSON.parse(await fsp.readFile(file, 'utf8')))
  } catch (e) {
    if (!e || e.code !== 'ENOENT') return normalize(undefined)
    try {
      const raw = await fsp.readFile(legacy, 'utf8')
      const parsed = normalize(JSON.parse(raw))
      try {
        await fsp.mkdir(path.dirname(file), { recursive: true })
        await fsp.writeFile(file, raw, 'utf8')
      } catch { /* 复制失败不影响本次读取 */ }
      return parsed
    } catch { return normalize(undefined) }
  }
}

/**
 * 创建本 apply 实例持有的 MCP 登记状态（惰性读单飞 + 写回填不覆盖期间写入）。
 */
export function createMcpRegistry(home = resolveDshHome()) {
  const paths = mcpHubPaths(home)
  const resolveConfigPath = () => paths

  // ── MCP 任务总开关（设置页；**默认关闭**）。只控制「提交」，不隐藏 server 登记区，
  //    也不影响已提交/运行中的 MCP 任务；即时生效（工具常驻注册 + 运行时校验）。
  let prefsCache = null
  let prefsInflight = null
  const readMcpPrefs = async () => {
    if (prefsCache !== null) return prefsCache
    if (prefsInflight === null) {
      prefsInflight = readJsonWithMigration(
        resolveConfigPath().prefs,
        resolveConfigPath().legacyPrefs,
        (raw) => ({ enabled: raw !== undefined && raw.enabled !== false }),
      )
    }
    const loaded = await prefsInflight
    prefsInflight = null
    if (prefsCache === null) prefsCache = loaded
    return prefsCache
  }
  const setMcpPrefs = async (patch) => {
    const current = await readMcpPrefs()
    const src = patch && typeof patch === 'object' ? patch : {}
    prefsCache = { enabled: 'enabled' in src ? src.enabled !== false : current.enabled }
    try {
      const p = resolveConfigPath().prefs
      await fsp.mkdir(path.dirname(p), { recursive: true })
      await fsp.writeFile(p, JSON.stringify(prefsCache, null, 2), 'utf8')
    } catch { /* 尽力而为 */ }
    return { ok: true, enabled: prefsCache.enabled }
  }

  // ── MCP server 登记清单（自维护；DSH 侧配置经 dsh-config.js 一次性导入）。
  //    servers.json = { servers: { <name>: <config> } }；config = normalizeConfig 结果
  //    + 可选 timeoutMs + prewarm（每 server 预热开关，缺省 false）+ enabled（缺省 true）。
  let serversCache = null
  let serversInflight = null
  const normalizeServers = (raw) =>
    raw && raw.servers && typeof raw.servers === 'object' ? { servers: raw.servers } : { servers: {} }
  const normalizeServerConfig = (raw, fallback) => {
    const base = normalizeConfig(raw)
    const out = { ...base }
    const fb = fallback && typeof fallback === 'object' ? fallback : {}
    if (raw && typeof raw === 'object') {
      if (typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0) out.timeoutMs = Math.floor(raw.timeoutMs)
      if (typeof raw.prewarm === 'boolean') out.prewarm = raw.prewarm
      if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
    }
    if (typeof out.prewarm !== 'boolean') out.prewarm = typeof fb.prewarm === 'boolean' ? fb.prewarm : false
    if (typeof out.enabled !== 'boolean') out.enabled = typeof fb.enabled === 'boolean' ? fb.enabled : true
    return out
  }
  const readMcpServers = async () => {
    if (serversCache !== null) return serversCache
    if (serversInflight === null) {
      serversInflight = readJsonWithMigration(
        resolveConfigPath().servers,
        resolveConfigPath().legacyServers,
        normalizeServers,
      )
    }
    const loaded = await serversInflight
    serversInflight = null
    if (serversCache === null) serversCache = loaded
    return serversCache
  }
  const persistMcpServers = async () => {
    try {
      const p = resolveConfigPath().servers
      await fsp.mkdir(path.dirname(p), { recursive: true })
      await fsp.writeFile(p, JSON.stringify({ servers: serversCache.servers }, null, 2), 'utf8')
    } catch { /* 尽力而为 */ }
    return { ok: true, servers: serversCache.servers }
  }
  /** 新增/覆盖一个 server（同名覆盖；未显式给 prewarm/enabled 时保留原值）。 */
  const setMcpServer = async (name, config) => {
    const key = String(name === undefined || name === null ? '' : name).trim()
    if (key.length === 0) return { ok: false, error: 'missing server name' }
    const current = await readMcpServers()
    const existing = current.servers[key]
    let normalized
    try {
      normalized = normalizeServerConfig(config, existing ? { prewarm: existing.prewarm, enabled: existing.enabled } : {})
    } catch (e) {
      return { ok: false, error: errorMsg(e) }
    }
    serversCache = { servers: { ...current.servers, [key]: normalized } }
    return await persistMcpServers()
  }
  const deleteMcpServer = async (name) => {
    const key = String(name === undefined || name === null ? '' : name).trim()
    const current = await readMcpServers()
    if (current.servers[key] === undefined) return { ok: false, error: 'server not found: ' + key }
    const servers = { ...current.servers }
    delete servers[key]
    serversCache = { servers }
    return await persistMcpServers()
  }
  /** 切换某 server 的启用/预热状态（只改 patch 里出现的键）；server 未登记 → fail loud。 */
  const setMcpServerState = async (name, patch) => {
    const key = String(name === undefined || name === null ? '' : name).trim()
    const current = await readMcpServers()
    const existing = current.servers[key]
    if (existing === undefined) return { ok: false, error: 'server not found: ' + key }
    const src = patch && typeof patch === 'object' ? patch : {}
    const next = { ...existing }
    if ('prewarm' in src) next.prewarm = src.prewarm === true
    if ('enabled' in src) next.enabled = src.enabled !== false
    if (typeof next.prewarm !== 'boolean') next.prewarm = false
    if (typeof next.enabled !== 'boolean') next.enabled = true
    serversCache = { servers: { ...current.servers, [key]: next } }
    return await persistMcpServers()
  }

  return {
    paths: resolveConfigPath(),
    readMcpPrefs,
    setMcpPrefs,
    readMcpServers,
    setMcpServer,
    deleteMcpServer,
    setMcpServerState,
    normalizeServerConfig,
  }
}
