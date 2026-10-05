<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Core, ElementDefinition, EventObjectNode, LayoutOptions } from 'cytoscape';

type GraphNode = { id: string; type: string; name: string; aliases?: string[]; properties?: Record<string, unknown>; source?: string; status?: string };
type GraphEdge = { id: string; subjectId: string; predicate: string; objectId: string; properties?: Record<string, unknown>; source?: string; status?: string };
type SelectedItem = { kind: 'node'; value: GraphNode } | { kind: 'edge'; value: GraphEdge };

const props = withDefaults(defineProps<{ graph?: { version: number; nodes: unknown[]; edges: unknown[] }; title?: string; compact?: boolean }>(), { title: '正式本体关系图', compact: false });
const graphPanel = ref<HTMLElement | null>(null);
const container = ref<HTMLDivElement | null>(null);
const loading = ref(false);
const error = ref('');
const fullscreenError = ref('');
const isFullscreen = ref(false);
const query = ref('');
const layoutName = ref<'cose' | 'breadthfirst' | 'circle'>('cose');
const selected = ref<SelectedItem | null>(null);
let cy: Core | null = null;
let resizeObserver: ResizeObserver | null = null;
let resizeFrame = 0;
let hasUsableSize = false;
let resizeNeedsLayout = false;
const MAX_NODES = 300;

const nodes = computed(() => (props.graph?.nodes || []) as GraphNode[]);
const edges = computed(() => (props.graph?.edges || []) as GraphEdge[]);
const nodeById = computed(() => new Map(nodes.value.map((node) => [node.id, node])));
const types = computed(() => [...new Set(nodes.value.map((node) => node.type))].sort((a, b) => a.localeCompare(b, 'zh-CN')));
const isLimited = computed(() => nodes.value.length > MAX_NODES);
const shownNodeIds = computed(() => {
  const connected = new Set(edges.value.flatMap((edge) => [edge.subjectId, edge.objectId]));
  return new Set([...nodes.value].sort((a, b) => Number(connected.has(b.id)) - Number(connected.has(a.id))).slice(0, MAX_NODES).map((node) => node.id));
});
const visibleNodes = computed(() => nodes.value.filter((node) => shownNodeIds.value.has(node.id)));
const visibleEdges = computed(() => edges.value.filter((edge) => shownNodeIds.value.has(edge.subjectId) && shownNodeIds.value.has(edge.objectId)));

