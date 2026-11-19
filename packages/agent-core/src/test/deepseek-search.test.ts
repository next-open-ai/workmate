import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebSearchTools} from '../search-runtime.js';
import {extractToolDetails} from '../pi-tools.js';
import {linkDeepSeekSearchSettings,resolveLinkedSearchSettings,stripLinkedSearchSecrets,SearchProviderIdSchema,ChatRequestSchema} from '@workmate/contracts';
const models={providerInstances:[{id:'ds',type:'deepseek',baseUrl:'https://api.deepseek.com/v1',apiKey:'test-key'}],
  models:[{id:'chat',providerInstanceId:'ds'}],activeChatModelId:'chat'};
test('DSS-T2: shared key references, deterministic choice, rotation, disable, deletion and custom gateway isolation',()=>{
  assert.equal(SearchProviderIdSchema.parse('deepseek'),'deepseek');
  assert.equal(ChatRequestSchema.parse({
    profile:{id:'g',name:'G',instructions:'',toolIds:[]},messages:[{role:'user',content:'搜索'}],
    model:{provider:'openai-compatible',chatModel:'test',apiKey:''},
    searchProviders:SearchProviderIdSchema.options.map(id=>({id,label:id,apiKey:'test',enabled:true})),
  }).searchProviders.length,7);
  const original={defaultProvider:'tavily',providers:[{id:'tavily',apiKey:'other-key',enabled:true}]};
  const linked=linkDeepSeekSearchSettings(original,models);
  const rows=linked.providers as Array<Record<string,unknown>>;
  assert.equal(rows.filter(row=>row.id==='deepseek').length,1);
  const row=rows.find(row=>row.id==='deepseek')!;
  assert.equal(row.providerInstanceId,'ds');assert.equal(row.apiKey,'');assert.equal(row.enabled,true);
  assert.equal(linked.defaultProvider,'tavily');
  assert.equal(JSON.stringify(linked).includes('test-key'),false);
  assert.deepEqual(linkDeepSeekSearchSettings(linked,models),linked);
  const rotated={...models,providerInstances:[{...models.providerInstances[0],apiKey:'rotated'}]};
  assert.equal((resolveLinkedSearchSettings(linked,rotated).providers as typeof rows).at(-1)!.apiKey,'rotated');
  assert.equal((resolveLinkedSearchSettings(linked,{providerInstances:[]}).providers as typeof rows).at(-1)!.apiKey,'');
  const disabled={...linked,providers:rows.map(row=>row.id==='deepseek'?{...row,enabled:false}:row)};
  assert.equal((linkDeepSeekSearchSettings(disabled,models).providers as typeof rows).at(-1)!.enabled,false);
  const hydrated=resolveLinkedSearchSettings(linked,models);
  assert.equal(JSON.stringify(stripLinkedSearchSecrets(hydrated)).includes('test-key'),false);
  assert.equal((linkDeepSeekSearchSettings({}, {...models,providerInstances:[{...models.providerInstances[0],baseUrl:'https://gateway.invalid/v1'}]}).providers as unknown[]).length,0);
  const multi={...models,providerInstances:[{...models.providerInstances[0],id:'first'},models.providerInstances[0]]};
  assert.equal((linkDeepSeekSearchSettings({},multi).providers as typeof rows)[0].providerInstanceId,'ds');
});
test('DSS-T1: actual tool uses official Search protocol and maps cited results; empty, error and invalid data stay distinct',async t=>{
  let request:{url:string;init?:RequestInit}|undefined;
  let code=200,body:unknown={results:[{title:'标题',url:'https://example.test/page',summary:'完整摘要',snippet:'短摘要',date:'2026-10-22',site_name:'来源'}]};
  t.mock.method(globalThis,'fetch',async(url:unknown,init?:RequestInit)=>{
    request={url:String(url),init};return new Response(JSON.stringify(body),{status:code});
  });
  const tool=createWebSearchTools([{id:'deepseek',label:'DeepSeek',apiKey:'never-log-key',enabled:true,preferred:true}])[0];
  const invoke=async(query='DeepSeek新闻',freshness?:string)=>extractToolDetails(await tool.execute('test',{query,count:3,freshness,provider:'deepseek'})) as {ok:boolean;error?:string;results?:Array<Record<string,unknown>>;sources?:unknown[]};
  let result=await invoke();
  assert.equal(result.ok,true);assert.equal(request!.url,'https://api.deepseek.com/v1/tools/search');
  assert.equal(new Headers(request!.init?.headers).get('authorization'),'Bearer never-log-key');
  assert.deepEqual(JSON.parse(String(request!.init?.body)),{query:'DeepSeek新闻',count:3,need_content:false});
  assert.equal(result.results![0].snippet,'完整摘要');assert.equal(result.results![0].source,'来源');
  assert.equal(result.sources!.length,1);
  await invoke('新闻','oneWeek');assert.match(JSON.parse(String(request!.init?.body)).query,/after:\d{4}-\d{2}-\d{2}$/);
  await invoke('新闻 after:2026-01-01','oneDay');assert.equal(JSON.parse(String(request!.init?.body)).query,'新闻 after:2026-01-01');
  body={results:[]};assert.deepEqual((await invoke()).results,[]);
  body={wrong:[]};assert.match((await invoke()).error!,/格式无效/);
  for(code of [401,402,429,500]){result=await invoke();assert.equal(result.ok,false);assert.match(result.error!,new RegExp(String(code)));assert.ok(!JSON.stringify(result).includes('never-log-key'));}
  code=200;body={results:[]};
  assert.equal((await invoke('😀'.repeat(128))).ok,true);
  const prior=request;
  assert.equal((await invoke('😀'.repeat(129))).ok,false);assert.equal(request,prior);
});
