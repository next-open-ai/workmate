import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createServer} from '../apps/renderer/node_modules/vite/dist/node/index.js';
const vite=await createServer({root:'apps/renderer',server:{middlewareMode:true,host:'127.0.0.1'},appType:'custom',logLevel:'silent'});
let model={},search={version:1,defaultProvider:'auto',providers:[]};
globalThis.window={workmateDesktop:{
  getSearchConfig:async()=>structuredClone(search),getModelConfig:async()=>structuredClone(model),
  saveModelConfig:async value=>{model=structuredClone(value);},
  saveSearchConfig:async value=>{search=structuredClone(value);},
}};
try{
  const {useModelConfig,createProviderInstance,applyRecommendedProviderSetup}=await vite.ssrLoadModule('/src/app/model-config.ts');
  const {useSearchConfig}=await vite.ssrLoadModule('/src/app/search-config.ts');
  const config=useModelConfig(),instance={...createProviderInstance('deepseek',[]),apiKey:'one-key'};
  const next=applyRecommendedProviderSetup({...config.settings.value,providerInstances:[instance]},instance,['general']).settings;
  await config.save(next);
  let ds=search.providers.find(item=>item.id==='deepseek');
  assert.equal(ds.providerInstanceId,instance.id);assert.equal(ds.apiKey,'');assert.equal(ds.enabled,true);
  assert.equal(useSearchConfig().runtimeProvidersFor('deepseek')[0].apiKey,'one-key');
  next.providerInstances[0].apiKey='rotated-key';await config.save(next);
  assert.equal(useSearchConfig().runtimeProvidersFor('deepseek')[0].apiKey,'rotated-key');
  assert.ok(!JSON.stringify(search).includes('rotated-key'));
  await config.save({...next,providerInstances:[],models:[]});
  assert.equal(useSearchConfig().runtimeProvidersFor('deepseek').length,0);
  // Execute the production IPC storage boundary, without Electron or user files.
  const main=fs.readFileSync('apps/desktop/src/main/index.cjs','utf8');
  const start=main.indexOf('function writeSearchConfig('),end=main.indexOf('\n/*',start);
  let persisted='',pushes=0;
  const context={safeStorage:{isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from('encrypted:'+value)},
    setStoredValue:(_key,value)=>{persisted=value;},pushSecretsToApi:()=>{pushes++;}};
  vm.createContext(context);vm.runInContext(main.slice(start,end)+'\nthis.write=writeSearchConfig;',context);
  context.write({version:1,defaultProvider:'deepseek',providers:[{...ds,apiKey:'must-not-duplicate'}]});
  assert.equal(JSON.parse(persisted).providers[0].providerInstanceId,instance.id);
  assert.equal(JSON.parse(persisted).providers[0].apiKey,'');assert.equal(pushes,1);
  assert.ok(!persisted.includes('must-not-duplicate'));
  const ui=fs.readFileSync('apps/renderer/src/features/settings/ProviderInstancesEditor.vue','utf8');
  assert.match(ui,/在线搜索也可用/);assert.match(ui,/text-\[11px\]/);
  console.log('DSS-T2/T3 PASS: real model save, linked search, rotation/removal, reference-only IPC persistence and Provider hint.');
}finally{await vite.close();delete globalThis.window;}
