<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { manualHeadings, renderManualHtml } from '../../app/user-manual';

/**
 * 「用户手册」页面：把 docs/user-manual.md 渲染为带目录的阅读视图。
 * 支持外部（如启动引导弹窗）传入锚点自动定位到对应章节。
 */
const props = defineProps<{ anchor?: string | null }>();
const emit = defineEmits<{ 'anchor-consumed': [] }>();

const html = renderManualHtml();
const headings = manualHeadings();
const toc = headings.filter((item) => item.level === 2 || item.level === 3);
const contentRef = ref<HTMLElement | null>(null);

function scrollToId(id: string, behavior: ScrollBehavior = 'smooth') {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior, block: 'start' });
}

function jumpTo(id: string) {
  scrollToId(id);
}

/** 手册内 `[文字](#锚点)` 跳转拦截：平滑滚动到对应章节而非修改页面 hash。 */
function onArticleClick(event: MouseEvent) {
  const link = (event.target as HTMLElement).closest?.('a[href^="#"]');
  if (!link) return;
  const id = decodeURIComponent((link.getAttribute('href') || '').slice(1));
  if (!id) return;
  event.preventDefault();
  scrollToId(id);
}

onMounted(() => {
  const target = props.anchor;
  if (target) {
    // 等待 v-html 注入完成后再定位
    requestAnimationFrame(() => {
      scrollToId(target, 'auto');
      emit('anchor-consumed');
    });
  }
});

watch(
  () => props.anchor,
  (next) => {
    if (!next) return;
    scrollToId(next);
    emit('anchor-consumed');
  },
);
</script>

<template>
  <section class="relative flex h-full flex-col overflow-hidden">
    <div
      class="pointer-events-none absolute inset-0 opacity-80"
      aria-hidden="true"
      style="background:
        radial-gradient(ellipse 70% 45% at 12% -10%, color-mix(in srgb, var(--accent) 18%, transparent), transparent 55%),
        radial-gradient(ellipse 50% 40% at 90% 0%, color-mix(in srgb, var(--accent) 10%, transparent), transparent 50%),
        linear-gradient(180deg, color-mix(in srgb, var(--surface-muted) 55%, transparent), transparent 42%);"
    />

    <header class="relative z-10 shrink-0 border-b border-[var(--border)]/80 bg-[var(--surface)]/80 px-5 py-3 backdrop-blur-md sm:px-8">
      <div class="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
        <div class="min-w-0">
          <p class="text-[10px] font-bold tracking-[0.16em] text-[var(--accent)]">DOCS · USER MANUAL</p>
          <h1 class="truncate text-lg font-semibold tracking-tight sm:text-xl">用户手册</h1>
        </div>
        <p class="text-xs text-[var(--muted)]">应用内帮助文档 · docs/user-manual.md</p>
      </div>
    </header>

    <div class="relative z-10 min-h-0 flex-1 overflow-auto">
      <div class="mx-auto grid max-w-6xl gap-8 px-5 py-6 sm:px-8 lg:grid-cols-[220px_minmax(0,1fr)]">
        <!-- 目录 -->
        <nav v-if="toc.length" class="hidden lg:block" aria-label="手册目录">
          <div class="sticky top-2 max-h-[calc(100vh-140px)] overflow-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)]/90 p-3">
            <p class="px-2 pb-2 text-[11px] font-bold uppercase tracking-[.08em] text-[var(--muted)]">目录</p>
            <ul class="grid gap-0.5">
              <li v-for="item in toc" :key="item.id">
                <button
                  class="w-full truncate rounded-lg px-2 py-1.5 text-left text-[13px] leading-snug text-[var(--muted)] transition hover:bg-[var(--surface-muted)] hover:text-[var(--text)]"
                  :class="item.level === 3 ? 'pl-5 text-xs' : 'font-semibold text-[var(--text)]'"
                  type="button"
                  :title="item.text"
                  @click="jumpTo(item.id)"
                >
                  {{ item.text }}
                </button>
              </li>
            </ul>
          </div>
        </nav>

        <!-- 正文 -->
        <article
          ref="contentRef"
          class="manual-prose min-w-0 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]/90 px-5 py-6 shadow-[0_12px_40px_-28px_rgba(15,23,42,0.45)] sm:px-8"
          @click="onArticleClick"
        >
          <div v-html="html" />
        </article>
      </div>
    </div>
  </section>
