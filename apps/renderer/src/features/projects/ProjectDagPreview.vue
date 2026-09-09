<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId } from "vue";

interface DagNode {
  id: string;
  title: string;
  subtitle?: string;
  status?: string;
  dependsOn?: string[];
}

type EdgeState = "idle" | "pending" | "active" | "done" | "failed";

const props = defineProps<{
  tasks: DagNode[];
  compact?: boolean;
  /** Ultra-small preview for chat auto-schedule rail. */
  mini?: boolean;
  /** Hide the DAG FLOW header bar. */
  bare?: boolean;
  /** Keep ambient data-flow motion while the schedule is live. */
  live?: boolean;
}>();

const uid = useId().replace(/:/g, "");
const gradId = `dag-grad-${uid}`;
const gradDoneId = `dag-grad-done-${uid}`;
const arrowId = `dag-arrow-${uid}`;
const arrowDoneId = `dag-arrow-done-${uid}`;
const clipId = `dag-clip-${uid}`;

const NODE_W = 124;
const NODE_H = 68;
const NODE_HALF_W = NODE_W / 2;

function truncateLabel(text: string, max: number) {
  const value = String(text || "").trim();
  if (!value) return "";
  return value.length > max ? `${value.slice(0, Math.max(1, max - 1))}…` : value;
}

function edgeStatus(sourceStatus?: string, targetStatus?: string): EdgeState {
  if (targetStatus === "failed" || targetStatus === "cancelled") return "failed";
  if (targetStatus === "running") return "active";
  // Upstream finished → downstream waiting: data is being handed off.
  if (sourceStatus === "completed" && (targetStatus === "queued" || targetStatus === "draft")) return "active";
  if (sourceStatus === "completed" && targetStatus === "completed") return "done";
  if (sourceStatus === "running") return "pending";
  if (props.live && (targetStatus === "queued" || targetStatus === "draft" || !targetStatus)) return "pending";
  return "idle";
}

function edgeStroke(status: EdgeState) {
  if (status === "failed") return "rgba(244,63,94,0.85)";
  if (status === "done") return `url(#${gradDoneId})`;
  if (status === "active") return `url(#${gradId})`;
  if (status === "pending") return "rgba(96,165,250,0.72)";
  return "rgba(148,163,184,0.38)";
}

function edgeMarker(status: EdgeState) {
  if (status === "done") return `url(#${arrowDoneId})`;
  if (status === "failed") return `url(#${arrowId})`;
  return `url(#${arrowId})`;
}

function edgeParticles(status: EdgeState) {
  if (status === "active") return 3;
  if (status === "done" || status === "pending") return 2;
  return 0;
}

function particleFill(status: EdgeState, index: number) {
  if (status === "done") return index === 0 ? "rgba(16,185,129,0.95)" : "rgba(52,211,153,0.75)";
  if (status === "pending") return "rgba(147,197,253,0.85)";
  return index === 0 ? "rgba(96,165,250,1)" : index === 1 ? "rgba(129,140,248,0.95)" : "rgba(45,212,191,0.9)";
}

function particleDur(status: EdgeState) {
  if (props.mini) {
    if (status === "active") return "1.35s";
    if (status === "done") return "2.4s";
    return "2.8s";
  }
  if (status === "active") return props.compact ? "1.55s" : "1.85s";
  if (status === "done") return "2.8s";
  return "3.2s";
}

const normalizedTasks = computed(() =>
  props.tasks.map((task, index) => ({
    id: task.id || `task-${index}`,
    title: task.title || `任务 ${index + 1}`,
    titleShort: truncateLabel(task.title || `任务 ${index + 1}`, props.mini ? 5 : props.compact ? 7 : 9),
    subtitle: task.subtitle || "",
    subtitleShort: truncateLabel(task.subtitle || "", props.mini ? 5 : props.compact ? 6 : 8),
    status: task.status || "draft",
    dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn : [],
  })),
);

const layers = computed(() => {
  const depth = new Map<string, number>();
  const byId = new Map(normalizedTasks.value.map((task) => [task.id, task]));
  const visit = (id: string, stack = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (stack.has(id)) return 0;
    stack.add(id);
    const task = byId.get(id);
    const value = Math.max(0, ...((task?.dependsOn ?? []).map((dep) => visit(dep, stack) + 1)));
    stack.delete(id);
    depth.set(id, value);
    return value;
  };
  normalizedTasks.value.forEach((task) => visit(task.id));
  return depth;
});

