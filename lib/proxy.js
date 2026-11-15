// bgmcp —— MCP 预热回环代理（127.0.0.1 + 随机 token）。
// 与 pool.js 分离：这里只管 HTTP 传输与鉴权，连接池由 pool.js 提供 listTools / call。
// /call 失败响应带 `attempted`：true 表示"请求已发给 server（可能已执行）"，runner 不得重跑。

import http from 'node:http'

const PROXY_BODY_LIMIT = 1024 * 1024

const errMsg = (e) => (e && e.message ? String(e.message) : String(e))

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > PROXY_BODY_LIMIT) { reject(new Error('request body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 创建回环代理。deps:
 *   - token: string                 鉴权 token（随任务 mcp.json 下发）
 *   - listTools: (server) => Promise<tools>
 *   - call: (server, tool, args, timeoutMs) => Promise<result>
 * 返回 { init, endpoint, dispose }。
 */
export function createProxy(deps) {
  const { token } = deps
  let httpServer = null
  let port = 0
  let disposed = false

  function startProxy() {
    httpServer = http.createServer(async (req, res) => {
      // 客户端（runner）可能在中止预算到点后断连，之后我们再写响应会报错 → 兜住 error，写前再检查可写。
      res.on('error', () => { /* 客户端已断开，忽略 */ })
      const respond = (code, body) => {
        if (res.writableEnded || res.destroyed) return
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(body))
      }
      try {
        if (req.method !== 'POST') { respond(404, { ok: false, error: 'not found' }); return }
        const pathname = String(req.url || '')
        if (pathname !== '/call' && pathname !== '/tools') { respond(404, { ok: false, error: 'not found' }); return }
        if (String(req.headers['x-bgjobs-token'] || '') !== token) { respond(401, { ok: false, error: 'unauthorized' }); return }
        const text = await readBody(req)
        let body
        try { body = JSON.parse(text) } catch (e) { respond(400, { ok: false, error: 'invalid json' }); return }
        const server = body && body.server !== undefined ? String(body.server) : ''
        if (server.length === 0) { respond(400, { ok: false, error: 'missing server' }); return }
        if (pathname === '/tools') {
          respond(200, { ok: true, tools: await deps.listTools(server) })
          return
        }
        const result = await deps.call(server, body.tool, body.arguments, body.timeoutMs)
        respond(200, { ok: true, result })
      } catch (e) {
        // attempted=true：调用已经发给 server（可能已执行）→ 调用方不得重跑，只按退出码收尾。
        respond(200, { ok: false, error: errMsg(e), attempted: e && e.attempted === true })
      }
    })
    return new Promise((resolve) => {
      httpServer.on('error', () => resolve(false))
      httpServer.listen(0, '127.0.0.1', () => {
        const addr = httpServer.address()
        port = addr && typeof addr === 'object' ? addr.port : 0
        // unref：代理只是加速通道，不因它单独存活而拖住宿主进程退出（DSH 自然常驻）。
        if (typeof httpServer.unref === 'function') httpServer.unref()
        resolve(port !== 0)
      })
    })
  }

  /** 启动监听；返回 { ok, port }。 */
  async function init() {
    const ok = await startProxy()
    if (!ok) { port = 0; return { ok: false, port: 0 } }
    return { ok: true, port }
  }

  /** 当前代理端点（仅预热可用时返回；写进任务 mcp.json）。 */
  function endpoint() {
    if (disposed || httpServer === null || port === 0) return null
    return { url: 'http://127.0.0.1:' + String(port) + '/call', token }
  }

  /** 关闭监听（幂等）。 */
  async function dispose() {
    disposed = true
    if (httpServer !== null) {
      const s = httpServer
      httpServer = null
      await new Promise((resolve) => { try { s.close(() => resolve()) } catch { resolve() } })
    }
  }

  return { init, endpoint, dispose }
}
