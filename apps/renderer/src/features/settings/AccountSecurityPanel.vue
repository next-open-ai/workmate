<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useAuth } from '../../app/auth';
import { useNotify } from '../../app/notify';
import type { AuthUser } from '../../services/auth';

const props = defineProps<{ currentUser?: AuthUser | null; busy?: boolean }>();

const notify = useNotify();
const {
  mySessions,
  updateMyProfile,
  changeMyPassword,
  refreshMySessions,
  revokeMySession,
  revokeOtherSessions,
} = useAuth();

const profileDraft = ref({ displayName: '' });
const passwordDraft = ref({ oldPassword: '', newPassword: '', confirmPassword: '', revokeOtherSessions: true });
const loadingSessions = ref(false);
const working = ref(false);

const sessionList = computed(() => mySessions.value ?? []);
const currentUserLabel = computed(() => props.currentUser?.displayName || '未登录');
const currentUserMeta = computed(() => props.currentUser ? `@${props.currentUser.username}` : 'anonymous');
const canSaveProfile = computed(() => Boolean(profileDraft.value.displayName.trim()) && profileDraft.value.displayName.trim() !== (props.currentUser?.displayName || ''));
const canChangePassword = computed(() =>
  Boolean(
    passwordDraft.value.oldPassword
    && passwordDraft.value.newPassword.length >= 6
    && passwordDraft.value.newPassword === passwordDraft.value.confirmPassword,
  ),
);

watch(() => props.currentUser, (user) => {
  profileDraft.value.displayName = user?.displayName || '';
  if (user) void loadSessions();
}, { immediate: true });

onMounted(() => {
  if (props.currentUser) void loadSessions();
});

