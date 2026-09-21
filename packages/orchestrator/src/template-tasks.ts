import { randomUUID } from 'node:crypto';
import { TemplateTaskInputSchema, TaskTemplateConfigurationSchema, TaskPresentationSchema, TaskDeliverySchema, type TaskTemplateDefinition, type TaskTemplateTrial, type TaskSkillDescriptor, type TaskExportFormat, type TaskPresentation, type TaskTemplate, type TemplateTask, type TemplateTaskDetail, type TemplateTaskRun, type TaskResult } from '@workmate/contracts';
import type { KeyValueStore } from './storage/kv.js';
import { withKeyLock } from './lock.js';
import { businessSummarySkill, businessSummaryTemplate } from './task-skills/business-summary/index.js';

export class TemplateTaskError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}
export interface TaskOwner { orgId: string; userId: string }
export interface TaskSkillRuntime {
  id: string; version: string; inputHtml: string; descriptor?: TaskSkillDescriptor;
  prepare(input: unknown): Record<string, unknown>;
  execute(input: unknown): Record<string, unknown> | Promise<Record<string, unknown>>;
  format(input: unknown): Record<string, unknown>;
  report(input: unknown, options?: TaskPresentation): string;
  exportCsv?(input: unknown): string;
}

/** Server-owned pilot. Only compiled, explicitly registered Skill entries can run. */
export class TemplateTaskService {
  constructor(private readonly store: KeyValueStore,
    private readonly skills: TaskSkillRuntime[] = [businessSummarySkill],
    private readonly templates: TaskTemplate[] = [businessSummaryTemplate]) {}

