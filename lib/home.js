// bgmcp —— 配置文件根目录解析（与 bgjobs 的 $DSH_HOME 口径一致）。
import os from 'node:os'
import path from 'node:path'

/** 返回 `$DSH_HOME`（默认 `~/.dsh`）。 */
export function resolveDshHome() {
  const home = process.env.DSH_HOME
  return home && home.trim() ? path.resolve(home.trim()) : path.join(os.homedir(), '.dsh')
}

/** 返回 MCP 控制面数据目录 `$DSH_HOME/mcp-hub`。 */
export function resolveMcpHubHome() {
  return path.join(resolveDshHome(), 'mcp-hub')
}
