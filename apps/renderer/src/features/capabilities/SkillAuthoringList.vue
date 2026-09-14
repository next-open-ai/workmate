<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import type { SkillRecord } from '../../app/capabilities';
import { useI18n } from '../../app/i18n';

const props = defineProps<{ skills: SkillRecord[]; canAuthor?: boolean }>();
const emit = defineEmits<{ create: [name: string, description: string]; open: [skill: SkillRecord]; remove: [skill: SkillRecord] }>();

const { t } = useI18n();
const creating = ref(false);
const name = ref('');
const description = ref('');
const query = ref('');
const nameInput = ref<HTMLInputElement | null>(null);

/** 目录名规范化：小写、连字符分隔，与后端受管目录命名保持一致。 */
const canonicalName = computed(() =>
  name.value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/(^-|-$)/g, ''),
);
const duplicate = computed(() =>
  Boolean(canonicalName.value) && props.skills.some((skill) => skill.name.trim().toLowerCase() === canonicalName.value),
);
const canSubmit = computed(() => Boolean(canonicalName.value) && Boolean(description.value.trim()) && !duplicate.value);

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.skills;
  return props.skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(q));
});

async function begin() {
  creating.value = true;
  await nextTick();
  nameInput.value?.focus();
}
function cancel() {
  creating.value = false;
  name.value = '';
  description.value = '';
}
function create() {
  if (!canSubmit.value) return;
  emit('create', canonicalName.value, description.value.trim());
  name.value = '';
  description.value = '';
  creating.value = false;
}
</script>

