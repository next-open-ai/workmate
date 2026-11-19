import type {AgentRunner,KeyValueStore,RunRecord} from '@workmate/orchestrator';
import {authorizeRunKnowledge} from './access.js';
import {knowledgeDataRoot} from './catalog.js';
export function createKnowledgeRunner(store:KeyValueStore,base:AgentRunner,root=knowledgeDataRoot()):AgentRunner{
  return {async start(request,emit,options){
    if(!request.knowledgeBases?.length)return base.start(request,emit,options);
    const raw=request.runId?await store.get(`run:${request.runId}`):undefined;
    const run:RunRecord|undefined=raw?JSON.parse(raw):undefined;
    const authorized=authorizeRunKnowledge(request,{orgId:run?.orgId,userId:run?.ownerUserId??run?.userId},root);
    return base.start(authorized,emit,options);
  }};
}
