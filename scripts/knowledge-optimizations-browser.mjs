// Isolated real Vue components + protocol fixtures. No user API or model service.
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const renderer = path.join(root, 'apps/renderer');
const requireRenderer = createRequire(path.join(renderer, 'package.json'));
const { createServer } = await import(pathToFileURL(requireRenderer.resolve('vite')).href);
const { default: vue } = await import(pathToFileURL(requireRenderer.resolve('@vitejs/plugin-vue')).href);
const { default: tailwind } = await import(pathToFileURL(requireRenderer.resolve('@tailwindcss/vite')).href);
const { chromium } = await import(process.env.TEST_PLAYWRIGHT_MODULE || 'playwright-core');
const entry = `import { createApp, h, ref } from 'vue';
import Progress from '/src/features/knowledge/WikiGenerationProgress.vue';
import Merge from '/src/features/knowledge/WikiMergePanel.vue';
import Report from '/src/features/knowledge/RetrievalEvaluationPanel.vue';
import '/src/styles/main.css';
const now = new Date().toISOString();
createApp({ setup(){const saved=ref('');return ()=>h('main',{style:'max-width:1100px;margin:24px auto;padding:16px;display:grid;gap:24px'},[
 h(Progress,{job:{jobId:'test-job',state:'failed',processedChunks:100,totalChunks:101,pageIds:[],createdAt:now,updatedAt:now,errorCode:'MODEL_TIMEOUT',progress:{phase:'generate',batchIndex:2,batchCount:2}},label:'生成未完成',cancelling:false,stalled:false}),
 h(Merge,{kb:'kb',sourcePageId:'source',disabled:false,onSaved:id=>saved.value=id}),h('p',{'data-testid':'saved'},saved.value),
 h(Report,{knowledgeBaseId:'kb',query:'如何报销',ready:true,hits:[{id:'c1',title:'差旅制度'}]})
]);}}).mount('#app');`;
const server = await createServer({ configFile: false, root: renderer, plugins: [vue(), tailwind(), {
  name: 'isolated-wiki-components',
  resolveId(id) { if (id === '/__wiki-sync-test.js') return '\0wiki-sync-test'; },
  load(id) { if (id === '\0wiki-sync-test') return entry; },
  configureServer(s) { s.middlewares.use((req, res, next) => {
    if (req.url !== '/__wiki-sync-test') return next();
    res.setHeader('Content-Type', 'text/html'); res.end('<html lang="zh-CN"><meta charset="UTF-8"><title>Wiki regression</title><div id="app"></div><script type="module" src="/__wiki-sync-test.js"></script></html>');
  }); },
}], resolve: { alias: { vue: requireRenderer.resolve('vue/dist/vue.esm-bundler.js') } }, server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  const errors = [], requests = [];
  page.on('pageerror', e => { errors.push(e.message); console.error('Browser error:', e.message); });
  page.on('console', e => { if(e.type() === 'error') console.error('Browser console:', e.text()); });
  const content = { title: '差旅制度', bodyMarkdown: '已有条款\n\n新增条款', sections: [
    { sectionId: 's1', headingPath: ['原条款'], start: 0, end: 4 }, { sectionId: 's2', headingPath: ['新条款'], start: 6, end: 10 }], evidenceRefs: [], links: [] };
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url()); requests.push(url.pathname);
    if (url.pathname.endsWith('/merge-candidates')) return route.fulfill({ json: { items: [{ pageId: 'target', title: '差旅制度' }] } });
    if (url.pathname.endsWith('/merge-preview')) return route.fulfill({ json: { content, targetBody: '已有条款', addedSections: 1, skippedSections: 0,
      targetPageId: 'target', sourceRevisionId: 'r1', targetRevisionId: 'r2', sourceGeneration: 1, baseGeneration: 2, previewHash: 'a'.repeat(64) } });
    if (url.pathname.endsWith('/merge')) {
      const body = route.request().postDataJSON(); assert.equal(body.baseGeneration, 2); assert.ok(body.idempotencyKey); assert.equal(body.content, undefined);
      return route.fulfill({ json: { pageId: 'target' } });
    }
    return route.abort();
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__wiki-sync-test`);
  await page.getByText('停止阶段：整理资料 · 第 2/2 批', { exact: true }).waitFor();
  assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'), '99');
  assert.equal(await page.locator('.generation-details').getAttribute('open'), null);
  await page.getByRole('button', { name: '预览合并：差旅制度', exact: true }).click();
  await page.getByText('新增条款', { exact: true }).first().waitFor();
  assert.equal(await page.locator('details').filter({ has: page.locator('summary').getByText('合并后的完整预览', { exact: true }) }).getAttribute('open'), null);
  await page.getByRole('button', { name: '保存为更新草稿', exact: true }).click();
  await page.getByTestId('saved').filter({ hasText: 'target' }).waitFor();
  const networkBeforeReport = requests.length;
  const report = page.getByRole('region', { name: '离线评测报告', exact: true });
  const downloaded = page.waitForEvent('download');
  await report.getByRole('button', { name: '导出当前召回快照' }).click();
  const stream = await (await downloaded).createReadStream(), chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const data = JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(data.cases[0].relevantGroups, null);
  const upload = value => report.getByLabel('选择标注文件并生成报告', { exact: true }).setInputFiles({name:'test.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(value))});
  await upload(data); await report.getByRole('alert').filter({hasText:'未标注'}).waitFor();
  data.snapshot = '合成快照-v1'; data.cases[0].relevantGroups = [['chunk:c1']]; data.cases[0].runs[0].variant = '基线';
  await upload(data); await report.getByRole('heading', {name:'评测报告 · Top 6 · 1 题'}).waitFor();
  const html = page.waitForEvent('download'); await report.getByRole('button', { name: '下载 HTML 报告' }).click();
  assert.equal((await html).suggestedFilename(), 'retrieval-evaluation.html');
  assert.equal(requests.length, networkBeforeReport, 'report must not access query/API');
  if(process.env.TEST_SCREENSHOT) await page.screenshot({path:process.env.TEST_SCREENSHOT,fullPage:true});
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), JSON.stringify(await page.evaluate(() => ({width:innerWidth,scroll:document.documentElement.scrollWidth}))));
  assert.deepEqual(errors, []);
  console.log('KH-T5/T7/T8 browser PASS: stage, preview/save, offline import/export, zero report API, narrow layout. Protocol fixtures; not real-model E2E.');
} finally { await browser?.close(); await server.close(); }
