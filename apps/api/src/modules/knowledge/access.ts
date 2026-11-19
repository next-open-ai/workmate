import type {FastifyInstance} from 'fastify';
import type {ChatRequest} from '@workmate/contracts';
import {KnowledgeCatalog,knowledgeDataRoot} from './catalog.js';
import {sendKnowledgeAccessError} from './ownership-routes.js';
export function authorizeRunKnowledge(request:ChatRequest,principal:{orgId?:string;userId?:string},root=knowledgeDataRoot()):ChatRequest{
  if(!request.knowledgeBases?.length)return request;
  if(!principal.orgId||!principal.userId)throw new Error('Knowledge access requires an authenticated owner.');
  const actor={orgId:principal.orgId,userId:principal.userId},catalog=new KnowledgeCatalog(root);
  return {...request,knowledgeBases:request.knowledgeBases.map(kb=>catalog.resolve(actor,kb.id))};
}
export function registerKnowledgeAccessGuard(app:FastifyInstance,root=knowledgeDataRoot){
  app.addHook('preHandler',async(request,reply)=>{
    const body=request.body;
    if(!body||typeof body!=='object'||!('knowledgeBase' in body))return;
    if(!request.auth)return reply.code(401).send({code:'UNAUTHORIZED'});
    try{
      const supplied=body.knowledgeBase;
      body.knowledgeBase=new KnowledgeCatalog(root()).resolve(request.auth,supplied&&typeof supplied==='object'&&'id' in supplied?supplied.id:undefined);
    }catch(error){return sendKnowledgeAccessError(reply,error);}
  });
}
