import { VoiceWorkBindingSchema, VoiceWorkNoticeSchema, VoiceWorkStartSchema, VoiceWorkTaskSchema, type VoiceWorkBinding, type VoiceWorkNotice, type VoiceWorkResult } from '@workmate/contracts';
import type { Orchestrator } from '@workmate/orchestrator';

export const VOICE_WORK_TOOLS = [
  { type: 'function', name: 'discover_capabilities', description: '查询 Workmate 可用员工。用户要求执行工作时，先选择适合的员工。', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { type: 'function', name: 'start_work', description: '仅在用户要求你执行工作时启动 Workmate 后台任务。提交完整工作目标，默认使用当前对话和员工。返回 accepted 只代表已接受，不代表完成。', parameters: { type: 'object', properties: { objective: { type: 'string', description: '用户要求的完整目标与交付物' }, employeeId: { type: 'string', description: '仅需指定其他员工时填写 discover_capabilities 返回的员工 ID，省略使用当前对话员工' } }, required: ['objective'], additionalProperties: false } },
  { type: 'function', name: 'get_work_status', description: '查询已提交工作的真实状态。不要编造结果或朗读整份报告。', parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false } },
  { type: 'function', name: 'cancel_work', description: '仅在用户明确要求取消指定工作时调用。用户插话或停止播音不表示取消任务。', parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false } },
];

export const VOICE_WORK_INSTRUCTIONS = '\n你可以通过 Workmate 工具执行用户明确要求的工作。一般聊天直接回答。未指定其他员工时，start_work 省略 employeeId，使用当前对话员工。工作接受后只简短告知已开始；只有 get_work_status 返回 completed 才能宣称已完成。完整结果保存在关联对话，不朗读工作全文。审批需要用户在关联对话操作。打断讲话不取消后台工作。';

type Owner = { orgId: string; userId: string };
export function completionNotice(result: VoiceWorkResult): VoiceWorkNotice | null {
  if (!result.ok || result.status !== 'completed' || !result.taskId) return null;
  const title = String(result.title || '关联工作').replace(/^语音工作[:：]?\s*/, '').replace(/\s+/g, ' ').slice(0, 14) || '关联工作';
  const count = Math.max(0, Number(result.artifactCount) || 0);
  const variants = [
    `任务舱回传：${title}完成，${count ? `${count}份成果已就位。` : ''}你的判断很准！`,
    `好消息，${title}已收官。${count ? `${count}份成果等你检阅，` : ''}漂亮的决策！`,
    `执行链闭环：${title}完成。你的耐心换来了好结果！`,
    `成果已抵达：${title}完成。干得漂亮，去关联对话看看吧！`,
  ];
  const seed = [...result.taskId].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const text = variants[seed % variants.length].slice(0, 50);
  return VoiceWorkNoticeSchema.parse({ type: 'completed', taskId: result.taskId, text });
}
export class VoiceWorkBridge {
  private calls = new Map<string, Promise<unknown>>();
  constructor(private orch: Orchestrator, private owner: Owner, private enabled: () => boolean, private conversationId?: string) {}

  async validateConversation() {
    if (!this.conversationId) return null;
    const session = await this.orch.chat.getChatSession(this.conversationId);
    if (!session || session.orgId !== this.owner.orgId || session.ownerUserId !== this.owner.userId) throw new Error('工作会话不存在或无访问权限。');
    return session;
  }

