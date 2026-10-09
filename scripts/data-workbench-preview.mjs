// Isolated browser fixture: real Vue components, in-memory synthetic data only.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
const vueRequire = createRequire(fs.realpathSync('apps/renderer/node_modules/vue/package.json'));
const viteRequire = createRequire(fs.realpathSync('apps/renderer/node_modules/vite/package.json'));
const { parse, compileScript, compileStyle } = vueRequire('@vue/compiler-sfc');
const { build } = viteRequire('esbuild');
const bundle = await build({
  bundle: true, write: false, platform: 'browser', format: 'esm',
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
  stdin: { loader: 'js', resolveDir: process.cwd(), contents: `import {createApp} from 'vue'; import Page from './apps/renderer/src/features/data/DataWorkbenchPage.vue'; createApp(Page,{onStartCustomize:()=>console.info('FIXTURE: received one customize event; no model called')}).mount('#app');` },
  plugins: [{ name: 'data-object-fixture', setup(builder) {
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: vueRequire.resolve('vue/dist/vue.esm-bundler.js') }));
    builder.onResolve({ filter: /^@workmate\/contracts$/ }, () => ({ path: path.resolve('packages/contracts/dist/index.js') }));
    builder.onLoad({ filter: /\.vue$/ }, args => {
      const { descriptor } = parse(fs.readFileSync(args.path, 'utf8'), { filename: args.path });
      const id = createHash('sha256').update(args.path).digest('hex').slice(0, 8);
      const scoped = descriptor.styles.some(block => block.scoped);
      const style = descriptor.styles.map(block => compileStyle({ source: block.content, filename: args.path, id: `data-v-${id}`, scoped: block.scoped }).code).join('\n');
      const styleScript = style ? `\n{ const style = document.createElement('style'); style.textContent = ${JSON.stringify(style)}; document.head.appendChild(style); }` : '';
      const script = compileScript(descriptor, { id, inlineTemplate: true, genDefaultAs: '__fixtureComponent', templateOptions: { scoped } }).content;
      return { contents: script + (scoped ? `\n__fixtureComponent.__scopeId = 'data-v-${id}';` : '') + '\nexport default __fixtureComponent;' + styleScript, loader: 'ts', resolveDir: path.dirname(args.path) };
    });
  } }],
});
const source = {
  id: 'demo-orders', name: '订单业务接口（模拟数据）', fileType: 'API', assetId: '',
  tableCount: 1, rowCount: 2, createdAt: Date.now(), summary: '仅供界面验收，不访问外部接口。',
  annotations: { description: '用于分析已支付订单的销售额，不含退款金额。', connectionDescription: '电商业务系统；每天显式同步一次。此处为模拟数据。', apiUrlDescription: '订单列表查询接口，支持按日期分页。', apiFields: [{ path: 'page', location: 'query', type: 'integer', required: false, description: '页码，从 1 开始' }, { path: 'data.items[].amount', location: 'response', type: 'number', required: true, description: '实付金额，人民币元' }] },
  tables: [{ id: 'demo-table', name: '订单明细', sheetName: 'records', rowCount: 2, description: '每行代表一个已支付订单。', columns: [{ id: 'c_1', sourceName: 'id', name: '订单编号', type: '文本', nullable: false, sample: 'DEMO-001', description: '唯一订单标识' }, { id: 'c_2', sourceName: 'amount', name: '实付金额', type: '小数', nullable: false, sample: '128.50', description: '优惠后的实付金额，不含退款', unit: '元' }] }],
  api: { baseUrl: 'https://example.invalid', path: '/orders', method: 'GET', authType: 'none', authHeaderName: '', hasToken: false, headers: {}, itemsPath: 'data.items', description: '订单业务接口', requestBody: '', responseBody: '', lastSyncedAt: Date.now(), lastStatus: 'ok', lastError: '' },
};
const cssDir = 'apps/renderer/dist/assets';
const cssFile = fs.readdirSync(cssDir).find(name => name.endsWith('.css') && name.startsWith('index-'));
const css = fs.readFileSync(path.join(cssDir, cssFile), 'utf8');
const apps = [
  { id: 'pending-demo', name: '订单查询应用（待交付示例）', appType: '查询网站', delivery: { mode: 'custom', status: 'awaiting-binding' }, customSite: { bound: false }, publishUrl: 'http://127.0.0.1:47849/pending-demo' },
  { id: 'ready-demo', name: '销售看板（可用示例）', appType: '数据看板', delivery: { mode: 'custom', status: 'custom-ready' }, customSite: { bound: true }, publishUrl: 'http://127.0.0.1:47849/ready-demo' },
];
let failCreate = process.env.WORKMATE_DATA_PREVIEW_FAILURE === 'create-and-refresh';
let failRefresh = false;
let creations = 0;
// Second table makes table choice observable without touching business data.
source.tables.push({ ...source.tables[0], id: 'demo-customers', name: '客户信息', rowCount: 1 });
source.tableCount = 2;
const server = createServer(async (request, reply) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const json = value => { reply.setHeader('content-type', 'application/json'); reply.end(JSON.stringify(value)); };
  if (url.pathname.startsWith('/api/')) {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = body ? JSON.parse(body) : {};
    if (url.pathname === '/api/data/databases/inspect') return json({ databases: ['business_demo'], tables: payload.database ? [{ schema: payload.engine === 'mysql' ? 'business_demo' : 'public', name: 'orders', description: '已支付订单，用于统计销售金额（模拟）' }, { schema: payload.engine === 'mysql' ? 'business_demo' : 'public', name: 'customers', description: '客户基础信息（模拟）' }] : [] });
    if (url.pathname === '/api/data/sources/database') {
      source.fileType = payload.connection.engine === 'mysql' ? 'MySQL' : 'PostgreSQL'; source.name = payload.name;
      const { password: _password, ...connection } = payload.connection;
      source.databaseConnection = { ...connection, tables: payload.tables, lastSyncedAt: Date.now(), truncatedTables: [] };
      delete source.api; source.annotations.apiFields = []; source.annotations.apiUrlDescription = '';
      return json(source);
    }
    if (request.method === 'PATCH' && url.pathname.endsWith('/annotations')) { source.annotations = payload; return json(source); }
    if (request.method === 'PATCH' && url.pathname.endsWith('/schema')) { source.tables[0] = { ...source.tables[0], ...payload }; return json(source); }
    if (url.pathname === '/api/data/sources') return json([source]);
    if (url.pathname === '/api/data/gateway/schema') return json({ id: source.id, name: source.name, kind: source.fileType, annotations: source.annotations, resources: source.tables.map(({ rowCount: _count, ...table }) => ({ ...table, columns: table.columns.map(({ sample: _sample, ...column }) => column) })), operations: ['query', 'options'] });
    if (url.pathname.endsWith('/rows')) return json({ columns: source.tables[0].columns.map(column => column.name), rows: [['DEMO-001', '128.50'], ['DEMO-002', '86.00']] });
    if (url.pathname === '/api/data/apps/customize') {
      if (failCreate) { failCreate = false; reply.statusCode = 503; return json({ message: '模拟创建失败，请重试；输入内容应保留。' }); }
      const app = { ...apps[0], id: `created-demo-${++creations}`, name: payload.name, appType: payload.appType };
      apps.push(app); failRefresh = process.env.WORKMATE_DATA_PREVIEW_FAILURE === 'create-and-refresh';
      console.log(`FIXTURE: creation ${creations}, table ${payload.tableId}`);
      return json({ app, publishUrl: app.publishUrl, prompt: '合成验收提示，不调用模型。', token: 'synthetic' });
    }
    if (url.pathname === '/api/data/apps') {
      if (failRefresh) { failRefresh = false; reply.statusCode = 503; return json({ message: '模拟列表刷新失败' }); }
      return json(apps);
    }
    if (url.pathname === `/api/data/sources/${source.id}`) return json(source);
    reply.statusCode = 400; return json({ message: '模拟页面不执行此操作；请在真实应用中使用。' });
  }
  if (url.pathname === '/bundle.js') { reply.setHeader('content-type', 'text/javascript'); reply.end(bundle.outputFiles[0].text); }
  else if (url.pathname === '/style.css') { reply.setHeader('content-type', 'text/css'); reply.end(css); }
  else { reply.setHeader('content-type', 'text/html'); reply.end('<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Workmate 数据对象界面验收（模拟）</title><link rel="stylesheet" href="/style.css"><style>html,body,#app{height:100dvh;margin:0}</style><body><div id="app"></div><script type="module" src="/bundle.js"></script></body></html>'); }
});
server.listen(47849, '127.0.0.1', () => console.log('Isolated data fixture: http://127.0.0.1:47849'));
process.on('SIGINT', () => server.close(() => process.exit(0)));
