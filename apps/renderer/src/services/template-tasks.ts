import type { TaskTemplate, TemplateTask, TemplateTaskInput, TemplateTaskDetail, TemplateTaskRun, TaskResult, TaskTemplateConfiguration, TaskTemplateDefinition, TaskSkillDescriptor, TaskTemplateTrial, TaskExportFormat } from '@workmate/contracts';
export type { TaskTemplate, TemplateTask, TemplateTaskDetail, TemplateTaskRun, TaskResult };
export type { TaskTemplateConfiguration, TaskTemplateDefinition, TaskSkillDescriptor, TaskTemplateTrial, TaskExportFormat };
const base = () => window.location.protocol === 'file:' ? 'http://127.0.0.1:4328/api' : '/api';
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${base()}${path}`, {
    method, headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || '任务请求失败');
  return result;
}
export const templateTasksApi = {
  templates: () => request<{ templates: TaskTemplate[] }>('/task-templates'),
  template: (id: string, version: string) => request<{ template: TaskTemplate }>(`/task-templates/${encodeURIComponent(id)}?version=${encodeURIComponent(version)}`),
  skills: () => request<{ skills: TaskSkillDescriptor[] }>('/task-template-skills'),
  skillInput: (id: string, version: string) => request<{ html: string }>(`/task-template-skills/${encodeURIComponent(id)}/input?version=${encodeURIComponent(version)}`),
  definitions: () => request<{ definitions: TaskTemplateDefinition[] }>('/task-template-definitions'),
  saveDefinition: (configuration: TaskTemplateConfiguration, definition?: TaskTemplateDefinition) => definition
    ? request<{ definition: TaskTemplateDefinition }>(`/task-template-definitions/${encodeURIComponent(definition.id)}`, 'PUT', { revision: definition.revision, configuration })
    : request<{ definition: TaskTemplateDefinition }>('/task-template-definitions', 'POST', configuration),
  trial: (definition: TaskTemplateDefinition) => request<TaskTemplateTrial>(`/task-template-definitions/${encodeURIComponent(definition.id)}/trial`, 'POST', { revision: definition.revision }),
  publish: (definition: TaskTemplateDefinition) => request<{ definition: TaskTemplateDefinition }>(`/task-template-definitions/${encodeURIComponent(definition.id)}/publish`, 'POST', { revision: definition.revision }),
  archive: (definition: TaskTemplateDefinition, archived: boolean) => request<{ definition: TaskTemplateDefinition }>(`/task-template-definitions/${encodeURIComponent(definition.id)}/archive`, 'POST', { revision: definition.revision, archived }),
  input: (template: TaskTemplate) => request<{ html: string }>(`/task-templates/${encodeURIComponent(template.id)}/input?version=${encodeURIComponent(template.version)}`),
  list: () => request<{ tasks: TemplateTask[] }>('/template-tasks'),
  detail: (id: string) => request<TemplateTaskDetail>(`/template-tasks/${encodeURIComponent(id)}`),
  save: (input: TemplateTaskInput, task?: TemplateTask) => task
    ? request<{ task: TemplateTask }>(`/template-tasks/${encodeURIComponent(task.id)}`, 'PUT', { revision: task.revision, input })
    : request<{ task: TemplateTask }>('/template-tasks', 'POST', input),
  run: (id: string, requestId: string) => request<{ run: TemplateTaskRun }>(`/template-tasks/${encodeURIComponent(id)}/runs`, 'POST', { requestId }),
  result: (id: string, runId: string) => request<{ result: TaskResult; html: string | null; warning?: string }>(`/template-tasks/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/result`),
  async download(id: string, runId: string, format: TaskExportFormat) {
    const response = await fetch(`${base()}/template-tasks/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/export?format=${format}`);
    if (!response.ok) throw new Error((await response.json()).message || '导出失败');
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a'); link.href = url; link.download = `task-result-${runId}.${format}`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};