const nodes = computed(() => {
  const groups = new Map<number, Array<(typeof normalizedTasks.value)[number]>>();
  for (const task of normalizedTasks.value) {
    const layer = layers.value.get(task.id) ?? 0;
    const list = groups.get(layer) ?? [];
    list.push(task);
    groups.set(layer, list);
  }
  const columnGap = props.mini ? 140 : props.compact ? 168 : 196;
  const rowGap = props.mini ? 78 : props.compact ? 96 : 116;
  const baseY = props.mini ? 54 : props.compact ? 70 : 88;
  const padX = 28;
  const result = normalizedTasks.value.map((task) => {
    const layer = layers.value.get(task.id) ?? 0;
    const column = groups.get(layer) ?? [task];
    const row = column.findIndex((item) => item.id === task.id);
    const height = (column.length - 1) * rowGap;
    return {
      ...task,
      x: padX + NODE_HALF_W + layer * columnGap,
      y: baseY + row * rowGap - height / 2,
    };
  });
  const maxX = Math.max(NODE_W, ...result.map((item) => item.x + NODE_HALF_W));
  const maxY = Math.max(NODE_H, ...result.map((item) => item.y + NODE_H / 2 + 12));
  return {
    items: result,
    width: Math.max(320, maxX + padX),
    height: Math.max(props.mini ? 96 : props.compact ? 200 : 280, maxY + 16),
  };
});

const edges = computed(() => {
  const byId = new Map(nodes.value.items.map((task) => [task.id, task]));
  return nodes.value.items.flatMap((task) =>
    (task.dependsOn ?? [])
      .map((depId) => {
        const source = byId.get(depId);
        if (!source) return null;
        const dx = Math.max(48, (task.x - source.x) / 2);
        const d = `M ${source.x + NODE_HALF_W} ${source.y} C ${source.x + dx} ${source.y}, ${task.x - dx} ${task.y}, ${task.x - NODE_HALF_W} ${task.y}`;
        return { id: `${depId}->${task.id}`, d, status: edgeStatus(source.status, task.status) };
      })
      .filter(Boolean) as Array<{ id: string; d: string; status: EdgeState }>,
  );
});

const flowParticles = computed(() =>
  edges.value.flatMap((edge) => {
    const count = edgeParticles(edge.status);
    return Array.from({ length: count }, (_, index) => ({
      key: `${edge.id}-p${index}`,
      d: edge.d,
      status: edge.status,
      r: edge.status === "active" ? (index === 0 ? 4.2 : 3.2) : 2.8,
      fill: particleFill(edge.status, index),
      dur: particleDur(edge.status),
      // Stagger particles along the path via begin offset.
      begin: `${(index * 0.45).toFixed(2)}s`,
    }));
  }),
);

const statusClass = (status?: string) =>
  ({
    completed: "dag-status-completed",
    running: "dag-status-running",
    failed: "dag-status-failed",
    cancelled: "dag-status-failed",
    queued: "dag-status-queued",
    stale: "dag-status-stale",
    draft: "dag-status-queued",
  })[status || "draft"] ?? "dag-status-queued";

const viewport = ref<HTMLElement | null>(null);
const dragging = ref(false);
let dragPointerId: number | null = null;
let dragOriginX = 0;
let dragOriginY = 0;
let dragScrollLeft = 0;
let dragScrollTop = 0;

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0 || !viewport.value) return;
  const target = event.target as Element | null;
  if (target?.closest?.("button, a, input, textarea, select")) return;
  dragging.value = true;
  dragPointerId = event.pointerId;
  dragOriginX = event.clientX;
  dragOriginY = event.clientY;
  dragScrollLeft = viewport.value.scrollLeft;
  dragScrollTop = viewport.value.scrollTop;
  viewport.value.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function onPointerMove(event: PointerEvent) {
  if (!dragging.value || !viewport.value || event.pointerId !== dragPointerId) return;
  viewport.value.scrollLeft = dragScrollLeft - (event.clientX - dragOriginX);
  viewport.value.scrollTop = dragScrollTop - (event.clientY - dragOriginY);
}

function endDrag(event: PointerEvent) {
  if (event.pointerId !== dragPointerId) return;
  dragging.value = false;
  dragPointerId = null;
  try {
    viewport.value?.releasePointerCapture(event.pointerId);
  } catch {
    /* already released */
  }
}

onBeforeUnmount(() => {
  dragging.value = false;
  dragPointerId = null;
});
</script>