  async listTemplates(owner?: TaskOwner) {
    const custom = owner ? (await this.definitions(owner)).filter(item => !item.archived && item.published.length).map(item => item.published.at(-1)!) : [];
    return structuredClone([...this.templates, ...custom]);
  }
  descriptors(): TaskSkillDescriptor[] { return this.skills.flatMap(skill => skill.descriptor ? [structuredClone(skill.descriptor)] : []); }
  skillInput(id: string, version: string) { return this.skill({ skillId: id, version, entry: 'prepare' }, 'prepare').inputHtml; }
  private definitionPrefix(owner: TaskOwner) { return `task-template-definitions:${encodeURIComponent(owner.orgId)}:${encodeURIComponent(owner.userId)}:`; }
  private definitionKey(owner: TaskOwner, id: string) { return this.definitionPrefix(owner) + encodeURIComponent(id); }
  async definitions(owner: TaskOwner): Promise<TaskTemplateDefinition[]> {
    const keys = await this.store.keys(this.definitionPrefix(owner));
    const records = await Promise.all(keys.map(async key => JSON.parse((await this.store.get(key))!) as TaskTemplateDefinition));
    return records.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async definition(owner: TaskOwner, id: string): Promise<TaskTemplateDefinition> {
    const raw = await this.store.get(this.definitionKey(owner, id));
    if (!raw) throw new TemplateTaskError('模板不存在', 404);
    return JSON.parse(raw);
  }
  async saveDefinition(owner: TaskOwner, value: unknown, id?: string, revision?: number): Promise<TaskTemplateDefinition> {
    const config = TaskTemplateConfigurationSchema.parse(value);
    const templateId = id ?? randomUUID();
    return withKeyLock(this.definitionKey(owner, templateId), async () => {
      const previous = id ? await this.definition(owner, id) : undefined;
      if (previous && previous.revision !== revision) throw new TemplateTaskError('模板已更新，请重新打开后编辑', 409);
      const record: TaskTemplateDefinition = {
        id: templateId, orgId: owner.orgId, ownerUserId: owner.userId,
        revision: (previous?.revision ?? 0) + 1,
        draft: { ...config, id: templateId, version: `1.0.${previous?.published.length ?? 0}` },
        published: previous?.published ?? [], archived: previous?.archived ?? false,
        createdAt: previous?.createdAt ?? Date.now(), updatedAt: Date.now(),
      };
      await this.store.set(this.definitionKey(owner, templateId), JSON.stringify(record)); await this.store.flush();
      return record;
    });
  }
  private validateTemplate(template: TaskTemplate) {
    const input = this.skill(template.input, 'prepare').descriptor;
    const execution = this.skill(template.execution, 'execute').descriptor;
    const output = this.skill(template.output, 'format').descriptor;
    const view = this.skill(template.view, 'report').descriptor;
    if (!input || !execution || !output || !view) throw new TemplateTaskError('能力缺少可配置的输入输出声明');
    if (input.inputType !== execution.inputType || execution.resultType !== output.resultType
      || execution.resultVersion !== output.resultVersion || output.resultType !== view.resultType
      || output.resultVersion !== view.resultVersion || template.resultType !== output.resultType
      || template.resultVersion !== output.resultVersion) throw new TemplateTaskError('输入、执行、输出与展示的数据类型或版本不兼容');
    const delivery = TaskDeliverySchema.parse(template.delivery ?? {});
    if (delivery.exports.some(format => !output.exports.includes(format))) throw new TemplateTaskError('输出 Skill 不支持所选导出格式');
  }
  async previewInput(owner: TaskOwner, id: string): Promise<{ html: string; parameters: Record<string, unknown> }> {
    const record = await this.definition(owner, id);
    return { html: this.skill(record.draft.input, 'prepare').inputHtml, parameters: record.draft.defaults ?? {} };
  }
  async trial(owner: TaskOwner, id: string, revision: number): Promise<TaskTemplateTrial> {
    return withKeyLock(this.definitionKey(owner, id), async () => {
      const record = await this.definition(owner, id);
      if (record.revision !== revision) throw new TemplateTaskError('模板已更新，请重新打开后试运行', 409);
      delete record.verifiedRevision; delete record.verifiedAt;
      await this.store.set(this.definitionKey(owner, id), JSON.stringify(record)); await this.store.flush();
      const template = record.draft;
      this.validateTemplate(template);
      const input = this.skill(template.input, 'prepare').prepare(template.defaults ?? {});
      const raw = await this.skill(template.execution, 'execute').execute(input);
      const data = this.skill(template.output, 'format').format(raw);
      const html = this.skill(template.view, 'report').report(data, TaskPresentationSchema.parse(template.presentation ?? {}));
      for (const format of template.delivery?.exports ?? ['json']) {
        if (format === 'csv') {
          const outputSkill = this.skill(template.output, 'format');
          if (!outputSkill.exportCsv) throw new TemplateTaskError('输出 Skill 没有 CSV 导出入口');
          outputSkill.exportCsv(data);
        }
      }
      record.verifiedRevision = revision; record.verifiedAt = Date.now();
      await this.store.set(this.definitionKey(owner, id), JSON.stringify(record)); await this.store.flush();
      return { revision, data, html, checks: ['Skill 入口与版本有效', '输入输出契约兼容', '默认参数校验通过', '执行与结果格式化通过', '报告渲染与导出能力通过'] };
    });
  }
  async publish(owner: TaskOwner, id: string, revision: number): Promise<TaskTemplateDefinition> {
    return withKeyLock(this.definitionKey(owner, id), async () => {
      const record = await this.definition(owner, id);
      if (record.revision !== revision) throw new TemplateTaskError('模板已更新，请重新打开后发布', 409);
      if (record.archived) throw new TemplateTaskError('请先恢复已停用的模板');
      if (record.verifiedRevision !== revision) throw new TemplateTaskError('请先对当前草稿完成试运行');
      this.validateTemplate(record.draft);
      if (!record.published.some(item => item.version === record.draft.version)) record.published.push(structuredClone(record.draft));
      record.updatedAt = Date.now();
      await this.store.set(this.definitionKey(owner, id), JSON.stringify(record)); await this.store.flush();
      return record;
    });
  }
  async archive(owner: TaskOwner, id: string, revision: number, archived: boolean) {
    return withKeyLock(this.definitionKey(owner, id), async () => {
      const record = await this.definition(owner, id);
      if (record.revision !== revision) throw new TemplateTaskError('模板已更新，请刷新后重试', 409);
      record.archived = archived; record.revision++; delete record.verifiedRevision; delete record.verifiedAt;
      record.updatedAt = Date.now();
      await this.store.set(this.definitionKey(owner, id), JSON.stringify(record)); await this.store.flush();
      return record;
    });
  }
  /** Called once at API startup, before accepting requests. No automatic side-effect replay. */
  async recoverInterrupted() {
    for (const key of await this.store.keys('template-runs:')) {
      const run = JSON.parse((await this.store.get(key))!) as TemplateTaskRun;
      if (run.status !== 'running') continue;
      run.status = 'failed'; run.finishedAt = Date.now(); run.error = '服务重启，上次执行中断，请重新运行';
      await this.store.set(key, JSON.stringify(run));
    }
    await this.store.flush();
  }
  async template(id: string, version: string, owner?: TaskOwner) {
    const builtin = this.templates.find(item => item.id === id && item.version === version);
    const template = builtin ?? (owner && !this.templates.some(item => item.id === id) ? (await this.definition(owner, id)).published.find(item => item.version === version) : undefined);
    if (!template) throw new TemplateTaskError('任务模板版本不可用', 404);
    return structuredClone(template);
  }
  private skill(ref: TaskTemplate['input'], expected: string) {
    const skill = this.skills.find(item => item.id === ref.skillId && item.version === ref.version);
    if (!skill || ref.entry !== expected) throw new TemplateTaskError('Skill 入口或版本不可用');
    return skill;
  }
  async inputView(id: string, version: string, owner?: TaskOwner) { return this.skill((await this.template(id, version, owner)).input, 'prepare').inputHtml; }
  private prefix(owner: TaskOwner) {
    return `template-tasks:${encodeURIComponent(owner.orgId)}:${encodeURIComponent(owner.userId)}:`;
  }
  private key(owner: TaskOwner, id: string) { return `${this.prefix(owner)}${encodeURIComponent(id)}`; }
  private runPrefix(owner: TaskOwner, id: string) { return `template-runs:${this.key(owner, id)}:`; }
  async list(owner: TaskOwner): Promise<TemplateTask[]> {
    const keys = await this.store.keys(this.prefix(owner));
    const records = await Promise.all(keys.map(async key => JSON.parse((await this.store.get(key))!) as TemplateTask));
    return records.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async get(owner: TaskOwner, id: string): Promise<TemplateTask> {
    const raw = await this.store.get(this.key(owner, id));
    if (!raw) throw new TemplateTaskError('任务不存在', 404);
    return JSON.parse(raw);
  }
  async save(owner: TaskOwner, value: unknown, id?: string, revision?: number): Promise<TemplateTask> {
    const input = TemplateTaskInputSchema.parse(value);
    const template = await this.template(input.templateId, input.templateVersion, owner);
    if (!id && !this.templates.some(item => item.id === template.id) && (await this.definition(owner, template.id)).archived) {
      throw new TemplateTaskError('模板已停用，不能创建新任务');
    }
    const parameters = this.skill(template.input, 'prepare').prepare({ ...template.defaults, ...input.parameters });
    const taskId = id ?? randomUUID();
    return withKeyLock(this.key(owner, taskId), async () => {
      const existing = id ? await this.get(owner, id) : undefined;
      if (existing && existing.revision !== revision) throw new TemplateTaskError('任务已更新，请刷新后重新编辑', 409);
      if (existing && (existing.templateId !== input.templateId || existing.templateVersion !== input.templateVersion)) {
        throw new TemplateTaskError('试验版不支持修改任务模板版本，请新建任务');
      }
      const task: TemplateTask = {
        ...input, parameters, id: taskId, orgId: owner.orgId, ownerUserId: owner.userId,
        revision: (existing?.revision ?? 0) + 1, createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now(),
      };
      await this.store.set(this.key(owner, taskId), JSON.stringify(task));
      await this.store.flush();
      return task;
    });
  }
  async detail(owner: TaskOwner, id: string): Promise<TemplateTaskDetail> {
    const task = await this.get(owner, id);
    const keys = await this.store.keys(this.runPrefix(owner, id));
    const runs = await Promise.all(keys.map(async key => JSON.parse((await this.store.get(key))!) as TemplateTaskRun));
    return { task, runs: runs.sort((a, b) => b.startedAt - a.startedAt) };
  }
  async run(owner: TaskOwner, id: string, requestId: string): Promise<TemplateTaskRun> {
    const key = `${this.runPrefix(owner, id)}${encodeURIComponent(requestId)}`;
    return withKeyLock(key, async () => {
      const task = await this.get(owner, id);
      const previous = await this.store.get(key);
      if (previous) {
        const record = JSON.parse(previous) as TemplateTaskRun;
        // A running record seen after acquiring this lock belongs to an interrupted process.
        if (record.status === 'running') {
          record.status = 'failed'; record.finishedAt = Date.now(); record.error = '上次执行中断，请重新运行';
          await this.store.set(key, JSON.stringify(record)); await this.store.flush();
        }
        return record;
      }
      const template = await this.template(task.templateId, task.templateVersion, owner);
      const run: TemplateTaskRun = {
        id: requestId, taskId: id, taskRevision: task.revision, template,
        inputSnapshot: structuredClone(task.parameters), startedAt: Date.now(), status: 'running', steps: [],
      };
      const persist = async () => { await this.store.set(key, JSON.stringify(run)); await this.store.flush(); };
      await persist();
      let stage: 'input' | 'execution' | 'output' = 'input';
      try {
        const input = this.skill(template.input, 'prepare').prepare(run.inputSnapshot);
        run.steps.push({ stage, status: 'completed', at: Date.now() }); await persist();
        stage = 'execution';
        const output = await this.skill(template.execution, 'execute').execute(input);
        run.steps.push({ stage, status: 'completed', at: Date.now() }); await persist();
        stage = 'output';
        const data = this.skill(template.output, 'format').format(output);
        run.result = {
          id: randomUUID(), taskId: id, runId: run.id, type: template.resultType, schemaVersion: template.resultVersion,
          title: task.name, data, view: structuredClone(template.view), createdAt: Date.now(),
          presentation: TaskPresentationSchema.parse(template.presentation ?? {}),
          delivery: TaskDeliverySchema.parse(template.delivery ?? {}),
        };
        run.steps.push({ stage, status: 'completed', at: Date.now() });
        run.status = 'completed';
      } catch (error) {
        run.status = 'failed'; run.error = error instanceof Error ? error.message : '执行失败';
        run.steps.push({ stage, status: 'failed', at: Date.now() });
      }
      run.finishedAt = Date.now(); await persist();
      return run;
    });
  }
  async result(owner: TaskOwner, taskId: string, runId: string): Promise<TaskResult> {
    await this.get(owner, taskId);
    const raw = await this.store.get(`${this.runPrefix(owner, taskId)}${encodeURIComponent(runId)}`);
    const result = raw ? (JSON.parse(raw) as TemplateTaskRun).result : undefined;
    if (!result) throw new TemplateTaskError('本次运行没有可用结果', 404);
    return result;
  }
  async exportResult(owner: TaskOwner, taskId: string, runId: string, format: TaskExportFormat) {
    const result = await this.result(owner, taskId, runId);
    if (!(result.delivery?.exports ?? ['json']).includes(format)) throw new TemplateTaskError('此模板未启用该导出格式');
    if (format === 'json') return { content: JSON.stringify(result, null, 2), mime: 'application/json', name: `result-${result.id}.json` };
    if (format === 'html') {
      const rendered = this.render(result);
      if (!rendered.html) throw new TemplateTaskError('报告模板不可用');
      return { content: rendered.html, mime: 'text/html; charset=utf-8', name: `report-${result.id}.html` };
    }
    const detail = await this.detail(owner, taskId);
    const run = detail.runs.find(item => item.id === runId)!;
    const skill = this.skill(run.template.output, 'format');
    if (!skill.exportCsv) throw new TemplateTaskError('CSV 导出入口不可用');
    return { content: skill.exportCsv(result.data), mime: 'text/csv; charset=utf-8', name: `data-${result.id}.csv` };
  }
  render(result: TaskResult): { html: string | null; warning?: string } {
    const descriptor = this.skills.find(skill => skill.id === result.view.skillId && skill.version === result.view.version)?.descriptor;
    const compatible = (descriptor?.resultType === result.type && descriptor.resultVersion === result.schemaVersion && descriptor.entries.view === result.view.entry) || this.templates.some(template => template.resultType === result.type && template.resultVersion === result.schemaVersion
      && template.view.skillId === result.view.skillId && template.view.version === result.view.version && template.view.entry === result.view.entry);
    if (!compatible) return { html: null, warning: '展示模板不兼容，请查看结构化数据' };
    try { return { html: this.skill(result.view, 'report').report(result.data, result.presentation) }; }
    catch { return { html: null, warning: '报告模板暂不可用，请查看结构化数据' }; }
  }
}
