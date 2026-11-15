// bgmcp client —— bundle 入口：装配插件对象；被 esbuild 打包成
// window.__ModuleLoader__.load({ id:'bgmcp', factory }) 形态的单文件 lib/client.js。

const { apply } = require('./apply.js')

module.exports = { name: 'bgmcp-client', inject: ['slots'], apply }
