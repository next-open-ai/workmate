// Exercise the actual Vue setup handlers with in-memory service adapters.
// No browser, user database or model credentials are required.
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(new URL('../apps/renderer/package.json', import.meta.url));
const vue = require('vue');
const vueRequire = createRequire(realpathSync(require.resolve('vue/package.json')));
const { parse, compileScript } = vueRequire('@vue/compiler-sfc');
const ts = require('typescript');
function setup(file, services = {}, props = {}) {
  const { descriptor } = parse(readFileSync(new URL(`../apps/renderer/src/features/data/${file}`, import.meta.url), 'utf8'));
  const code = ts.transpileModule(compileScript(descriptor, { id: 'create-regression' }).content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  const mounted = [], unmounted = [];
  const importer = id => {
    if (id === 'vue') return { ...vue, onMounted: fn => mounted.push(fn), onUnmounted: fn => unmounted.push(fn) };
    if (id === '../../services/api') return services;
    if (id === './workbench-presentation') return { appPresentation: () => ({ canShare: false }) };
    if (id === '@workmate/contracts') return { dataObjectAnnotationsSchema: { parse: () => ({ description: '' }) } };
    return {};
  };
  vm.runInNewContext(code, { exports, require: importer, Error, window: { navigator: {} }, document: { activeElement: null } });
  const events = [];
  const state = exports.default.setup(props, { expose: () => {}, emit: (...args) => events.push(args) });
  return { state, events, mount: async () => { for (const fn of mounted) await fn(); }, unmount: () => { for (const fn of unmounted) fn(); } };
}
const source = { id: 'source', name: '合成订单', tables: [{ id: 'orders', name: '订单' }, { id: 'customers', name: '客户' }] };
const draft = { mode: 'idea', tableId: 'customers', appType: '查询网站', name: '客户应用', idea: '搜索客户' };
let creates = 0;
const app = { id: 'app', name: '客户应用' };
const page = setup('DataWorkbenchPage.vue', {
  customizeDataApp: async input => { creates++; assert.equal(input.tableId, 'customers'); return { app, prompt: 'synthetic prompt' }; },
  listDataApps: async () => { throw new Error('refresh failed'); },
});
page.state.selected.value = source; page.state.createOpen.value = true;
await page.state.submitCreate(draft);
assert.equal(creates, 1);
assert.equal(page.state.createOpen.value, false);
assert.equal(page.state.createError.value, '');
assert.match(page.state.error.value, /已创建.*刷新失败/);
assert.equal(page.state.sourceApps.value[0].id, 'app');
assert.equal(page.state.activeApp.value, null);
assert.equal(page.events.filter(([name]) => name === 'startCustomize').length, 1);
const failed = setup('DataWorkbenchPage.vue', { customizeDataApp: async () => { throw new Error('create failed'); } });
failed.state.selected.value = source; failed.state.createOpen.value = true;
await failed.state.submitCreate(draft);
assert.equal(failed.state.createOpen.value, true);
assert.match(failed.state.createError.value, /create failed/);
assert.equal(failed.state.createBusy.value, false);
assert.equal(failed.events.length, 0);
failed.state.createBusy.value = true;
await failed.state.submitCreate(draft);
assert.equal(failed.events.length, 0);
const template = setup('DataWorkbenchPage.vue', { createDataApp: async () => app, listDataApps: async () => { throw new Error('refresh failed'); } });
template.state.selected.value = source; template.state.createOpen.value = true;
await template.state.submitCreate({ ...draft, mode: 'template', idea: '' });
assert.equal(template.state.activeApp.value.id, 'app');
assert.equal(template.state.createOpen.value, false);
const dialog = setup('DataAppCreateDialog.vue', {}, { source, tableId: 'customers', busy: false, error: '' });
assert.equal(dialog.state.canSubmit.value, false);
dialog.state.draft.value.idea = '   搜索客户   ';
dialog.state.submit();
assert.equal(dialog.events[0][1].tableId, 'customers');
assert.equal(dialog.events[0][1].name, '客户应用');
assert.equal(dialog.events[0][1].idea, '搜索客户');
dialog.state.draft.value.mode = 'template'; dialog.state.draft.value.idea = '';
assert.equal(dialog.state.canSubmit.value, true);
dialog.state.draft.value.tableId = 'missing';
assert.equal(dialog.state.canSubmit.value, false);
console.log('DAC-R7 PASS: actual Vue creation handlers, selected table, defaults, validation, failure preservation, duplicate guard and post-success refresh failures.');

const navigation = { sourceId: 'source', tableId: 'customers', tab: 'apps', category: 'files', query: '订单' };
let delivery = 'awaiting-binding';
const navigationServices = {
  listDataSources: async () => [source], getDataSource: async () => source,
  listDataApps: async () => [{ id: 'app', delivery: { state: delivery } }],
  getDataTableRows: async (_, tableId) => ({ columns: ['id'], rows: [[tableId]] }),
};
const original = setup('DataWorkbenchPage.vue', navigationServices, { navigation, navigationScope: 'org:user' });
await original.mount();
assert.equal(original.state.selectedTable.value.id, 'customers');
assert.equal(original.state.objectTab.value, 'apps');
assert.equal(original.state.sourceQuery.value, '订单');
assert.equal(original.state.activeCategory.value, 'files');
original.unmount();
const snapshot = original.events.find(([name]) => name === 'rememberNavigation');
assert.deepEqual(JSON.parse(JSON.stringify(snapshot[1])), navigation);
assert.equal(snapshot[2], 'org:user');
delivery = 'custom-ready';
const returned = setup('DataWorkbenchPage.vue', navigationServices, { navigation: snapshot[1] });
await returned.mount();
assert.equal(returned.state.sourceApps.value[0].delivery.state, 'custom-ready');
await returned.state.load();
assert.equal(returned.state.selectedTable.value.id, 'customers');
assert.equal(returned.state.objectTab.value, 'apps');
const removed = setup('DataWorkbenchPage.vue', { listDataSources: async () => [] }, { navigation });
await removed.mount(); removed.unmount();
assert.equal(removed.state.selected.value, null);
assert.match(removed.state.notice.value, /不存在/);
assert.equal(removed.events[0][1].sourceId, null);
const tableRemoved = setup('DataWorkbenchPage.vue', { ...navigationServices, getDataSource: async () => ({ ...source, tables: [source.tables[0]] }) }, { navigation });
await tableRemoved.mount();
assert.equal(tableRemoved.state.selectedTable.value.id, 'orders');
let failRead = true;
const retryServices = { ...navigationServices, getDataSource: async () => { if (failRead) throw new Error('offline'); return source; } };
const offline = setup('DataWorkbenchPage.vue', retryServices, { navigation });
await offline.mount(); offline.unmount();
assert.match(offline.state.error.value, /offline/);
assert.equal(offline.events[0][1].sourceId, 'source');
failRead = false;
const retried = setup('DataWorkbenchPage.vue', retryServices, { navigation: offline.events[0][1] });
await retried.mount(); assert.equal(retried.state.selectedTable.value.id, 'customers');
let finish;
const waiting = setup('DataWorkbenchPage.vue', { listDataSources: () => new Promise(resolve => { finish = resolve; }) }, { navigation });
const waitingLoad = waiting.mount(); waiting.unmount(); finish([source]); await waitingLoad;
assert.equal(waiting.state.sources.value.length, 0);
let finishOld;
const stale = setup('DataWorkbenchPage.vue', { ...navigationServices, getDataSource: () => new Promise(resolve => { finishOld = resolve; }) });
const oldRead = stale.state.chooseSource('source'); stale.state.showCatalog(); finishOld(source); await oldRead;
assert.equal(stale.state.selected.value, null);
const memoryExports = {};
const memoryCode = ts.transpileModule(readFileSync(new URL('../apps/renderer/src/features/data/workbench-navigation.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
vm.runInNewContext(memoryCode, { exports: memoryExports, require: () => vue });
const scope = vue.ref('org:user');
const effect = vue.effectScope();
const memory = effect.run(() => memoryExports.useWorkbenchNavigation(scope));
memory.remember(navigation, 'org:user'); assert.equal(memory.navigation.value.sourceId, 'source');
scope.value = ''; assert.equal(memory.navigation.value, undefined);
memory.remember(navigation, 'org:user'); assert.equal(memory.navigation.value, undefined);
scope.value = 'org:other'; memory.remember(navigation, 'org:user'); assert.equal(memory.navigation.value, undefined);
memory.remember(navigation, 'org:other'); assert.equal(memory.navigation.value.sourceId, 'source'); effect.stop();
console.log('DAC-R8 PASS: remount retrieves latest delivery, table/tab/search restoration, missing objects/tables, retry, stale/unmounted requests and account isolation.');
