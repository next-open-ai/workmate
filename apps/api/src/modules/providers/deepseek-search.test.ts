import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {settingsRoutes} from '../settings/routes.js';
import {applyParentSecrets,getSecrets} from '../orchestration/secrets.js';

test('DSS-T2/T3: model save creates linked search without duplicate secret, rotates and resolves keyring',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workmate-dss-'));
  const previous=process.env.WORKMATE_DATA_DIR;process.env.WORKMATE_DATA_DIR=root;
  const app=Fastify();await app.register(settingsRoutes);
  const model={version:3,providerInstances:[{id:'ds',type:'deepseek',name:'DS',baseUrl:'https://api.deepseek.com/v1',apiKey:'shared-one'}],
    models:[{id:'chat',providerInstanceId:'ds',capability:'chat',modelId:'deepseek-chat'}],activeChatModelId:'chat'};
  try{
    await app.inject({method:'PUT',url:'/settings/search',payload:{version:1,defaultProvider:'brave',providers:[{id:'brave',label:'Brave',apiKey:'brave-key',enabled:true}]}});
    const put=()=>app.inject({method:'PUT',url:'/settings/model',payload:model});
    assert.equal((await put()).statusCode,200);
    let search=(await app.inject({url:'/settings/search'})).json();
    let ds=search.providers.find((item:{id:string})=>item.id==='deepseek');
    assert.equal(ds.providerInstanceId,'ds');assert.equal(ds.apiKey,'shared-one');assert.equal(ds.enabled,true);
    assert.equal(search.defaultProvider,'brave');
    const file=path.join(root,'search-settings.json');
    assert.ok(!fs.readFileSync(file,'utf8').includes('shared-one'));
    model.providerInstances[0].apiKey='shared-two';await put();
    search=(await app.inject({url:'/settings/search'})).json();
    ds=search.providers.find((item:{id:string})=>item.id==='deepseek');
    assert.equal(ds.apiKey,'shared-two');assert.equal(search.providers.filter((item:{id:string})=>item.id==='deepseek').length,1);
    await app.inject({method:'PUT',url:'/settings/search',payload:search});
    assert.ok(!fs.readFileSync(file,'utf8').includes('shared-two'));
    applyParentSecrets({model,search:JSON.parse(fs.readFileSync(file,'utf8')).meta});
    const runtime=getSecrets().search as {providers:Array<{id:string;apiKey:string}>};
    assert.equal(runtime.providers.find(item=>item.id==='deepseek')!.apiKey,'shared-two');
    model.providerInstances=[];await put();
    search=(await app.inject({url:'/settings/search'})).json();
    assert.equal(search.providers.find((item:{id:string})=>item.id==='deepseek').apiKey,'');
  }finally{
    applyParentSecrets({});await app.close();
    if(previous===undefined)delete process.env.WORKMATE_DATA_DIR;else process.env.WORKMATE_DATA_DIR=previous;
    fs.rmSync(root,{recursive:true,force:true});
  }
});
