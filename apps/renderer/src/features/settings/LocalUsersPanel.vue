<script setup lang="ts">
import { computed, ref } from 'vue';
import type { AuthUser } from '../../services/auth.js';

const props = defineProps<{ currentUser?: AuthUser | null; isAdmin: boolean; users: AuthUser[]; busy?: boolean }>();
const emit = defineEmits<{
  create: [payload: { username: string; displayName: string; password: string; role: 'admin' | 'member' }];
  update: [payload: { userId: string; displayName?: string; password?: string; role?: 'admin' | 'member'; disabled?: boolean }];
  remove: [userId: string];
}>();

const draft = ref({ username: '', displayName: '', password: '', role: 'member' as 'admin' | 'member' });
const passwordDrafts = ref<Record<string, string>>({});
const searchQuery = ref('');
const roleFilter = ref<'all' | 'admin' | 'member'>('all');
const statusFilter = ref<'all' | 'active' | 'disabled'>('all');
const selectedUserId = ref<string | null>(null);
const totalUsers = computed(() => props.users.length);
const adminUsers = computed(() => props.users.filter((item) => item.role === 'admin').length);
const activeUsers = computed(() => props.users.filter((item) => !item.disabled).length);
const currentUserId = computed(() => props.currentUser?.id ?? null);
const currentOrgId = computed(() => props.currentUser?.orgId ?? props.users[0]?.orgId ?? 'local-org');
const canCreate = computed(() =>
  Boolean(draft.value.username.trim() && draft.value.displayName.trim() && draft.value.password.trim().length >= 6),
);
const filteredUsers = computed(() => {
  const keyword = searchQuery.value.trim().toLowerCase();
  return props.users.filter((user) => {
    const matchKeyword = !keyword
      || user.displayName.toLowerCase().includes(keyword)
      || user.username.toLowerCase().includes(keyword)
      || user.orgId.toLowerCase().includes(keyword);
    const matchRole = roleFilter.value === 'all' || user.role === roleFilter.value;
    const matchStatus = statusFilter.value === 'all'
      || (statusFilter.value === 'active' && !user.disabled)
      || (statusFilter.value === 'disabled' && Boolean(user.disabled));
    return matchKeyword && matchRole && matchStatus;
  }).sort((left, right) => {
    const leftCurrent = left.id === currentUserId.value ? 1 : 0;
    const rightCurrent = right.id === currentUserId.value ? 1 : 0;
    if (leftCurrent !== rightCurrent) return rightCurrent - leftCurrent;
    const leftAdmin = left.role === 'admin' ? 1 : 0;
    const rightAdmin = right.role === 'admin' ? 1 : 0;
    if (leftAdmin !== rightAdmin) return rightAdmin - leftAdmin;
    const leftActive = left.disabled ? 0 : 1;
    const rightActive = right.disabled ? 0 : 1;
    if (leftActive !== rightActive) return rightActive - leftActive;
    return (right.lastLoginAt || right.createdAt || 0) - (left.lastLoginAt || left.createdAt || 0);
  });
});
const selectedUser = computed(() => props.users.find((item) => item.id === selectedUserId.value) ?? null);

function resetDraft() {
  draft.value = { username: '', displayName: '', password: '', role: 'member' };
}

function statusTone(user: AuthUser) {
  if (user.disabled) return 'bg-slate-100 text-slate-600';
  return user.role === 'admin' ? 'bg-emerald-100 text-emerald-700' : 'bg-sky-100 text-sky-700';
}

function updateDisplayName(userId: string, event: Event) {
  emit('update', { userId, displayName: (event.target as HTMLInputElement).value });
}

function updateRole(userId: string, event: Event) {
  emit('update', { userId, role: (event.target as HTMLSelectElement).value as 'admin' | 'member' });
}

function updateDisabled(userId: string, event: Event) {
  emit('update', { userId, disabled: (event.target as HTMLInputElement).checked });
}

function submitCreate() {
  if (!canCreate.value) return;
  emit('create', { ...draft.value });
  resetDraft();
}

function resetPassword(userId: string) {
  const password = passwordDrafts.value[userId];
  if (!password) return;
  emit('update', { userId, password });
  passwordDrafts.value[userId] = '';
}