<template>
  <section class="mx-auto max-w-5xl px-1 pb-10">
    <header class="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div class="min-w-0">
        <p class="text-[11px] font-extrabold tracking-[.12em] text-[var(--accent)]">SKILL AUTHORING</p>
        <h2 class="mt-2 text-2xl font-bold tracking-[-.03em]">智能创建与修改</h2>
        <p class="mt-2 max-w-xl text-sm leading-relaxed text-[var(--muted)]">
          每个 Skill 是一个受管目录；从意图出发，在工作区中与系统管理员协作完成。
        </p>
      </div>
      <button
        v-if="!creating"
        class="shrink-0 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        type="button"
        :disabled="canAuthor === false"
        :title="canAuthor === false ? t('capabilities.adminRequiredHint') : undefined"
        @click="begin"
      >
        ＋ 新增 Skill
      </button>
    </header>

    <!-- 权限提示：以前非管理员看不到任何说明，点按钮静默失败 -->
    <p
      v-if="canAuthor === false"
      class="mb-5 flex items-start gap-2 rounded-xl border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-sm leading-relaxed text-amber-900"
      role="status"
    >
      <span aria-hidden="true">⚠</span>
      <span>{{ t('capabilities.authoringAdminNotice') }}</span>
    </p>

    <form
      v-if="creating"
      class="mb-6 overflow-hidden rounded-2xl border border-[var(--accent)] bg-[var(--surface)] shadow-sm"
      @submit.prevent="create"
    >
      <div class="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
        <div>
          <h3 class="font-bold">创建新的 Skill</h3>
          <p class="mt-1 text-xs leading-relaxed text-[var(--muted)]">
            先创建未保存草案，再进入工作区流式生成 SKILL.md。
          </p>
        </div>
        <button
          class="shrink-0 rounded-lg px-2 py-1 text-sm text-[var(--muted)] transition hover:bg-[var(--surface-muted)]"
          type="button"
          @click="cancel"
        >
          取消
        </button>
      </div>

      <div class="grid gap-4 px-5 py-5 md:grid-cols-2">
        <div class="min-w-0">
          <label class="text-xs font-semibold text-[var(--muted)]" for="skill-name">Skill 名称</label>
          <input
            id="skill-name"
            ref="nameInput"
            v-model="name"
            class="mt-1.5 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm outline-none transition focus:border-[var(--accent)]"
            placeholder="例如 excel-workbench"
            autocomplete="off"
            spellcheck="false"
          />
          <p v-if="duplicate" class="mt-1.5 text-xs font-medium text-rose-600">
            {{ t('capabilities.draftDuplicateHint', { name: canonicalName }) }}
          </p>
          <p v-else class="mt-1.5 text-xs text-[var(--muted)]">
            <template v-if="canonicalName && canonicalName !== name.trim()">
              {{ t('capabilities.namePreviewLabel') }}：<code class="rounded bg-[var(--surface-muted)] px-1 py-0.5">{{ canonicalName }}/</code>
            </template>
            <template v-else>{{ t('capabilities.nameHint') }}</template>
          </p>
        </div>

        <div class="min-w-0">
          <label class="text-xs font-semibold text-[var(--muted)]" for="skill-intent">意图描述</label>
          <input
            id="skill-intent"
            v-model="description"
            class="mt-1.5 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm outline-none transition focus:border-[var(--accent)]"
            placeholder="例如：读取、校验和生成 Excel 报表"
          />
          <p class="mt-1.5 text-xs text-[var(--muted)]">{{ t('capabilities.descriptionHint') }}</p>
        </div>
      </div>

      <div class="flex flex-wrap items-center justify-end gap-3 border-t border-[var(--border)] bg-[var(--surface-muted)]/50 px-5 py-4">
        <p class="mr-auto text-xs text-[var(--muted)]">草案不会立即落盘，进入工作区后确认才写入。</p>
        <button class="rounded-xl px-3 py-2.5 text-sm font-semibold text-[var(--muted)] transition hover:bg-[var(--surface-muted)]" type="button" @click="cancel">
          取消
        </button>
        <button
          class="rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          type="submit"
          :disabled="!canSubmit"
        >
          进入工作区 →
        </button>
      </div>
    </form>

    <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
      <p class="text-sm font-semibold">
        我的 Skill <span class="ml-1 font-normal text-[var(--muted)]">{{ filtered.length }}</span>
      </p>
      <input
        v-model="query"
        class="w-56 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs outline-none transition focus:border-[var(--accent)]"
        placeholder="筛选 Skill…"
        aria-label="筛选 Skill"
      />
    </div>

    <div class="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
      <article
        v-for="skill in filtered"
        :key="skill.id"
        class="group flex items-center gap-4 border-b border-[var(--border)] px-5 py-4 last:border-0 hover:bg-[var(--surface-muted)]/45"
      >
        <div class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--accent-soft)] text-sm font-extrabold text-[var(--accent)]">
          {{ skill.name.slice(0, 1).toUpperCase() }}
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <h3 class="truncate font-semibold">{{ skill.name }}</h3>
            <span class="rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-[10px] font-bold uppercase text-[var(--muted)]">本地</span>
          </div>
          <p class="mt-1 truncate text-sm text-[var(--muted)]">{{ skill.description }}</p>
        </div>
        <div class="hidden text-right text-xs text-[var(--muted)] lg:block">
          <p>SKILL.md</p>
          <p class="mt-1">受管工作区</p>
        </div>
        <button
          v-if="canAuthor !== false"
          class="shrink-0 rounded-lg px-2 py-2 text-sm font-semibold text-rose-600 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
          type="button"
          title="删除 Skill"
          @click="emit('remove', skill)"
        >
          删除
        </button>
        <button
          class="shrink-0 rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-semibold text-[var(--accent)] transition group-hover:border-[var(--accent)]"
          type="button"
          @click="emit('open', skill)"
        >
          {{ canAuthor === false ? '查看' : '打开工作区' }} →
        </button>
      </article>

      <div v-if="!filtered.length" class="px-10 py-12 text-center">
        <p class="text-sm font-semibold">{{ query.trim() ? '没有匹配的 Skill' : '尚未创建 Skill' }}</p>
        <p class="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-[var(--muted)]">
          <template v-if="query.trim()">试试更短的关键词，或清空筛选条件。</template>
          <template v-else-if="canAuthor === false">{{ t('capabilities.authoringAdminNotice') }}</template>
          <template v-else>从一句意图开始，AI 会生成 SKILL.md 初稿，你确认后才写入磁盘。</template>
        </p>
        <button
          v-if="!query.trim() && canAuthor !== false && !creating"
          class="mt-4 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
          type="button"
          @click="begin"
        >
          ＋ 创建第一个 Skill
        </button>
      </div>
    </div>
  </section>
</template>