  async employees() {
    const raw = await this.orch.store.get(`user:${this.owner.userId}:workspace.custom-employees`)
      ?? await this.orch.store.get('workspace.custom-employees');
    const custom: unknown = raw ? JSON.parse(raw) : [];
    const defaults = [{ id: 'general', name: '通用助手' }, { id: 'research', name: '研究助手' }, { id: 'code', name: '编程助手' }];
    const rows = Array.isArray(custom) ? custom.filter((item) => item && typeof item.id === 'string').map((item) => ({ id: String(item.id), name: String(item.name || item.id) })) : [];
    return [...defaults, ...rows].filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index).slice(0, 100);
  }

  call(callId: string, name: string, args: unknown): Promise<unknown> {
    if (!this.enabled()) return Promise.reject(new Error('工作能力关联已关闭。'));
    if (!callId) return Promise.reject(new Error('缺少工具调用 ID。'));
    const cached = this.calls.get(callId); if (cached) return cached;
    if (this.calls.size >= 200) return Promise.reject(new Error('本次通话工具调用已达上限，请重新开始通话。'));
    const result = this.execute(name, args); this.calls.set(callId, result); return result;
  }

  private async binding(taskId: string): Promise<VoiceWorkBinding> {
    const raw = await this.orch.store.get(`voice-work:${taskId}`);
    const row = VoiceWorkBindingSchema.parse(raw ? JSON.parse(raw) : null);
    if (row.orgId !== this.owner.orgId || row.userId !== this.owner.userId) throw new Error('工作任务不存在或无访问权限。');
    return row;
  }

  async status(taskId: string): Promise<VoiceWorkResult> {
    const row = await this.binding(taskId);
    const session = await this.orch.chat.getChatSession(row.conversationId);
    if (!session || session.orgId !== this.owner.orgId || session.ownerUserId !== this.owner.userId) throw new Error('工作会话不可用。');
    // Approval continuation creates a new attempt: track the current attempt in
    // this dedicated work session instead of reporting the parked first run.
    const original = await this.orch.chat.getRun(row.taskId);
    const turnId = row.turnId || original?.turnId;
    const ids = session.messages.filter((item) => item.runId && !item.superseded && turnId && item.turnId === turnId).map((item) => item.runId!);
    const run = await this.orch.chat.getRun(ids.at(-1) || row.taskId);
    if (!run) throw new Error('工作运行记录不可用。');
    const summaries: Record<string, string> = {
      completed: `工作已完成，生成 ${run.artifacts.length} 个产物。请在关联对话的消息和成果附件中查看。`,
      failed: '工作执行失败，请在关联对话查看原因。', cancelled: '工作已取消。',
      'waiting-approval': '工作需要审批，请在关联对话查看并确认。', running: '工作正在执行。', queued: '工作正在排队。',
    };
    return { ok: true, taskId, conversationId: row.conversationId, title: row.title, status: run.status, spokenSummary: summaries[run.status] || '工作状态已更新，请在工作台查看。', artifactCount: run.artifacts.length };
  }

  private async execute(name: string, args: unknown): Promise<unknown> {
    if (name === 'discover_capabilities') return { employees: await this.employees(), note: '员工使用已有授权 Skill 和 MCP；工作需要审批时在工作台确认。' };
    if (name === 'start_work') {
      const input = VoiceWorkStartSchema.parse(args);
      const current = await this.validateConversation();
      const employeeId = input.employeeId || current?.employeeId || 'general';
      if (!(await this.employees()).some((item) => item.id === employeeId)) throw new Error('该员工不可用。');
      const session = current || await this.orch.chat.createChatSession({ title: `语音工作：${input.objective}`.slice(0, 80), employeeId, orgId: this.owner.orgId, ownerUserId: this.owner.userId });
      this.conversationId = session.id;
      const created = await this.orch.chat.sendUserMessage(session.id, { content: input.objective, employeeId, rejectIfActive: true,
        attachmentContext: '交付方式：完整成果保存到工作台和产物文件。最后回复简短说明结果和文件位置，不重复整份交付物。' });
      const row: VoiceWorkBinding = { version: 1, taskId: created.runId, turnId: created.turnId, conversationId: session.id, ...this.owner, employeeId, title: session.title.slice(0, 80), createdAt: Date.now() };
      await this.orch.store.set(`voice-work:${row.taskId}`, JSON.stringify(row));
      return { ok: true, taskId: row.taskId, conversationId: session.id, title: row.title, status: 'accepted', spokenSummary: '工作已接受，结果会显示在关联对话中。你可以继续对话。' } satisfies VoiceWorkResult;
    }
    if (name === 'get_work_status') return this.status(VoiceWorkTaskSchema.parse(args).taskId);
    if (name === 'cancel_work') {
      const { taskId } = VoiceWorkTaskSchema.parse(args); const row = await this.binding(taskId);
      await this.status(taskId); // Check current session ownership before mutation.
      const session = await this.orch.chat.getChatSession(row.conversationId);
      const original = await this.orch.chat.getRun(row.taskId);
      const turnId = row.turnId || original?.turnId;
      const runId = session?.messages.filter((item) => item.runId && !item.superseded && turnId && item.turnId === turnId).at(-1)?.runId || row.taskId;
      const cancelled = await this.orch.chat.abortActiveRun(row.conversationId, runId);
      return cancelled ? { ok: true, taskId, conversationId: row.conversationId, title: row.title, status: 'cancellation_requested', spokenSummary: '已请求停止该工作。' } : this.status(taskId);
    }
    throw new Error('不支持的语音工作工具。');
  }
}
