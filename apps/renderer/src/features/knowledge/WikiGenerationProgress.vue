<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import type { WikiGenerationJob } from '@workmate/contracts';

const props = defineProps<{ job: WikiGenerationJob; label: string; cancelling: boolean; stalled: boolean }>();
const now = ref(Date.now());
const timer = setInterval(() => { now.value = Date.now(); }, 1000);
onBeforeUnmount(() => clearInterval(timer));
const active = computed(() => ['queued', 'running'].includes(props.job.state));
const moving = computed(() => active.value && !props.stalled);
const stage = computed(() => {
  const progress = props.job.progress;
  if (!progress) return '';
  return progress.phase === 'generate' ? `整理资料 · 第 ${progress.batchIndex}/${progress.batchCount} 批`
    : ({ queued: '等待处理', merge: '汇集主题', save: '保存草稿', link: '建立页面链接', done: '草稿准备完成' })[progress.phase];
});
const percent = computed(() => Math.min(100, Math.floor(props.job.processedChunks / Math.max(1, props.job.totalChunks) * 100)));
const elapsed = computed(() => {
  const end = active.value ? now.value : Date.parse(props.job.updatedAt);
  const seconds = Math.max(0, Math.floor((end - Date.parse(props.job.attemptStartedAt ?? props.job.createdAt)) / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
});
const hint = computed(() => props.stalled && active.value ? '进度更新暂时中断，后台任务可能仍在运行。请点击上方“刷新重试”。'
  : props.cancelling && active.value ? '已请求取消，正在等待后台确认；已保存的草稿会保留。'
  : props.job.state === 'queued' ? '任务已提交，正在等待开始处理。'
  : props.job.state === 'running' ? (props.job.processedChunks === 0
    ? '模型正在阅读资料并组织首批内容，返回结果前进度可能暂时不变。无需重复点击生成。'
    : '正在分批整理主题、生成正文并保存草稿。进度按已处理文本块更新，不代表剩余时间。')
  : props.job.state === 'completed' ? '草稿已就绪。打开预览，核对正文和来源后即可发布。'
  : '任务已停止；已保存的草稿可继续查看和核对。');
</script>

<template>
  <section class="generation-card" :class="{ 'is-moving': moving, 'is-warning': ['failed', 'partial', 'interrupted'].includes(job.state) }" aria-label="Wiki 生成进度">
    <div class="generation-heading">
      <div class="generation-title"><span class="generation-symbol" aria-hidden="true">{{ active ? '✦' : job.state === 'completed' ? '✓' : '!' }}</span>
        <div><p class="generation-eyebrow">WIKI · {{ active ? '生成进行中' : '生成结果' }}</p><h3 role="status">{{ label }}</h3></div>
      </div>
      <span class="generation-time">{{ job.attemptStartedAt ? '本次' : '' }}{{ active ? '已等待' : '任务用时' }} {{ elapsed }}</span>
    </div>
    <p v-if="stage" class="generation-stage" role="status"><span class="stage-dot" aria-hidden="true"></span>{{ active ? '当前阶段' : job.state === 'completed' ? '完成阶段' : '停止阶段' }}：{{ stage }}</p>
    <div class="generation-metrics"><span>已处理 <strong>{{ job.processedChunks }}/{{ job.totalChunks }}</strong> 个文本块</span><span>已保存 <strong>{{ job.pageIds.length }}</strong> 页草稿</span><strong>{{ percent }}% <small>文本处理</small></strong></div>
    <div class="generation-track" role="progressbar" aria-label="文本块处理进度" :aria-valuenow="percent" aria-valuemin="0" aria-valuemax="100" :aria-valuetext="`已处理 ${job.processedChunks}/${job.totalChunks} 个文本块`">
      <div class="generation-fill" :style="{ width: `${percent}%` }"></div><div v-if="moving" class="generation-shimmer"></div>
    </div>
    <p class="generation-hint">{{ hint }}</p>
    <div class="generation-actions"><slot /></div>
    <details class="generation-details"><summary>任务详情</summary>
      <dl><dt>任务编号</dt><dd>{{ job.jobId }}</dd><dt>最后更新</dt><dd>{{ new Date(job.updatedAt).toLocaleString() }}</dd>
        <template v-if="job.errorCode"><dt>错误标识</dt><dd>{{ job.errorCode }}</dd></template>
      </dl>
    </details>
  </section>
</template>

<style scoped>
.generation-card { margin-top: 16px; padding: 22px; border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border)); border-radius: 16px; background: linear-gradient(120deg, var(--accent-soft), var(--surface)); box-shadow: 0 5px 18px color-mix(in srgb, var(--accent) 7%, transparent); }
.generation-heading,.generation-title,.generation-metrics { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.generation-heading { justify-content: space-between; }
.generation-symbol { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 13px; background: var(--accent); color: white; font-size: 24px; }
.generation-eyebrow { font-size: 10px; font-weight: 700; letter-spacing: .12em; color: var(--accent); margin-bottom: 5px; }
h3 { font-size: 16px; font-weight: 650; }
.generation-time,.generation-hint { font-size: 12px; color: var(--muted); }
.generation-stage { display: flex; align-items: center; gap: 8px; margin-top: 18px; font-size: 13px; font-weight: 600; }
.stage-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
.generation-details { margin-top: 14px; color: var(--muted); font-size: 11px; }
.generation-details summary { cursor: pointer; width: fit-content; }
.generation-details dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; margin-top: 10px; }
.generation-details dd { overflow-wrap: anywhere; min-width: 0; }
.generation-metrics { margin-top: 22px; font-size: 12px; justify-content: space-between; }
.generation-metrics strong { color: var(--accent); font-variant-numeric: tabular-nums; }
small { font-size: 10px; font-weight: 400; color: var(--muted); }
.generation-track { position: relative; overflow: hidden; height: 10px; border-radius: 99px; background: color-mix(in srgb, var(--accent) 13%, var(--surface)); margin-top: 10px; }
.generation-fill { height: 100%; background: var(--accent); border-radius: inherit; transition: width .5s ease; }
.generation-shimmer { position: absolute; inset: 0; background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 28%, transparent), transparent); transform: translateX(-100%); animation: sweep 2.4s ease-in-out infinite; }
.generation-hint { margin-top: 12px; line-height: 1.7; }
.generation-actions { margin-top: 14px; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; font-size: 12px; }
.is-warning { border-color: #d99d42; }
@keyframes sweep { to { transform: translateX(100%); } }
@media (prefers-reduced-motion: reduce) { .generation-shimmer { animation: none; } .generation-fill { transition: none; } }
@media (max-width: 540px) { .generation-card { padding: 16px; } .generation-metrics { gap: 10px; } }
</style>
