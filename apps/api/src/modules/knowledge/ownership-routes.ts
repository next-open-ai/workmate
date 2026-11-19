import type {FastifyReply} from 'fastify';
import {KnowledgeAccessError} from './catalog.js';
export function sendKnowledgeAccessError(reply:FastifyReply,error:unknown){
  const known=error instanceof KnowledgeAccessError;
  return reply.code(known?error.statusCode:503).send({code:known?error.code:'KNOWLEDGE_UNAVAILABLE',message:'知识库不存在、配置不可用或无权访问。'});
}
