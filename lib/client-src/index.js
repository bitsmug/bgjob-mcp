// bgmcp client —— bundle 入口：装配插件对象；被 esbuild 打包成
// window.__ModuleLoader__.load({ id:'bgjob-mcp', factory }) 形态的单文件 lib/client.js。

const { apply } = require('./apply.js')

module.exports = { name: 'bgjob-mcp-client', inject: ['slots'], apply }
