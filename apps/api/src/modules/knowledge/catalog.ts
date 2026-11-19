import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {KnowledgeBaseRuntimeSchema,type KnowledgeBaseRuntime} from '@workmate/contracts';
import {hydrateKnowledgeRuntime} from './runtime-config.js';

export const knowledgeDataRoot=()=>process.env.WORKMATE_DATA_DIR||path.join(os.homedir(),'.workmate');
export class KnowledgeAccessError extends Error{
  constructor(public readonly statusCode:number,public readonly code:string){super(code);}
}
const rec=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
/** Reuses Workmate's saved library scope; does not import Workexpert's ownership migration. */
export class KnowledgeCatalog{
  constructor(private readonly root=knowledgeDataRoot()){}
  resolve(principal:{orgId:string;userId:string},id:unknown):KnowledgeBaseRuntime{
    if(typeof id!=='string'||!principal.orgId||!principal.userId)throw new KnowledgeAccessError(404,'KNOWLEDGE_NOT_FOUND');
    try{
      const read=(name:string)=>{const file=path.join(this.root,name);return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):undefined;};
      const envelope=read('knowledge-bases.json');
      const configured=Array.isArray(envelope)?envelope:Array.isArray(envelope?.meta)?envelope.meta:[];
      const kv=rec(read('domain.json')?.kv);
      const legacy=kv[`user:${principal.userId}:capabilities.knowledge`]??kv['capabilities.knowledge'];
      const rows=legacy===undefined?configured:typeof legacy==='string'?JSON.parse(legacy):legacy;
      const row=Array.isArray(rows)?rows.map(rec).find(r=>r.id===id):undefined;
      if(!row||row.enabled===false)throw new KnowledgeAccessError(404,'KNOWLEDGE_NOT_FOUND');
      const secrets=rec(rec(rec(envelope).secrets).bases);
      const value=hydrateKnowledgeRuntime(this.root,principal.userId,{...row,...rec(secrets[id])});
      delete value.wikiAccess;
      for(const key of ['baseUrl','embeddingBaseUrl'])if(!value[key])delete value[key];
      return KnowledgeBaseRuntimeSchema.parse({...value,wikiAccess:{orgId:principal.orgId,userId:principal.userId,sourceRoot:path.join(this.root,'knowledge-sources')}});
    }catch(error){
      if(error instanceof KnowledgeAccessError)throw error;
      throw new KnowledgeAccessError(503,'KNOWLEDGE_CONFIG_INVALID');
    }
  }
}