</template>

<!-- v-html 注入的内容不受 scoped 样式影响，这里使用带 manual- 前缀的全局类名收敛作用域。 -->
<style>
.manual-prose {
  font-size: 0.875rem;
  line-height: 1.75;
  color: var(--text);
}
.manual-prose .manual-h1 {
  margin: 0 0 0.75rem;
  font-size: 1.625rem;
  font-weight: 800;
  letter-spacing: -0.02em;
}
.manual-prose .manual-h2 {
  margin: 2.25rem 0 0.75rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--border);
  font-size: 1.2rem;
  font-weight: 700;
  letter-spacing: -0.01em;
  scroll-margin-top: 90px;
}
.manual-prose .manual-h3 {
  margin: 1.75rem 0 0.5rem;
  font-size: 1.02rem;
  font-weight: 700;
  scroll-margin-top: 90px;
}
.manual-prose .manual-h4 {
  margin: 1.25rem 0 0.5rem;
  font-size: 0.92rem;
  font-weight: 700;
  scroll-margin-top: 90px;
}
.manual-prose .manual-p {
  margin: 0.6rem 0;
  color: var(--text);
}
.manual-prose strong {
  font-weight: 700;
}
.manual-prose ul.manual-ul,
.manual-prose ol.manual-ol {
  margin: 0.6rem 0;
  padding-left: 1.25rem;
  display: grid;
  gap: 0.35rem;
}
.manual-prose li::marker {
  color: var(--accent);
}
.manual-prose li > ul.manual-ul,
.manual-prose li > ol.manual-ol {
  margin-top: 0.35rem;
}
.manual-prose .manual-code {
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface-muted);
  padding: 1px 5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.8em;
}
.manual-prose pre.manual-pre {
  margin: 0.75rem 0;
  overflow-x: auto;
  border-radius: 12px;
  background: #0f172a;
  padding: 12px 14px;
  color: #e2e8f0;
}
.manual-prose pre.manual-pre code {
  background: transparent;
  border: none;
  padding: 0;
  font-size: 0.8rem;
  line-height: 1.6;
}
.manual-prose .manual-a {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
  transition: opacity 0.15s;
}
.manual-prose .manual-a:hover {
  opacity: 0.85;
}
.manual-prose blockquote.manual-blockquote {
  margin: 0.75rem 0;
  border-left: 3px solid var(--accent);
  border-radius: 0 10px 10px 0;
  background: color-mix(in srgb, var(--surface-muted) 60%, transparent);
  padding: 0.6rem 0.9rem;
}
.manual-prose blockquote.manual-blockquote p {
  margin: 0.25rem 0;
  color: var(--muted);
}
.manual-prose .manual-table-wrap {
  margin: 0.75rem 0;
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: 12px;
}
.manual-prose .manual-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8125rem;
}
.manual-prose .manual-table th,
.manual-prose .manual-table td {
  border-bottom: 1px solid var(--border);
  padding: 8px 12px;
  text-align: left;
}
.manual-prose .manual-table th {
  background: var(--surface-muted);
  font-weight: 600;
}
.manual-prose .manual-table td {
  color: var(--muted);
}
.manual-prose .manual-table tr:last-child td {
  border-bottom: none;
}
.manual-prose .manual-img {
  max-width: 100%;
  border-radius: 12px;
}
.manual-prose .manual-hr {
  margin: 1.75rem 0;
  border: none;
  border-top: 1px solid var(--border);
}
</style>
