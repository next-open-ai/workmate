// Execute the actual Vue action functions with protocol adapters, not live APIs.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';
const source=fs.readFileSync('apps/renderer/src/features/knowledge/WikiWorkbench.vue','utf8');
const script=source.slice(source.indexOf('<script setup lang="ts">')+24,source.indexOf('</script>'));
const ast=ts.createSourceFile('wiki.ts',script,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const actions=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&['selectSources','resumeGeneration'].includes(n.name?.text)).map(n=>n.getText(ast));
assert.equal(actions.length,2);
const ref=value=>({value}); let confirm=false, failList=false, failStart=false; const starts=[];
const env={busy:ref(false),activeJob:ref(false),job:ref({jobId:'job',resumable:true,sources:[{documentId:'keep'},{documentId:'missing'}]}),
  chosen:ref(['stale']),documents:ref([{id:'stale'}]),retryNotice:ref(''),choosing:ref(false),error:ref(''),cancelled:ref(true),
  props:{knowledgeBase:{id:'kb'},model:{provider:'openai-compatible',chatModel:'stub',apiKey:'stub'}},
  listKnowledgeDocuments:async()=>{if(failList)throw new Error('list failure');return {documents:[{id:'keep'}]};},
  wikiApi:{start:async(kb,body)=>{starts.push({kb,body});if(failStart)throw new Error('network');return {jobId:'job',state:'queued'};}},
  window:{confirm:()=>confirm},message:e=>e.message,poll:()=>{}};
const code=ts.transpile(actions.join('\n'),{target:ts.ScriptTarget.ES2022});
const api=new Function('env',`const {${Object.keys(env).join(',')}}=env;let disposed=false,requestKey='old',resumeKey='';const kb='kb';${code};return {selectSources,resumeGeneration};`)(env);
await api.selectSources(true);
assert.deepEqual(env.chosen.value,['keep']);assert.match(env.retryNotice.value,/部分原资料/);assert.equal(starts.length,0);
failList=true;await api.selectSources(true);assert.deepEqual(env.documents.value,[]);assert.deepEqual(env.chosen.value,[]);assert.equal(starts.length,0);
await api.resumeGeneration();assert.equal(starts.length,0,'no call before confirmation');
confirm=true;failStart=true;await api.resumeGeneration();assert.equal(starts.length,1);assert.equal(env.error.value,'network');
failStart=false;await api.resumeGeneration();assert.equal(starts.length,2);
assert.equal(starts[0].body.idempotencyKey,starts[1].body.idempotencyKey,'network retry reuses key');
assert.equal(starts[1].body.resumeJobId,'job');assert.equal(env.job.value.state,'queued');assert.equal(env.cancelled.value,false);
console.log('KH-T5/T6 action PASS: retry preselection, failed list clearing, confirmation and resume key replay.');
