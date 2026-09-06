<script setup lang="ts">
import { computed } from 'vue';
import type { Automation, AutomationRun, AutomationRunTranscript } from '../../app/automations';
import type { Conversation, Employee } from '../../app/workspace';
import type { ToolActivity, ToolApproval } from '../../services/api';
import { useI18n } from '../../app/i18n';
import { employeeDisplayName } from '../../app/employees';

const props = defineProps<{ run: AutomationRun; employees: Employee[]; conversations: Conversation[]; automations: Automation[] }>();
const emit = defineEmits<{ close: []; openConversation: [id: string] }>();

const { t } = useI18n();

const employee = computed(() => props.employees.find((item) => item.id === props.run.employeeId) ?? props.employees[0]);
const durationMs = computed(() => (props.run.finishedAt ? props.run.finishedAt - props.run.startedAt : Date.now() - props.run.startedAt));

function recoverTranscript(run: AutomationRun): AutomationRunTranscript | null {
  const automation = props.automations.find((item) => item.id === run.automationId);
  const prompt = automation?.prompt.trim() ?? '';
  const anchor = run.finishedAt ?? run.startedAt;
  const candidates = [...props.conversations]
    .filter((conv) => conv.employeeId === run.employeeId && Math.abs(conv.updatedAt - anchor) <= 15 * 60 * 1000)
    .sort((left, right) => Math.abs(left.updatedAt - anchor) - Math.abs(right.updatedAt - anchor));
  for (const conv of candidates) {
    const user = conv.messages.find((message) => message.role === 'user');
    if (prompt && user?.content.trim() !== prompt) continue;
    const assistants = conv.messages.filter((message) => message.role === 'assistant');
    const assistant = assistants.at(-1);
    if (!user && !assistant) continue;
    return {
      prompt: user?.content ?? prompt,
      conversationId: conv.id,
      assistantContent: assistant?.content ?? '',
      activities: [...(assistant?.activities ?? [])],
      approvals: [...(assistant?.approvals ?? [])],
      assets: (assistant?.assets ?? []).map((asset) => ({ id: asset.id, name: asset.name, sizeBytes: asset.sizeBytes })),
    };
  }
  return null;
}

const snapshot = computed(() => props.run.transcript ?? recoverTranscript(props.run));
const snapshotRecovered = computed(() => !props.run.transcript && Boolean(snapshot.value));

const activityStats = computed(() => {
  const activities = snapshot.value?.activities ?? [];
  return {
    total: activities.length,
    completed: activities.filter((item) => item.status === 'completed').length,
    failed: activities.filter((item) => item.status === 'failed').length,
  };
});

function formatDate(value: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value);
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function statusLabel(status: AutomationRun['status']) {
  if (status === 'success') return '已完成';
  if (status === 'failed') return '失败';
  return '执行中';
}

function statusClass(status: AutomationRun['status']) {
  if (status === 'success') return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  if (status === 'failed') return 'bg-rose-500/10 text-rose-700 dark:text-rose-300';
  return 'bg-[var(--accent-soft)] text-[var(--accent)]';
}

function toolLabel(toolName: string) {
  const labels: Record<string, string> = {
    load_skill: '加载 Skill',
    read_skill_file: '读取 Skill 文件',
    read_workspace_file: '读取工作区文件',
    write_workspace_file: '写入工作区文件',
    publish_to_project: '发布到项目空间',
    run_skill_script: '执行 Skill 脚本',
    run_workspace_script: '执行工作区脚本',
    fetch_skill_url: '访问网络资源',
    install_python_dependency: '安装 Python 依赖',
    archive_asset: '归档资产',
  };
  return labels[toolName] ?? toolName.replaceAll('_', ' ');
}

function toolIcon(toolName: string) {
  if (/run_.*script|install_python/.test(toolName)) return '⌘';
  if (/write_|read_/.test(toolName)) return '▤';
  if (toolName === 'load_skill') return '◆';
  if (toolName === 'fetch_skill_url') return '↗';
  return '•';
}

function isTerminalStep(toolName: string) {
  return /run_.*script|install_python|write_workspace/.test(toolName);
}

function stateLabel(activity: ToolActivity) {
  return activity.status === 'running' ? '执行中' : activity.status === 'failed' ? '未完成' : '已完成';
}

function stateClass(activity: ToolActivity) {
  if (activity.status === 'failed') return 'text-rose-600';
  if (activity.status === 'running') return 'text-[var(--accent)]';
  return 'text-emerald-600';
}

function cardClass(activity: ToolActivity) {
  if (activity.status === 'failed') return 'border-rose-500/25 bg-rose-500/[0.04]';
  if (activity.status === 'running') return 'border-[var(--accent)]/25 bg-[var(--accent-soft)]/35';
  return 'border-[var(--border)] bg-[var(--surface)]';
}