<template>
  <div class="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
    <div v-if="!bare && !mini" class="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
      <div>
        <p class="text-[10px] font-bold tracking-[0.14em] text-[var(--accent)]">DAG FLOW</p>
        <h3 class="text-sm font-bold">任务依赖与数据流</h3>
      </div>
      <div class="flex items-center gap-2">
        <span class="hidden text-[10px] text-[var(--muted)] sm:inline">可滚动 · 拖动画布</span>
        <span class="rounded-full bg-[var(--surface-muted)] px-2.5 py-1 text-[10px] font-semibold text-[var(--muted)]">{{ tasks.length }} 个节点</span>
      </div>
    </div>

    <div
      ref="viewport"
      :class="[
        'dag-viewport relative overflow-auto bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.10),transparent_42%),linear-gradient(180deg,rgba(15,23,42,0.02),transparent)]',
        dragging ? 'dag-dragging cursor-grabbing' : 'cursor-grab',
        live ? 'dag-live' : '',
      ]"
      :style="{ height: mini ? '108px' : compact ? '220px' : '300px' }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="endDrag"
      @pointercancel="endDrag"
    >
      <svg
        :width="nodes.width"
        :height="nodes.height"
        :viewBox="`0 0 ${nodes.width} ${nodes.height}`"
        class="block select-none"
        fill="none"
      >
        <defs>
          <linearGradient :id="gradId" x1="0" y1="0" :x2="nodes.width" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stop-color="rgba(99,102,241,0.35)" />
            <stop offset="45%" stop-color="rgba(59,130,246,1)" />
            <stop offset="100%" stop-color="rgba(45,212,191,0.9)" />
          </linearGradient>
          <linearGradient :id="gradDoneId" x1="0" y1="0" :x2="nodes.width" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stop-color="rgba(16,185,129,0.35)" />
            <stop offset="50%" stop-color="rgba(52,211,153,0.95)" />
            <stop offset="100%" stop-color="rgba(16,185,129,0.75)" />
          </linearGradient>
          <marker :id="arrowId" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="rgba(59,130,246,0.95)" />
          </marker>
          <marker :id="arrowDoneId" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="rgba(16,185,129,0.95)" />
          </marker>
          <clipPath :id="clipId">
            <rect :width="NODE_W - 20" :height="40" rx="4" />
          </clipPath>
          <filter :id="`dag-glow-${uid}`" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="2.2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <g>
          <path
            v-for="edge in edges"
            :key="`${edge.id}-glow`"
            :d="edge.d"
            :stroke="edge.status === 'failed' ? 'rgba(244,63,94,0.2)' : edge.status === 'done' ? 'rgba(16,185,129,0.18)' : 'rgba(59,130,246,0.2)'"
            stroke-width="11"
            stroke-linecap="round"
          />
          <path
            v-for="edge in edges"
            :key="edge.id"
            :d="edge.d"
            :class="['dag-edge', `dag-edge-${edge.status}`]"
            :stroke="edgeStroke(edge.status)"
            :marker-end="edgeMarker(edge.status)"
            :filter="edge.status === 'active' || edge.status === 'done' ? `url(#dag-glow-${uid})` : undefined"
          />
          <circle
            v-for="particle in flowParticles"
            :key="particle.key"
            :r="particle.r"
            :fill="particle.fill"
            opacity="0.95"
          >
            <animateMotion
              :dur="particle.dur"
              :begin="particle.begin"
              repeatCount="indefinite"
              :path="particle.d"
            />
          </circle>
        </g>

        <g v-for="node in nodes.items" :key="node.id" :transform="`translate(${node.x - NODE_HALF_W}, ${node.y - NODE_H / 2})`">
          <title>{{ node.title }}{{ node.subtitle ? ` · ${node.subtitle}` : '' }}</title>
          <rect :width="NODE_W" :height="NODE_H" rx="18" class="dag-node-shadow" />
          <rect :width="NODE_W" :height="NODE_H" rx="18" :class="['dag-node-surface', `dag-node-${node.status || 'draft'}`]" />
          <rect
            v-if="node.status === 'running'"
            x="-3"
            y="-3"
            :width="NODE_W + 6"
            :height="NODE_H + 6"
            rx="21"
            class="dag-node-running-aura"
          />
          <rect
            v-else-if="node.status === 'completed'"
            x="-2"
            y="-2"
            :width="NODE_W + 4"
            :height="NODE_H + 4"
            rx="20"
            class="dag-node-done-aura"
          />
          <circle cx="16" cy="16" r="5" :class="statusClass(node.status)" />
          <circle v-if="node.status === 'running'" cx="16" cy="16" r="8" class="dag-status-running-ring" />
          <foreignObject x="10" y="26" :width="NODE_W - 20" :height="36">
            <div xmlns="http://www.w3.org/1999/xhtml" class="dag-label-box">
              <div class="dag-label-title" :title="node.title">{{ node.titleShort }}</div>
              <div v-if="node.subtitleShort" class="dag-label-subtitle" :title="node.subtitle">{{ node.subtitleShort }}</div>
            </div>
          </foreignObject>
        </g>
      </svg>
    </div>
  </div>
