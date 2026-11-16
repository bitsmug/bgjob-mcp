// bgmcp client —— apply assembly。
// 与 bgjobs 的设置页解耦：只注册「MCP 任务」一个 settings.section。
const h = require('react').createElement
const { makeT, NS, ZH, EN } = require('./i18n.js')
const { McpSettings } = require('./mcp-section.js')

function apply(ctx) {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  let locale = undefined
  try { locale = ctx.get('locale') } catch (e) { /* 服务不可用 */ }
  if (locale && typeof locale.register === 'function') {
    ctx.effect(() => locale.register(NS, { zh: ZH, en: EN }), 'bgjob-mcp: dictionaries')
  }
  const bindNavT = () => {
    if (locale && typeof locale.bind === 'function') {
      try { return locale.bind(NS) } catch (e) { /* 回退 zh */ }
    }
    return makeT('zh')
  }
  const mcpEntry = { name: 'settings.section', id: 'mcp-control', order: 31, label: () => bindNavT()('settings.mcp.nav') }
  if (locale) mcpEntry.locale = NS
  slots.inject('settings.section', () => slots.register(mcpEntry, (props) => h(McpSettings, {
    t: (props && props.t) || makeT('zh'),
  })))
}

module.exports = { apply }
