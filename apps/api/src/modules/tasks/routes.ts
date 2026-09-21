import type { FastifyPluginAsync } from 'fastify';
import { TemplateTaskService, TemplateTaskError } from '@workmate/orchestrator';
import { requireAuth } from '../auth/service.js';
import { getOrchestrator } from '../orchestration/routes.js';
import type { TaskExportFormat } from '@workmate/contracts';

export const templateTaskRoutes: FastifyPluginAsync = async app => {
  const service = new TemplateTaskService(getOrchestrator().store);
  await service.recoverInterrupted();
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof TemplateTaskError ? error.statusCode : error instanceof Error && error.name === 'ZodError' ? 400 : 500;
    if (status === 500) app.log.error(error);
    reply.code(status).send({ message: status === 500 ? '任务服务暂时不可用，请重试' : (error as Error).message });
  });
  app.get('/task-templates', async request => ({ templates: await service.listTemplates(requireAuth(request)) }));
  app.get('/task-template-skills', async () => ({ skills: service.descriptors() }));
  app.get<{ Params: { id: string }; Querystring: { version: string } }>('/task-template-skills/:id/input', async request => ({ html: service.skillInput(request.params.id, request.query.version) }));
  app.get('/task-template-definitions', async request => ({ definitions: await service.definitions(requireAuth(request)) }));
  app.post('/task-template-definitions', async (request, reply) => reply.code(201).send({ definition: await service.saveDefinition(requireAuth(request), request.body) }));
  app.get<{ Params: { id: string } }>('/task-template-definitions/:id', async request => ({ definition: await service.definition(requireAuth(request), request.params.id) }));
  app.put<{ Params: { id: string }; Body: { revision: number; configuration: unknown } }>('/task-template-definitions/:id', async request => ({
    definition: await service.saveDefinition(requireAuth(request), request.body?.configuration, request.params.id, request.body?.revision),
  }));
  app.get<{ Params: { id: string } }>('/task-template-definitions/:id/input', async request => service.previewInput(requireAuth(request), request.params.id));
  app.post<{ Params: { id: string }; Body: { revision: number } }>('/task-template-definitions/:id/trial', async request => service.trial(requireAuth(request), request.params.id, request.body?.revision));
  app.post<{ Params: { id: string }; Body: { revision: number } }>('/task-template-definitions/:id/publish', async request => ({ definition: await service.publish(requireAuth(request), request.params.id, request.body?.revision) }));
  app.post<{ Params: { id: string }; Body: { revision: number; archived: boolean } }>('/task-template-definitions/:id/archive', async request => {
    if (typeof request.body?.archived !== 'boolean') throw new TemplateTaskError('停用状态必须为布尔值');
    return { definition: await service.archive(requireAuth(request), request.params.id, request.body.revision, request.body.archived) };
  });
  app.get<{ Params: { id: string }; Querystring: { version: string } }>('/task-templates/:id', async request => ({ template: await service.template(request.params.id, request.query.version, requireAuth(request)) }));
  app.get<{ Params: { id: string }; Querystring: { version: string } }>('/task-templates/:id/input', async request => {
    return { html: await service.inputView(request.params.id, request.query.version, requireAuth(request)) };
  });
  app.get('/template-tasks', async request => ({ tasks: await service.list(requireAuth(request)) }));
  app.post('/template-tasks', async (request, reply) => reply.code(201).send({ task: await service.save(requireAuth(request), request.body) }));
  app.get<{ Params: { id: string } }>('/template-tasks/:id', async request => service.detail(requireAuth(request), request.params.id));
  app.put<{ Params: { id: string }; Body: { revision: number; input: unknown } }>('/template-tasks/:id', async request => {
    return { task: await service.save(requireAuth(request), request.body?.input, request.params.id, request.body?.revision) };
  });
  app.post<{ Params: { id: string }; Body: { requestId: string } }>('/template-tasks/:id/runs', async request => {
    const requestId = request.body?.requestId;
    if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(requestId)) throw new TemplateTaskError('需要有效的运行请求 ID');
    return { run: await service.run(requireAuth(request), request.params.id, requestId) };
  });
  app.get<{ Params: { id: string; runId: string } }>('/template-tasks/:id/runs/:runId/result', async request => {
    const result = await service.result(requireAuth(request), request.params.id, request.params.runId);
    return { result, ...service.render(result) };
  });
  app.get<{ Params: { id: string; runId: string }; Querystring: { format: string } }>('/template-tasks/:id/runs/:runId/export', async (request, reply) => {
    const format = request.query.format;
    if (!['json', 'html', 'csv'].includes(format)) throw new TemplateTaskError('不支持的导出格式');
    const exported = await service.exportResult(requireAuth(request), request.params.id, request.params.runId, format as TaskExportFormat);
    return reply.type(exported.mime).header('Content-Disposition', `attachment; filename="${exported.name}"`).send(exported.content);
  });
};