function formatTime(value?: number) {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function clientTypeLabel(value?: string) {
  switch (value) {
    case 'desktop': return '桌面端';
    case 'mobile': return '移动端';
    case 'web': return '网页端';
    default: return '未知客户端';
  }
}

async function loadSessions() {
  if (!props.currentUser) return;
  loadingSessions.value = true;
  try {
    await refreshMySessions();
  } catch (cause) {
    notify.error(cause, '加载登录会话失败');
  } finally {
    loadingSessions.value = false;
  }
}

async function submitProfile() {
  if (!canSaveProfile.value || working.value) return;
  working.value = true;
  try {
    await updateMyProfile({ displayName: profileDraft.value.displayName.trim() });
    notify.success('notify.saved', '账号资料已更新');
  } catch (cause) {
    notify.error(cause, '更新账号资料失败');
  } finally {
    working.value = false;
  }
}

async function submitPassword() {
  if (!canChangePassword.value || working.value) return;
  working.value = true;
  try {
    const result = await changeMyPassword({
      oldPassword: passwordDraft.value.oldPassword,
      newPassword: passwordDraft.value.newPassword,
      revokeOtherSessions: passwordDraft.value.revokeOtherSessions,
    });
    passwordDraft.value = { oldPassword: '', newPassword: '', confirmPassword: '', revokeOtherSessions: true };
    notify.success('notify.saved', result.revokedOtherSessions > 0 ? `密码已更新，已退出 ${result.revokedOtherSessions} 个其他会话` : '密码已更新');
  } catch (cause) {
    notify.error(cause, '修改密码失败');
  } finally {
    working.value = false;
  }
}

async function removeSession(sessionId: string, current: boolean) {
  const message = current
    ? '确定退出当前登录会话吗？退出后将立即返回登录页。'
    : '确定移除此登录会话吗？';
  if (!window.confirm(message)) return;
  working.value = true;
  try {
    const result = await revokeMySession(sessionId);
    if (result.revokedCurrent) {
      notify.success('notify.saved', '当前会话已退出');
      return;
    }
    notify.success('notify.saved', '登录会话已移除');
  } catch (cause) {
    notify.error(cause, '移除登录会话失败');
  } finally {
    working.value = false;
  }
}

async function removeOtherSessions() {
  if (!window.confirm('确定退出其他所有设备/标签页的登录状态吗？')) return;
  working.value = true;
  try {
    const result = await revokeOtherSessions();
    notify.success('notify.saved', result.revokedCount > 0 ? `已退出 ${result.revokedCount} 个其他会话` : '没有其他会话需要退出');
  } catch (cause) {
    notify.error(cause, '退出其他会话失败');
  } finally {
    working.value = false;
  }
}
</script>

<template>
  <section class="space-y-5">
    <section class="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p class="text-[11px] font-extrabold tracking-[.13em] text-[var(--accent)]">ACCOUNT SECURITY</p>
          <h2 class="mt-2 text-2xl font-bold tracking-[-.03em]">账号与安全</h2>
          <p class="mt-2 max-w-2xl text-[13px] leading-relaxed text-[var(--muted)]">
            管理当前登录用户的身份信息、密码和活跃登录会话。普通成员也可以自助完成这些安全操作。
          </p>
        </div>
        <div class="rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 text-sm">
          <p class="font-semibold">{{ currentUserLabel }}</p>
          <p class="mt-1 text-xs text-[var(--muted)]">{{ currentUserMeta }}</p>
          <p class="mt-1 text-xs text-[var(--muted)]">orgId: {{ props.currentUser?.orgId || 'local-org' }}</p>
          <p class="mt-1 text-xs text-[var(--muted)]">角色：{{ props.currentUser?.role === 'admin' ? '管理员' : '成员' }}</p>
        </div>
      </div>
    </section>

    <section class="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <div class="flex items-start justify-between gap-3">
        <div>
          <h3 class="text-lg font-bold">账号资料</h3>
          <p class="mt-1 text-[13px] text-[var(--muted)]">当前阶段仅允许用户修改自己的显示名称；用户名、角色与 orgId 仍由管理员维护。</p>
        </div>
      </div>
      <div class="mt-5 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <input v-model="profileDraft.displayName" class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 text-sm" placeholder="显示名称" />
        <input :value="props.currentUser?.username || ''" disabled class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 text-sm opacity-70" placeholder="用户名" />
      </div>
      <div class="mt-4 flex justify-end">
        <button
          class="min-w-36 rounded-xl bg-[var(--accent)] px-5 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="busy || working || !canSaveProfile"
          type="button"
          @click="submitProfile"
        >
          {{ working ? '处理中…' : '保存资料' }}
        </button>
      </div>
    </section>

    <section class="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <div>
        <h3 class="text-lg font-bold">修改密码</h3>
        <p class="mt-1 text-[13px] text-[var(--muted)]">修改密码时需要校验当前密码。默认会保留当前登录，并退出其他设备/标签页的旧会话。</p>
      </div>
      <div class="mt-5 grid gap-3 lg:grid-cols-3">
        <input v-model="passwordDraft.oldPassword" type="password" class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 text-sm" placeholder="当前密码" />
        <input v-model="passwordDraft.newPassword" type="password" class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 text-sm" placeholder="新密码（至少 6 位）" />
        <input v-model="passwordDraft.confirmPassword" type="password" class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 text-sm" placeholder="确认新密码" />
      </div>
      <label class="mt-4 flex items-center gap-2 text-sm text-[var(--muted)]">
        <input v-model="passwordDraft.revokeOtherSessions" type="checkbox" class="h-4 w-4" />
        修改密码后退出其他设备/标签页上的旧会话
      </label>
      <div class="mt-4 flex justify-end">
        <button
          class="min-w-36 rounded-xl bg-[var(--accent)] px-5 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="busy || working || !canChangePassword"
          type="button"
          @click="submitPassword"
        >
          {{ working ? '处理中…' : '更新密码' }}
        </button>
      </div>
    </section>

    <section class="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 class="text-lg font-bold">登录会话</h3>
          <p class="mt-1 text-[13px] text-[var(--muted)]">查看当前账号在哪些设备或标签页处于登录状态，并按需退出其它会话。</p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold" type="button" :disabled="loadingSessions" @click="loadSessions">
            {{ loadingSessions ? '刷新中…' : '刷新会话' }}
          </button>
          <button class="rounded-xl border border-rose-300 px-4 py-2 text-sm font-semibold text-rose-600 disabled:opacity-50" type="button" :disabled="working || sessionList.length <= 1" @click="removeOtherSessions">
            退出其他会话
          </button>
        </div>
      </div>

      <div class="mt-5 space-y-3">
        <article
          v-for="session in sessionList"
          :key="session.id"
          class="rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)] p-4"
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="space-y-1">
              <div class="flex flex-wrap items-center gap-2">
                <p class="text-base font-semibold">{{ clientTypeLabel(session.clientType) }}</p>
                <span v-if="session.current" class="rounded-full bg-violet-100 px-2.5 py-1 text-[11px] font-semibold text-violet-700">当前会话</span>
              </div>
              <p class="text-xs text-[var(--muted)]">创建时间：{{ formatTime(session.createdAt) }}</p>
              <p class="text-xs text-[var(--muted)]">最近活跃：{{ formatTime(session.lastSeenAt) }}</p>
              <p class="text-xs text-[var(--muted)]">过期时间：{{ formatTime(session.expiresAt) }}</p>
              <p class="break-all text-xs text-[var(--muted)]">{{ session.userAgent || '未记录 User-Agent' }}</p>
            </div>
            <button
              class="rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-semibold text-[var(--muted)] transition hover:bg-[var(--surface)] hover:text-[var(--text)]"
              type="button"
              :disabled="working"
              @click="removeSession(session.id, session.current)"
            >
              {{ session.current ? '退出当前会话' : '移除此会话' }}
            </button>
          </div>
        </article>

        <div v-if="!loadingSessions && sessionList.length === 0" class="rounded-2xl border border-dashed border-[var(--border)] px-4 py-6 text-sm text-[var(--muted)]">
          暂无可展示的登录会话。
        </div>
      </div>
    </section>
  </section>
</template>
