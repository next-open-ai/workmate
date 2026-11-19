// KH-T3: production search handlers, no browser, user APIs or model calls.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';
const source=fs.readFileSync('apps/renderer/src/features/knowledge/KnowledgePage.vue','utf8');
const script=source.slice(source.indexOf('<script setup lang="ts">')+24,source.indexOf('</script>'));
const parsed=ts.createSourceFile('knowledge.ts',script,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const names=['runSearch','invalidateSearch'];
const functions=parsed.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.includes(node.name?.text)).map(node=>node.getText(parsed));
assert.equal(functions.length,2);
assert.match(script,/watch\(\[selectedId, searchQuery\], invalidateSearch, \{ flush: 'sync' \}\)/);
assert.match(source,/detailTab === 'wiki'/);
assert.match(source,/v-model="draft.wikiRetrievalEnabled"/);
assert.match(source,/hit\.retrieval\?\.degraded/);
assert.doesNotMatch(source,/hit\.score \* 100/);
const pending=[],notices=[];
const ref=value=>({value});
const env={selected:ref({id:'a'}),searchQuery:ref('发票'),searching:ref(false),searchHits:ref([]),searchError:ref(''),searchCompleted:ref(false),
  configured:ref(false),activeConfig:ref({}),toPayload:value=>value,toModelPayload:value=>value,
  notify:{error:error=>notices.push(error)},searchKnowledge:input=>new Promise((resolve,reject)=>pending.push({input,resolve,reject}))};
const api=new Function('env',`const {selected,searchQuery,searching,searchHits,searchError,searchCompleted,configured,activeConfig,toPayload,toModelPayload,notify,searchKnowledge}=env;let searchRequestId=0;${functions.join('\n')};return {runSearch,invalidateSearch};`)(env);
const first=api.runSearch();
assert.equal(env.searching.value,true);
assert.equal(env.searchCompleted.value,false);
env.selected.value={id:'b'};api.invalidateSearch();
const second=api.runSearch();
pending[0].resolve({results:[{id:'stale-a'}]});await first;
assert.deepEqual(env.searchHits.value,[]);
assert.equal(env.searching.value,true);
pending[1].resolve({results:[{id:'current-b'}]});await second;
assert.equal(env.searchHits.value[0].id,'current-b');
assert.equal(env.searchCompleted.value,true,'only completed searches may export a snapshot');
const failed=api.runSearch();pending[2].reject(new Error('索引不可用'));await failed;
assert.equal(env.searchError.value,'索引不可用');assert.equal(env.searching.value,false);
assert.equal(env.searchCompleted.value,false,'failed search must not export an empty success');
const late=api.runSearch();api.invalidateSearch();pending[3].reject(new Error('old failure'));await late;
assert.equal(env.searchError.value,'');assert.equal(notices.length,1);
console.log('KH-T3 PASS: Wiki wiring, provenance, real search handlers, stale-success/error suppression and retry feedback.');
