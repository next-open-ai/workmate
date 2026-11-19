import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {ingestKnowledge,identifyKnowledgeVersion,searchKnowledgeBase,validateWikiGeneration,deleteKnowledgeDocument} from '@workmate/agent-core';
import {InMemoryExecutionDispatcher,MemoryStore} from '@workmate/orchestrator';
import {registerSourceIngest} from './source-ingest.js';
import {registerWikiRoutes} from './wiki-routes.js';
import {registerWikiGenerationRoutes} from './wiki-generation-routes.js';
import {KnowledgeCatalog} from './catalog.js';
import {authorizeRunKnowledge,registerKnowledgeAccessGuard} from './access.js';
import {createKnowledgeRunner} from './runner.js';
import {ChatRequestSchema} from '@workmate/contracts';

test('KH-T1..T4: archived import → keyword/vector → Wiki draft/publish → unified recall; identity and deletion remain live',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workmate-hybrid-api-'));
  const directory=path.join(root,'kb');
  const config=[{id:'kb',name:'差旅制度',provider:'lancedb',enabled:true,dataDir:directory,
    ontologyEnabled:false,wikiRetrievalEnabled:true,embeddingBaseUrl:'https://embedding.test/v1',embeddingApiKey:'test',embeddingModel:'test'}];
  const save=()=>fs.writeFileSync(path.join(root,'knowledge-bases.json'),JSON.stringify({meta:config}));
  save();
  t.mock.method(globalThis,'fetch',async(_url:unknown,init?:RequestInit)=>{
    const input=JSON.parse(String(init?.body)).input;
    return new Response(JSON.stringify({data:input.map((_:string,index:number)=>({index,embedding:[1,0]}))}),{status:200});
  });
  const app=Fastify();
  app.addHook('preHandler',async request=>{
    const user=request.headers['x-user'];
    if(typeof user==='string')request.auth={userId:user,orgId:'org',username:user,displayName:user,role:'member',sessionId:'test'};
  });
  registerSourceIngest(app,{dataRoot:()=>root,ingest:ingestKnowledge,identifyVersion:identifyKnowledgeVersion});
  registerWikiRoutes(app,{dataRoot:()=>root});
  app.register(async child=>{
    registerKnowledgeAccessGuard(child,()=>root);
    child.post('/trusted',async request=>request.body);
  });
  let calls=0;
  registerWikiGenerationRoutes(app,{dataRoot:()=>root,dispatcher:()=>new InMemoryExecutionDispatcher(),
    generate:async input=>{
      calls++;
      return validateWikiGeneration({pages:[{key:'travel',title:'差旅报销',aliases:['发票报销'],summary:'差旅报销要求',
        sections:[{heading:'发票',body:'差旅报销需要提交发票。',chunkIds:input.batches.flatMap(b=>b.chunks.map(c=>c.evidence.chunkId)),relatedKeys:[]}]}]},input);
    }});
  t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
  const headers={'x-user':'alice'};
  const upload=await app.inject({method:'POST',url:'/knowledge/ingest',headers,payload:{
    knowledgeBase:{id:'kb',name:'forged',provider:'lancedb',dataDir:'/not-allowed'},
    title:'差旅制度',content:'差旅报销需要提交发票。'}});
  assert.equal(upload.statusCode,200,upload.body);
  const imported=upload.json();
  assert.ok(imported.sourceSnapshot);
  const version=imported.sourceSnapshot.documentVersionId;
  const download=await app.inject({method:'GET',url:'/knowledge/sources/'+version,headers});
  assert.equal(download.statusCode,200);assert.equal(download.body,'差旅报销需要提交发票。');
  assert.equal((await app.inject({method:'GET',url:'/knowledge/sources/'+version,headers:{'x-user':'bob'}})).statusCode,404);
  assert.equal((await app.inject({method:'GET',url:'/knowledge/kb/wiki/pages'})).statusCode,401);
  const catalog=new KnowledgeCatalog(root);
  const kb=catalog.resolve({orgId:'org',userId:'alice'},'kb');
  assert.equal(kb.dataDir,directory);
  const raw=await searchKnowledgeBase(kb,'发票',8);
  assert.ok(raw.some(hit=>hit.retrieval?.channels.includes('keyword')));
  assert.ok(raw.some(hit=>hit.retrieval?.channels.includes('vector')));
  const authorized=authorizeRunKnowledge(ChatRequestSchema.parse({model:{provider:'openai-compatible',apiKey:'',chatModel:'test'},
    profile:{id:'general',name:'General',instructions:'',toolIds:[]},messages:[{role:'user',content:'发票要求'}],
    knowledgeBases:[{...kb,dataDir:'/forged',wikiAccess:{orgId:'other',userId:'other',sourceRoot:'/forged'}}]}),
    {orgId:'org',userId:'alice'},root);
  assert.equal(authorized.knowledgeBases![0].wikiAccess!.userId,'alice');
  assert.equal(authorized.knowledgeBases![0].dataDir,directory);
  const requestBody={knowledgeBase:{...kb,dataDir:'/forged',wikiAccess:{orgId:'other',userId:'other',sourceRoot:'/forged'}}};
  const guarded=await app.inject({method:'POST',url:'/trusted',headers,payload:requestBody});
  assert.equal(guarded.statusCode,200,guarded.body);
  assert.equal(guarded.json().knowledgeBase.dataDir,directory);
  assert.equal(guarded.json().knowledgeBase.wikiAccess.userId,'alice');
  assert.equal((await app.inject({method:'POST',url:'/trusted',payload:requestBody})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/trusted',headers,payload:{knowledgeBase:{id:'missing'}}})).statusCode,404);
  let executed=0;
  const runStore=new MemoryStore();
  await runStore.set('run:trusted-run',JSON.stringify({ownerUserId:'alice',orgId:'org'}));
  const runner=createKnowledgeRunner(runStore,
    {start:async request=>{executed++;assert.equal(request.knowledgeBases![0].wikiAccess!.userId,'alice');}},root);
  await runner.start({...authorized,runId:'trusted-run'},()=>{});
  await assert.rejects(runner.start({...authorized,runId:'unknown'},()=>{}));
  config[0].enabled=false;save();
  await assert.rejects(runner.start({...authorized,runId:'trusted-run'},()=>{}));
  assert.equal(executed,1);
  config[0].enabled=true;save();
  const body={documentIds:[imported.sourceSnapshot.documentId],idempotencyKey:'create-once',
    model:{provider:'openai-compatible',chatModel:'stub',apiKey:'not-persisted'}};
  const start=()=>app.inject({method:'POST',url:'/knowledge/kb/wiki/generation-jobs',headers,payload:body});
  const started=await start();assert.equal(started.statusCode,202,started.body);
  let job=started.json();
  for(let i=0;i<100&&['queued','running'].includes(job.state);i++){
    await new Promise(resolve=>setTimeout(resolve,5));
    job=(await app.inject({method:'GET',url:'/knowledge/kb/wiki/generation-jobs/'+job.jobId,headers})).json();
  }
  assert.equal(job.state,'completed',JSON.stringify(job));
  assert.equal((await start()).json().jobId,job.jobId);assert.equal(calls,1);
  assert.ok(!(await searchKnowledgeBase(kb,'发票',8)).some(hit=>hit.wiki),'draft must not recall');
  const pageId=job.pageIds[0];
  const page=(await app.inject({method:'GET',url:'/knowledge/kb/wiki/pages/'+pageId+'?view=drafts',headers})).json();
  const publish=await app.inject({method:'POST',url:'/knowledge/kb/wiki/pages/'+pageId+'/publish',headers,payload:{
    baseGeneration:page.page.generation,draftRevisionId:page.revision.revisionId,contentHash:page.revision.contentHash,idempotencyKey:'publish'}});
  assert.equal(publish.statusCode,200,publish.body);
  assert.ok((await searchKnowledgeBase(kb,'发票',8)).some(hit=>hit.wiki));
  assert.ok(!(await searchKnowledgeBase({...kb,wikiRetrievalEnabled:false},'发票',8)).some(hit=>hit.wiki));
  assert.equal((await app.inject({method:'GET',url:'/knowledge/kb/wiki/pages/'+pageId,headers:{'x-user':'bob'}})).statusCode,404);
  await deleteKnowledgeDocument(kb,imported.sourceSnapshot.documentId);
  assert.deepEqual(await searchKnowledgeBase(kb,'发票',8),[]);
});