</template>

<style scoped>
.dag-viewport {
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  touch-action: pan-x pan-y;
}

.dag-dragging {
  user-select: none;
}

.dag-edge {
  stroke-width: 2.6;
  stroke-dasharray: 10 7;
  stroke-linecap: round;
  fill: none;
}

.dag-edge-idle {
  stroke-dasharray: 6 8;
}

.dag-edge-pending {
  stroke-dasharray: 8 6;
  animation: dag-flow 2.6s linear infinite;
}

.dag-edge-active {
  stroke-width: 3;
  stroke-dasharray: 12 8;
  animation: dag-flow 1.6s linear infinite;
}

.dag-edge-done {
  stroke-width: 2.6;
  stroke-dasharray: 9 6;
  animation: dag-flow 3.2s linear infinite;
}

.dag-edge-failed {
  stroke-dasharray: 5 7;
}

.dag-node-shadow {
  fill: rgba(59, 130, 246, 0.08);
}

.dag-node-surface {
  fill: color-mix(in srgb, var(--surface) 88%, rgb(59 130 246 / 12%));
  stroke: color-mix(in srgb, var(--border) 72%, rgb(59 130 246 / 28%));
  stroke-width: 1.5;
}

.dag-node-completed {
  stroke: rgba(16, 185, 129, 0.45);
}

.dag-node-running {
  stroke: rgba(59, 130, 246, 0.65);
}

.dag-node-failed,
.dag-node-cancelled {
  stroke: rgba(244, 63, 94, 0.45);
}

.dag-node-running-aura {
  fill: none;
  stroke: rgba(96, 165, 250, 0.42);
  stroke-width: 2;
  stroke-dasharray: 8 5;
  animation: dag-orbit 2s linear infinite;
}

.dag-node-done-aura {
  fill: none;
  stroke: rgba(16, 185, 129, 0.22);
  stroke-width: 1.5;
  stroke-dasharray: 4 10;
  animation: dag-orbit 4.5s linear infinite;
}

.dag-label-box {
  width: 100%;
  overflow: hidden;
  pointer-events: none;
  font-family: inherit;
}

.dag-label-title,
.dag-label-subtitle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.2;
}

.dag-label-title {
  color: var(--text);
  font-size: 11px;
  font-weight: 700;
}

.dag-label-subtitle {
  margin-top: 3px;
  color: var(--muted);
  font-size: 10px;
}

.dag-status-completed { fill: rgb(16 185 129); }
.dag-status-running { fill: rgb(59 130 246); animation: dag-dot 1.2s ease-in-out infinite; }
.dag-status-running-ring {
  fill: none;
  stroke: rgba(59, 130, 246, 0.4);
  stroke-width: 2;
  animation: dag-ping 1.5s ease-out infinite;
}
.dag-status-failed { fill: rgb(244 63 94); }
.dag-status-queued { fill: rgb(148 163 184); }
.dag-status-stale { fill: rgb(245 158 11); }

.dag-live::after {
  content: "";
  pointer-events: none;
  position: absolute;
  inset: 0;
  background: linear-gradient(110deg, transparent 35%, rgba(59, 130, 246, 0.07) 50%, transparent 65%);
  background-size: 220% 100%;
  animation: dag-scan 2.8s ease-in-out infinite;
}

@keyframes dag-flow {
  from { stroke-dashoffset: 0; }
  to { stroke-dashoffset: -240; }
}

@keyframes dag-dot {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 1; }
}

@keyframes dag-ping {
  0% { opacity: 0.85; transform: scale(0.92); transform-origin: center; }
  100% { opacity: 0; transform: scale(1.65); transform-origin: center; }
}

@keyframes dag-orbit {
  to { stroke-dashoffset: -52; }
}

@keyframes dag-scan {
  0% { background-position: 120% 0; }
  100% { background-position: -120% 0; }
}
</style>