function formatTime(value?: number) {
  if (!value) return '从未登录';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(value);
  } catch {
    return new Date(value).toLocaleString();
  }
}

function confirmRemove(user: AuthUser) {
  if (!window.confirm(`确定删除用户“${user.displayName}”（@${user.username}）吗？此操作会同时清理其本地登录会话。`)) return;
  emit('remove', user.id);
  if (selectedUserId.value === user.id) selectedUserId.value = null;
}

function openUserDetail(user: AuthUser) {
  selectedUserId.value = user.id;
}

function closeUserDetail() {
  selectedUserId.value = null;
}
</script>

<template>
  <section class="space-y-5">
    <section class="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p class="text-[11px] font-extrabold tracking-[.13em] text-[var(--accent)]">LOCAL IDENTITY</p>
          <h2 class="mt-2 text-2xl font-bold tracking-[-.03em]">用户管理</h2>
          <p class="mt-2 max-w-2xl text-[13px] leading-relaxed text-[var(--muted)]">
            当前先提供本地用户、登录会话与 `orgId` 骨架。后续接入远程用户系统时，可在此基础上继续扩展组织、成员同步与权限治理。
          </p>
        </div>
        <div class="rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 text-sm">
          <p class="font-semibold">{{ props.currentUser?.displayName || '未登录' }}</p>
          <p class="mt-1 text-xs text-[var(--muted)]">@{{ props.currentUser?.username || 'anonymous' }}</p>
          <p class="mt-1 text-xs text-[var(--muted)]">orgId: {{ currentOrgId }}</p>
        </div>
      </div>
      <div class="mt-5 grid gap-3 lg:grid-cols-4">
        <article class="rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
          <p class="text-xs font-semibold uppercase tracking-[.08em] text-[var(--muted)]">用户总数</p>
          <p class="mt-2 text-2xl font-bold">{{ totalUsers }}</p>
        </article>
        <article class="rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
          <p class="text-xs font-semibold uppercase tracking-[.08em] text-[var(--muted)]">管理员</p>
          <p class="mt-2 text-2xl font-bold">{{ adminUsers }}</p>
        </article>
        <article class="rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
          <p class="text-xs font-semibold uppercase tracking-[.08em] text-[var(--muted)]">活跃用户</p>
          <p class="mt-2 text-2xl font-bold">{{ activeUsers }}</p>
        </article>
        <article class="rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
          <p class="text-xs font-semibold uppercase tracking-[.08em] text-[var(--muted)]">当前组织</p>
          <p class="mt-2 truncate text-lg font-bold">{{ currentOrgId }}</p>
        </article>
      </div>
    </section>

    <section v-if="!isAdmin" class="rounded-3xl border border-amber-200 bg-amber-50 p-6 text-amber-900">
      <h3 class="text-base font-bold">当前账号只有查看权限</h3>
      <p class="mt-2 text-sm leading-relaxed">
        只有管理员可以新增、禁用、删除用户或调整角色。若需要维护本地用户，请使用管理员账号登录。
      </p>
    </section>

    <section
      v-if="isAdmin"
      class="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6"
    >
      <div class="flex items-start justify-between gap-4">
        <div>
          <h3 class="text-lg font-bold">新增本地用户</h3>
          <p class="mt-1 text-[13px] text-[var(--muted)]">创建后即可使用本地登录进入系统；所有用户默认归属当前组织 `{{ currentOrgId }}`。</p>
        </div>
        <span class="rounded-full bg-[var(--surface-muted)] px-3 py-1 text-xs font-semibold text-[var(--muted)]">密码至少 6 位</span>
      </div>
      <div class="mt-5 grid gap-3 lg:grid-cols-2">
        <input v-model="draft.displayName" class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 text-sm" placeholder="显示名称，例如 张三" />
        <input v-model="draft.username" class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 text-sm" placeholder="用户名，例如 zhangsan" />
        <input v-model="draft.password" type="password" class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 text-sm" placeholder="初始密码" />
        <select v-model="draft.role" class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 text-sm">
          <option value="member">成员</option>
          <option value="admin">管理员</option>
        </select>
      </div>
      <div class="mt-4 flex justify-end">
        <button
          class="min-w-36 rounded-xl bg-[var(--accent)] px-5 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="busy || !canCreate"
          type="button"
          @click="submitCreate"
        >
          {{ busy ? '处理中…' : '创建用户' }}
        </button>
      </div>
    </section>

    <section class="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 class="text-lg font-bold">用户列表</h3>
          <p class="mt-1 text-[13px] text-[var(--muted)]">统一维护本地账号、角色与启用状态。当前登录用户不能删除或禁用自己。</p>
        </div>
        <span class="rounded-full bg-[var(--surface-muted)] px-3 py-1 text-xs font-semibold text-[var(--muted)]">{{ filteredUsers.length }} / {{ totalUsers }} 个用户</span>
      </div>

      <div class="mt-5 grid gap-3 lg:grid-cols-[minmax(0,1.5fr)_180px_180px]">
        <input
          v-model="searchQuery"
          class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 text-sm"
          placeholder="搜索显示名称、用户名或 orgId"
        />
        <select v-model="roleFilter" class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 text-sm">
          <option value="all">全部角色</option>
          <option value="admin">管理员</option>
          <option value="member">成员</option>
        </select>
        <select v-model="statusFilter" class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 text-sm">
          <option value="all">全部状态</option>
          <option value="active">仅活跃</option>
          <option value="disabled">仅禁用</option>
        </select>
      </div>

      <div class="mt-5 space-y-4">
        <article
          v-for="user in filteredUsers"
          :key="user.id"
          class="rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)] p-4"
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="space-y-1">
              <div class="flex flex-wrap items-center gap-2">
                <p class="text-base font-semibold">{{ user.displayName }}</p>
                <span :class="['rounded-full px-2.5 py-1 text-[11px] font-semibold', statusTone(user)]">
                  {{ user.disabled ? '已禁用' : user.role === 'admin' ? '管理员' : '成员' }}
                </span>
                <span v-if="currentUserId === user.id" class="rounded-full bg-violet-100 px-2.5 py-1 text-[11px] font-semibold text-violet-700">当前登录</span>
              </div>
              <p class="text-sm text-[var(--muted)]">@{{ user.username }}</p>
              <p class="text-xs text-[var(--muted)]">orgId: {{ user.orgId }}</p>
              <p class="text-xs text-[var(--muted)]">最近登录：{{ formatTime(user.lastLoginAt) }}</p>
            </div>
            <div class="flex flex-wrap gap-2">
              <button
                class="rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-semibold text-[var(--muted)] transition hover:bg-[var(--surface)] hover:text-[var(--text)]"
                type="button"
                @click="openUserDetail(user)"
              >
                查看详情
              </button>
              <button
                v-if="isAdmin"
                class="rounded-xl border border-rose-300 px-3 py-2 text-xs font-semibold text-rose-600 disabled:cursor-not-allowed disabled:opacity-50"
                :disabled="busy || currentUserId === user.id"
                type="button"
                @click="confirmRemove(user)"
              >
                删除用户
              </button>
            </div>
          </div>

          <div class="mt-4 grid gap-3 lg:grid-cols-2">
            <input
              :value="user.displayName"
              class="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm"
              :disabled="!isAdmin"
              @change="updateDisplayName(user.id, $event)"
            />
            <select
              :value="user.role"
              class="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm"
              :disabled="!isAdmin || currentUserId === user.id"
              @change="updateRole(user.id, $event)"
            >
              <option value="member">成员</option>
              <option value="admin">管理员</option>
            </select>
            <input
              v-model="passwordDrafts[user.id]"
              type="password"
              class="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm"
              :disabled="!isAdmin"
              placeholder="输入新密码后点击右侧按钮"
            />
          </div>

          <div class="mt-3 flex flex-wrap justify-end gap-3">
            <button
              class="rounded-xl border border-[var(--border)] px-4 py-3 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="busy || !isAdmin || !passwordDrafts[user.id]"
              type="button"
              @click="resetPassword(user.id)"
            >
              重置密码
            </button>
          </div>

          <label v-if="isAdmin" class="mt-4 flex items-center gap-2 text-sm text-[var(--muted)]">
            <input
              :checked="Boolean(user.disabled)"
              type="checkbox"
              :disabled="currentUserId === user.id"
              @change="updateDisabled(user.id, $event)"
            />
            禁用该用户的登录能力
          </label>
        </article>

        <article v-if="filteredUsers.length === 0" class="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface-muted)] px-5 py-8 text-center text-sm text-[var(--muted)]">
          没有匹配当前搜索或筛选条件的用户。
        </article>
      </div>
    </section>

    <div
      v-if="selectedUser"
      class="fixed inset-0 z-40 flex justify-end bg-slate-950/20 backdrop-blur-[1px]"
      @click.self="closeUserDetail"
    >
      <aside class="h-full w-full max-w-xl overflow-y-auto border-l border-[var(--border)] bg-[var(--background)] px-6 py-6 shadow-2xl">
        <div class="flex items-start justify-between gap-4">
          <div>
            <p class="text-[11px] font-extrabold tracking-[.13em] text-[var(--accent)]">USER DETAIL</p>
            <h3 class="mt-2 text-2xl font-bold tracking-[-.03em]">{{ selectedUser.displayName }}</h3>
            <p class="mt-1 text-sm text-[var(--muted)]">@{{ selectedUser.username }}</p>
          </div>
          <button
            class="rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-semibold text-[var(--muted)] transition hover:bg-[var(--surface)] hover:text-[var(--text)]"
            type="button"
            @click="closeUserDetail"
          >
            关闭
          </button>
        </div>

        <div class="mt-5 grid gap-3 sm:grid-cols-2">
          <article class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <p class="text-xs font-semibold uppercase tracking-[.08em] text-[var(--muted)]">角色</p>
            <p class="mt-2 text-base font-bold">{{ selectedUser.role === 'admin' ? '管理员' : '成员' }}</p>
          </article>
          <article class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <p class="text-xs font-semibold uppercase tracking-[.08em] text-[var(--muted)]">状态</p>
            <p class="mt-2 text-base font-bold">{{ selectedUser.disabled ? '已禁用' : '活跃' }}</p>
          </article>
          <article class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <p class="text-xs font-semibold uppercase tracking-[.08em] text-[var(--muted)]">最近登录</p>
            <p class="mt-2 text-base font-bold">{{ formatTime(selectedUser.lastLoginAt) }}</p>
          </article>
          <article class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <p class="text-xs font-semibold uppercase tracking-[.08em] text-[var(--muted)]">组织</p>
            <p class="mt-2 text-base font-bold">{{ selectedUser.orgId }}</p>
          </article>
        </div>

        <section class="mt-5 rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <h4 class="text-lg font-bold">用户资料</h4>
          <div class="mt-4 grid gap-3">
            <label class="grid gap-2 text-sm">
              <span class="font-medium text-[var(--muted)]">显示名称</span>
              <input
                :value="selectedUser.displayName"
                class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 text-sm"
                :disabled="!isAdmin"
                @change="updateDisplayName(selectedUser.id, $event)"
              />
            </label>
            <label class="grid gap-2 text-sm">
              <span class="font-medium text-[var(--muted)]">角色</span>
              <select
                :value="selectedUser.role"
                class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 text-sm"
                :disabled="!isAdmin || currentUserId === selectedUser.id"
                @change="updateRole(selectedUser.id, $event)"
              >
                <option value="member">成员</option>
                <option value="admin">管理员</option>
              </select>
            </label>
            <label class="grid gap-2 text-sm">
              <span class="font-medium text-[var(--muted)]">重置密码</span>
              <div class="grid gap-3 sm:grid-cols-[1fr_auto]">
                <input
                  v-model="passwordDrafts[selectedUser.id]"
                  type="password"
                  class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 text-sm"
                  :disabled="!isAdmin"
                  placeholder="输入新密码"
                />
                <button
                  class="rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                  :disabled="busy || !isAdmin || !passwordDrafts[selectedUser.id]"
                  type="button"
                  @click="resetPassword(selectedUser.id)"
                >
                  重置密码
                </button>
              </div>
            </label>
            <label v-if="isAdmin" class="flex items-center gap-2 text-sm text-[var(--muted)]">
              <input
                :checked="Boolean(selectedUser.disabled)"
                type="checkbox"
                :disabled="currentUserId === selectedUser.id"
                @change="updateDisabled(selectedUser.id, $event)"
              />
              禁用该用户的登录能力
            </label>
          </div>
        </section>
      </aside>
    </div>
  </section>
</template>