const palette = ['#4f6be8', '#0891b2', '#059669', '#d97706', '#9333ea', '#e11d48', '#475569', '#0d9488'];
function colorForType(type: string) { const index = Math.max(0, types.value.indexOf(type)); return palette[index % palette.length]; }
function nodeName(id: string) { return nodeById.value.get(id)?.name || id; }
function layoutOptions(): LayoutOptions {
  if (layoutName.value === 'breadthfirst') return { name: 'breadthfirst', directed: true, padding: 36, spacingFactor: 1.15, animate: false };
  if (layoutName.value === 'circle') return { name: 'circle', padding: 36, spacingFactor: 1.1, animate: false };
  return { name: 'cose', padding: 36, nodeRepulsion: () => 9000, idealEdgeLength: () => 105, edgeElasticity: () => 80, gravity: 0.35, numIter: 700, animate: false };
}
function elements(): ElementDefinition[] {
  return [
    ...visibleNodes.value.map((node) => ({ data: { id: node.id, label: node.name, type: node.type, color: colorForType(node.type) } })),
    ...visibleEdges.value.map((edge) => ({ data: { id: edge.id, source: edge.subjectId, target: edge.objectId, label: edge.predicate } })),
  ];
}
function sizeIsUsable() { return Boolean(container.value && container.value.clientWidth > 40 && container.value.clientHeight > 40); }
function refreshCanvas(runLayout = false) {
  if (!cy || !sizeIsUsable()) return;
  cy.resize();
  if (runLayout) cy.layout(layoutOptions()).run();
  cy.fit(undefined, 42);
}
function scheduleCanvasRefresh(runLayout = false) {
  resizeNeedsLayout ||= runLayout;
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    const firstUsableSize = !hasUsableSize && sizeIsUsable();
    if (firstUsableSize) hasUsableSize = true;
    const shouldRunLayout = resizeNeedsLayout || firstUsableSize;
    resizeNeedsLayout = false;
    refreshCanvas(shouldRunLayout);
  });
}
async function renderGraph() {
  if (!container.value || !visibleNodes.value.length) { cy?.destroy(); cy = null; return; }
  loading.value = true; error.value = '';
  try {
    const { default: cytoscape } = await import('cytoscape');
    cy?.destroy();
    hasUsableSize = sizeIsUsable();
    cy = cytoscape({
      container: container.value,
      elements: elements(),
      layout: layoutOptions(),
      minZoom: 0.15,
      maxZoom: 3,
      wheelSensitivity: 0.18,
      style: [
        { selector: 'node', style: { 'background-color': 'data(color)', label: 'data(label)', color: '#172033', 'font-size': 11, 'font-weight': 600, 'text-wrap': 'ellipsis', 'text-max-width': '108px', 'text-valign': 'bottom', 'text-margin-y': 8, width: 30, height: 30, 'border-width': 3, 'border-color': '#ffffff', 'overlay-opacity': 0 } },
        { selector: 'edge', style: { width: 1.5, 'line-color': '#aeb8cc', 'target-arrow-color': '#8290aa', 'target-arrow-shape': 'triangle', 'curve-style': 'bezier', label: 'data(label)', color: '#667085', 'font-size': 9, 'text-background-color': '#ffffff', 'text-background-opacity': 0.9, 'text-background-padding': '3px', 'text-rotation': 'autorotate', 'overlay-opacity': 0 } },
        { selector: 'node:selected', style: { 'border-color': '#243fd0', 'border-width': 4, 'background-blacken': -0.08 } },
        { selector: 'edge:selected', style: { width: 3, 'line-color': '#4f6be8', 'target-arrow-color': '#4f6be8' } },
        { selector: '.faded', style: { opacity: 0.12 } },
        { selector: '.focus', style: { 'border-color': '#f59e0b', 'border-width': 5, 'z-index': 10 } },
      ],
    });
    cy.on('tap', 'node', (event: EventObjectNode) => { const value = nodeById.value.get(event.target.id()); if (value) selected.value = { kind: 'node', value }; });
    cy.on('tap', 'edge', (event) => { const value = edges.value.find((edge) => edge.id === event.target.id()); if (value) selected.value = { kind: 'edge', value }; });
    cy.on('tap', (event) => { if (event.target === cy) selected.value = null; });
    scheduleCanvasRefresh(true);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { loading.value = false; }
}
function runLayout() { scheduleCanvasRefresh(true); }
function fit() { scheduleCanvasRefresh(false); }
function zoom(delta: number) { if (!cy) return; cy.zoom({ level: Math.min(3, Math.max(0.15, cy.zoom() + delta)), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }); }
function syncFullscreenState() {
  isFullscreen.value = document.fullscreenElement === graphPanel.value;
  scheduleCanvasRefresh(false);
}
async function toggleFullscreen() {
  fullscreenError.value = '';
  try {
    if (document.fullscreenElement === graphPanel.value) await document.exitFullscreen();
    else await graphPanel.value?.requestFullscreen();
  } catch (cause) {
    fullscreenError.value = cause instanceof Error ? cause.message : '无法进入全屏模式。';
  }
}
function focusQuery() {
  if (!cy) return;
  const keyword = query.value.trim().toLocaleLowerCase();
  cy.elements().removeClass('faded focus');
  if (!keyword) { cy.fit(undefined, 42); return; }
  const matches = cy.nodes().filter((node) => {
    const source = nodeById.value.get(node.id());
    return [source?.name, source?.type, ...(source?.aliases || [])].some((value) => String(value || '').toLocaleLowerCase().includes(keyword));
  });
  if (!matches.length) return;
  const neighborhood = matches.closedNeighborhood();
  cy.elements().difference(neighborhood).addClass('faded');
  matches.addClass('focus');
  cy.fit(neighborhood, 70);
  if (matches.length === 1) { const value = nodeById.value.get(matches[0].id()); if (value) selected.value = { kind: 'node', value }; }
}

watch(() => props.graph, async () => { await nextTick(); await renderGraph(); }, { deep: true });
watch(layoutName, runLayout);
onMounted(async () => {
  document.addEventListener('fullscreenchange', syncFullscreenState);
  resizeObserver = new ResizeObserver(() => scheduleCanvasRefresh(false));
  if (container.value) resizeObserver.observe(container.value);
  await nextTick();
  await renderGraph();
});
onBeforeUnmount(() => { document.removeEventListener('fullscreenchange', syncFullscreenState); resizeObserver?.disconnect(); cancelAnimationFrame(resizeFrame); cy?.destroy(); });
</script>

<template>
  <section ref="graphPanel" :class="['overflow-hidden border border-[var(--border)] bg-[var(--surface)]', isFullscreen ? 'flex h-screen w-screen flex-col rounded-none' : 'rounded-2xl']">
    <header class="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
      <div><div class="flex items-center gap-2"><span class="grid h-8 w-8 place-items-center rounded-xl bg-indigo-600 text-white">◎</span><h3 class="font-semibold">{{ title }}</h3><span v-if="graph" class="rounded-full bg-[var(--surface-muted)] px-2.5 py-1 text-[11px]">v{{ graph.version }}</span></div><p class="mt-2 text-xs text-[var(--muted)]">点击节点或连线查看详情，搜索可定位相关区域。</p></div>
      <div class="flex flex-wrap items-center justify-end gap-2 text-xs"><span class="rounded-full bg-indigo-50 px-2.5 py-1.5 text-indigo-700">{{ nodes.length }} 个实体</span><span class="rounded-full bg-cyan-50 px-2.5 py-1.5 text-cyan-700">{{ edges.length }} 条关系</span><button v-if="graph && nodes.length" type="button" class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 font-semibold transition hover:border-[var(--accent)] hover:text-[var(--accent)]" :title="isFullscreen ? '退出全屏（Esc）' : '全屏查看关系图'" @click="toggleFullscreen">{{ isFullscreen ? '退出全屏' : '⛶ 全屏查看' }}</button></div>
    </header>
    <div v-if="!graph || !nodes.length" class="px-5 py-14 text-center"><div class="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-[var(--surface-muted)] text-xl text-[var(--muted)]">◎</div><p class="mt-3 text-sm font-semibold">正式图谱还是空的</p><p class="mt-1 text-xs text-[var(--muted)]">请先接受候选并批准写入，关系图会自动显示已确认的数据。</p></div>
    <template v-else>
      <div class="flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-muted)]/30 px-4 py-3">
        <form class="flex min-w-64 flex-1 gap-2" @submit.prevent="focusQuery"><input v-model="query" class="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs outline-none focus:border-[var(--accent)]" placeholder="搜索实体名称、别名或类型" /><button class="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white">定位</button></form>
        <select v-model="layoutName" class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs"><option value="cose">关系布局</option><option value="breadthfirst">层级布局</option><option value="circle">环形布局</option></select>
        <div class="flex overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]"><button class="border-r border-[var(--border)] px-3 py-2 text-xs" title="缩小" @click="zoom(-0.18)">−</button><button class="border-r border-[var(--border)] px-3 py-2 text-xs" title="适应画布" @click="fit">居中</button><button class="px-3 py-2 text-xs" title="放大" @click="zoom(0.18)">＋</button></div>
      </div>
      <div v-if="isLimited" class="border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-800">图谱共有 {{ nodes.length }} 个实体。为保证交互流畅，当前优先显示有关系的前 {{ MAX_NODES }} 个实体。</div>
      <div v-if="fullscreenError" class="border-b border-rose-200 bg-rose-50 px-5 py-2 text-xs text-rose-800">无法切换全屏：{{ fullscreenError }}</div>
      <div :class="['grid min-h-0 lg:grid-cols-[minmax(0,1fr)_290px]', isFullscreen ? 'flex-1' : '']">
        <div class="relative min-h-0 bg-[radial-gradient(circle_at_center,rgba(79,107,232,0.06),transparent_62%)]"><div ref="container" :class="['w-full', isFullscreen ? 'h-full min-h-[420px]' : compact ? 'h-[380px]' : 'h-[520px]']" /><div v-if="loading" class="absolute inset-0 grid place-items-center bg-white/70 text-sm text-[var(--muted)]">正在加载关系图…</div><div v-if="error" class="absolute inset-x-5 top-5 rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-800">关系图加载失败：{{ error }}</div></div>
        <aside :class="['border-t border-[var(--border)] p-4 lg:border-l lg:border-t-0', isFullscreen ? 'overflow-y-auto' : '']">
          <template v-if="selected"><div class="flex items-center justify-between"><span class="rounded-md bg-[var(--accent)]/10 px-2 py-1 text-[10px] font-semibold text-[var(--accent)]">{{ selected.kind === 'node' ? '实体详情' : '关系详情' }}</span><button class="text-xs text-[var(--muted)]" @click="selected = null">关闭</button></div>
            <template v-if="selected.kind === 'node'"><h4 class="mt-3 break-words font-semibold">{{ selected.value.name }}</h4><p class="mt-1 text-xs text-[var(--muted)]">{{ selected.value.type }}</p><div v-if="selected.value.aliases?.length" class="mt-4"><p class="text-[11px] font-semibold text-[var(--muted)]">别名</p><div class="mt-2 flex flex-wrap gap-1.5"><span v-for="alias in selected.value.aliases" :key="alias" class="rounded-md bg-[var(--surface-muted)] px-2 py-1 text-[11px]">{{ alias }}</span></div></div></template>
            <template v-else><p class="mt-3 text-xs leading-relaxed"><strong>{{ nodeName(selected.value.subjectId) }}</strong><span class="mx-2 text-[var(--accent)]">{{ selected.value.predicate }}</span><strong>{{ nodeName(selected.value.objectId) }}</strong></p></template>
            <div v-if="Object.keys(selected.value.properties || {}).length" class="mt-4"><p class="text-[11px] font-semibold text-[var(--muted)]">属性</p><dl class="mt-2 space-y-2 text-xs"><div v-for="(value, key) in selected.value.properties" :key="key" class="rounded-lg bg-[var(--surface-muted)] px-3 py-2"><dt class="text-[10px] text-[var(--muted)]">{{ key }}</dt><dd class="mt-0.5 break-words">{{ value }}</dd></div></dl></div><p v-if="selected.value.source" class="mt-4 break-all border-t border-[var(--border)] pt-3 text-[10px] text-[var(--muted)]">来源：{{ selected.value.source }}</p>
          </template>
          <template v-else><h4 class="text-xs font-semibold">实体类型</h4><div class="mt-3 space-y-2"><div v-for="type in types" :key="type" class="flex items-center justify-between gap-3 text-xs"><span class="flex min-w-0 items-center gap-2"><i class="h-2.5 w-2.5 shrink-0 rounded-full" :style="{ backgroundColor: colorForType(type) }" /><span class="truncate">{{ type }}</span></span><span class="text-[var(--muted)]">{{ nodes.filter((node) => node.type === type).length }}</span></div></div><p class="mt-5 border-t border-[var(--border)] pt-4 text-[11px] leading-relaxed text-[var(--muted)]">拖动画布浏览，滚轮缩放。搜索定位会突出目标实体及其直接关系。</p></template>
        </aside>
      </div>
    </template>
  </section>
</template>