function approvalLabel(capability: ToolApproval['capability']) {
  const map: Record<ToolApproval['capability'], string> = {
    'workspace-write': '写入运行工作区',
    'script-execution': '执行本地脚本',
    'network-access': '访问网络资源',
  };
  return map[capability];
}

function formatBytes(value: number) {
  return value < 1024 * 1024 ? `${Math.max(1, Math.round(value / 1024))} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
}
</script>

<template>
  <div class="fixed inset-0 z-40 flex justify-end bg-slate-950/40 backdrop-blur-[1px]" @click.self="emit('close')">
    <aside class="flex h-full w-full max-w-2xl flex-col border-l border-[var(--border)] bg-[var(--background)] shadow-2xl">
      <header class="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-6 py-5">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-[10px] font-bold uppercase tracking-[.14em] text-[var(--muted)]">运行记录详情</p>
            <h2 class="mt-1 truncate text-xl font-bold">{{ run.automationName }}</h2>
            <p class="mt-2 text-xs text-[var(--muted)]">
              {{ run.trigger === 'manual' ? '手动运行' : '计划触发' }} · {{ formatDate(run.startedAt) }} · {{ formatDuration(durationMs) }}
            </p>
          </div>
          <button class="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-xl text-[var(--muted)] hover:bg-[var(--surface-muted)]" type="button" aria-label="关闭" @click="emit('close')">×</button>
        </div>
        <div class="mt-4 flex flex-wrap items-center gap-2">
          <span :class="['rounded-lg px-2.5 py-1 text-xs font-semibold', statusClass(run.status)]">{{ statusLabel(run.status) }}</span>
          <span class="rounded-lg bg-[var(--surface-muted)] px-2.5 py-1 text-xs font-medium">{{ employeeDisplayName(employee, t) }}</span>
          <span class="rounded-lg bg-[var(--surface-muted)] px-2.5 py-1 text-xs font-medium text-[var(--muted)]">{{ run.provider }}</span>
        </div>
        <p v-if="run.error" class="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">{{ run.error }}</p>
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5">
        <div class="mb-4 flex items-center justify-between gap-3">
          <div>
            <h3 class="text-sm font-bold">过程快照</h3>
            <p class="mt-0.5 text-xs text-[var(--muted)]">对话回复与工具执行记录，与聊天工作台中的展示一致。</p>
          </div>
          <span v-if="snapshotRecovered" class="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[10px] font-semibold text-[var(--muted)]">已从会话恢复</span>
        </div>

        <div v-if="!snapshot" class="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] px-5 py-14 text-center">
          <span class="grid mx-auto h-12 w-12 place-items-center rounded-2xl bg-[var(--surface-muted)] text-xl">📋</span>
          <p class="mt-4 text-sm font-medium">无法还原本次运行过程</p>
          <p class="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-[var(--muted)]">未找到保存的快照，且本地会话中也没有匹配的对话。请重新运行该任务以生成完整记录。</p>
        </div>

        <template v-else>
          <!-- 一、对话内容 -->
          <section class="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-sm">
            <div class="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface-muted)]/50 px-4 py-3">
              <div class="flex items-center gap-2">
                <span class="grid h-7 w-7 place-items-center rounded-lg bg-[var(--accent-soft)] text-xs text-[var(--accent)]">💬</span>
                <div>
                  <p class="text-sm font-bold">对话内容</p>
                  <p class="text-[11px] text-[var(--muted)]">任务指令与数字员工回复</p>
                </div>
              </div>
            </div>
            <div class="space-y-5 px-4 py-5">
              <article class="flex justify-end">
                <div class="max-w-[94%]">
                  <p class="mb-1 text-right text-[11px] font-medium text-[var(--muted)]">{{ t('chat.you') }} · 任务指令</p>
                  <p class="whitespace-pre-wrap rounded-[16px_6px_16px_16px] bg-[var(--accent-soft)] px-4 py-3 text-sm leading-relaxed">{{ snapshot.prompt }}</p>
                </div>
              </article>

              <article class="flex gap-3">
                <span class="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-[10px] font-extrabold text-white" :style="{ background: employee.color }">{{ employee.initials }}</span>
                <div class="min-w-0 flex-1">
                  <p class="text-[11px] font-medium text-[var(--muted)]">{{ t('chat.assistant') }}</p>
                  <div v-if="snapshot.assistantContent" class="mt-1 whitespace-pre-wrap rounded-[6px_16px_16px_16px] border border-[var(--border)] bg-[var(--surface-muted)]/35 px-4 py-3 text-sm leading-7">{{ snapshot.assistantContent }}</div>
                  <p v-else class="mt-2 rounded-xl border border-dashed border-[var(--border)] px-3 py-4 text-xs text-[var(--muted)]">本次运行未产生文本回复，结果可能体现在下方执行日志或产出文件中。</p>

                  <div v-if="snapshot.approvals.length" class="mt-4 space-y-2">
                    <article v-for="(item, index) in snapshot.approvals" :key="`${item.skillId}-${index}`" class="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
                      <p class="font-bold text-amber-900 dark:text-amber-100">需要批准 · {{ approvalLabel(item.capability) }}</p>
                      <p class="mt-1 leading-relaxed text-[var(--muted)]">{{ item.summary }}</p>
                    </article>
                  </div>

                  <div v-if="snapshot.assets.length" class="mt-4">
                    <p class="text-[10px] font-bold uppercase tracking-[.12em] text-[var(--muted)]">产出文件</p>
                    <ul class="mt-2 space-y-2">
                      <li v-for="asset in snapshot.assets" :key="asset.id" class="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
                        <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--accent-soft)] text-[10px] font-bold text-[var(--accent)]">{{ asset.name.split('.').pop()?.toUpperCase() || 'FILE' }}</span>
                        <div class="min-w-0 flex-1">
                          <p class="truncate text-sm font-semibold">{{ asset.name }}</p>
                          <p class="text-xs text-[var(--muted)]">{{ formatBytes(asset.sizeBytes) }}</p>
                        </div>
                      </li>
                    </ul>
                  </div>
                </div>
              </article>
            </div>
          </section>

          <!-- 二、执行日志 -->
          <section class="mt-5 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-sm">
            <div class="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--surface-muted)]/50 px-4 py-3">
              <div class="flex items-center gap-2">
                <span class="grid h-7 w-7 place-items-center rounded-lg bg-slate-800 text-xs text-slate-100 dark:bg-slate-700">⌘</span>
                <div>
                  <p class="text-sm font-bold">执行日志</p>
                  <p class="text-[11px] text-[var(--muted)]">Shell、脚本、读写文件等工具步骤</p>
                </div>
              </div>
              <div class="flex gap-1.5 text-[10px] font-semibold">
                <span class="rounded-md bg-[var(--surface)] px-2 py-1 text-[var(--muted)]">{{ activityStats.total }} 步</span>
                <span v-if="activityStats.completed" class="rounded-md bg-emerald-500/10 px-2 py-1 text-emerald-700 dark:text-emerald-300">{{ activityStats.completed }} 完成</span>
                <span v-if="activityStats.failed" class="rounded-md bg-rose-500/10 px-2 py-1 text-rose-700 dark:text-rose-300">{{ activityStats.failed }} 异常</span>
              </div>
            </div>

            <div v-if="!snapshot.activities.length" class="px-4 py-10 text-center text-sm text-[var(--muted)]">本次运行没有触发工具调用。</div>

            <ol v-else class="divide-y divide-[var(--border)]">
              <li v-for="(activity, index) in snapshot.activities" :key="`${activity.toolName}-${index}`" class="px-4 py-4">
                <div class="flex gap-3">
                  <div class="flex flex-col items-center">
                    <span
                      :class="[
                        'grid h-8 w-8 shrink-0 place-items-center rounded-lg text-xs font-bold',
                        activity.status === 'failed' ? 'bg-rose-500/15 text-rose-700' : activity.status === 'running' ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
                      ]"
                    >
                      {{ toolIcon(activity.toolName) }}
                    </span>
                    <span v-if="index < snapshot.activities.length - 1" class="mt-1 w-px flex-1 bg-[var(--border)]" aria-hidden="true" />
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <span class="text-[10px] font-bold uppercase tracking-wide text-[var(--muted)]">步骤 {{ index + 1 }}</span>
                        <p class="text-sm font-bold">{{ toolLabel(activity.toolName) }}</p>
                        <code class="mt-0.5 block text-[10px] text-[var(--muted)]">{{ activity.toolName }}</code>
                      </div>
                      <span :class="['rounded-md px-2 py-0.5 text-[11px] font-semibold', stateClass(activity)]">{{ stateLabel(activity) }}</span>
                    </div>
                    <div
                      :class="['mt-3 rounded-xl border p-3', cardClass(activity), isTerminalStep(activity.toolName) ? 'font-mono text-[12px] leading-relaxed' : 'text-xs leading-relaxed']"
                    >
                      <p :class="isTerminalStep(activity.toolName) ? 'whitespace-pre-wrap text-[var(--text)]' : 'text-[var(--muted)]'">{{ activity.summary }}</p>
                    </div>
                  </div>
                </div>
              </li>
            </ol>
          </section>
        </template>
      </div>

      <footer v-if="snapshot?.conversationId" class="shrink-0 border-t border-[var(--border)] bg-[var(--surface)] p-4">
        <button
          class="w-full rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-semibold transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]"
          type="button"
          @click="snapshot.conversationId && emit('openConversation', snapshot.conversationId)"
        >
          在对话工作台中打开完整会话 →
        </button>
      </footer>
    </aside>
  </div>
</template>
