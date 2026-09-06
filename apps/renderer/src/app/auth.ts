import { computed, ref } from 'vue';
import {
  bootstrapAdmin,
  changeMyPassword as changeMyPasswordRequest,
  createLocalUser,
  deleteLocalUser,
  getBootstrapStatus,
  getCurrentUser,
  getStoredSessionToken,
  listMySessions,
  listLocalUsers,
  login as loginRequest,
  logout as logoutRequest,
  setStoredSessionToken,
  revokeMySession as revokeMySessionRequest,
  revokeOtherSessions as revokeOtherSessionsRequest,
  updateMyProfile as updateMyProfileRequest,
  updateLocalUser,
  type AuthSessionInfo,
  type AuthUser,
} from '../services/auth.js';
import { setStorageNamespace } from './storage.js';

const currentUser = ref<AuthUser | null>(null);
const ready = ref(false);
const needsSetup = ref(false);
const bootstrapOrgId = ref('local-org');
const localUsers = ref<AuthUser[]>([]);
const mySessions = ref<AuthSessionInfo[]>([]);
const currentSessionId = ref<string | null>(null);

function applyUser(user: AuthUser | null) {
  currentUser.value = user;
  setStorageNamespace(user ? `user:${user.id}` : null);
  if (!user) {
    mySessions.value = [];
    currentSessionId.value = null;
  }
}

async function refreshUsers() {
  if (currentUser.value?.role !== 'admin') {
    localUsers.value = [];
    return;
  }
  localUsers.value = await listLocalUsers();
}

async function refreshMySessions() {
  if (!currentUser.value) {
    mySessions.value = [];
    currentSessionId.value = null;
    return;
  }
  const result = await listMySessions();
  mySessions.value = result.sessions;
  currentSessionId.value = result.currentSessionId;
}

async function load() {
  ready.value = false;
  const bootstrap = await getBootstrapStatus();
  needsSetup.value = bootstrap.needsSetup;
  bootstrapOrgId.value = bootstrap.orgId;
  if (bootstrap.needsSetup) {
    setStoredSessionToken(null);
    applyUser(null);
    ready.value = true;
    return;
  }
  const token = getStoredSessionToken();
  if (!token) {
    applyUser(null);
    ready.value = true;
    return;
  }
  try {
    const user = await getCurrentUser();
    applyUser(user);
    await Promise.all([refreshUsers(), refreshMySessions()]);
  } catch {
    setStoredSessionToken(null);
    applyUser(null);
  } finally {
    ready.value = true;
  }
}

async function login(input: { username: string; password: string }) {
  const result = await loginRequest(input);
  setStoredSessionToken(result.token);
  needsSetup.value = false;
  applyUser(result.user);
  await Promise.all([refreshUsers(), refreshMySessions()]);
}

async function setupFirstAdmin(input: { orgId?: string; username: string; displayName: string; password: string }) {
  const result = await bootstrapAdmin(input);
  setStoredSessionToken(result.token);
  needsSetup.value = false;
  applyUser(result.user);
  await Promise.all([refreshUsers(), refreshMySessions()]);
}

async function logout() {
  try {
    await logoutRequest();
  } catch {
    // Ignore local logout errors and clear client state anyway.
  }
  setStoredSessionToken(null);
  localUsers.value = [];
  applyUser(null);
}

export function authSessionToken() {
  return getStoredSessionToken();
}

export function useAuth() {
  return {
    user: computed(() => currentUser.value),
    ready: computed(() => ready.value),
    needsSetup: computed(() => needsSetup.value),
    bootstrapOrgId: computed(() => bootstrapOrgId.value),
    users: computed(() => localUsers.value),
    mySessions: computed(() => mySessions.value),
    currentSessionId: computed(() => currentSessionId.value),
    isAdmin: computed(() => currentUser.value?.role === 'admin'),
    load,
    login,
    setupFirstAdmin,
    logout,
    async refreshMySessions() {
      await refreshMySessions();
    },
    async updateMyProfile(input: { displayName?: string }) {
      const user = await updateMyProfileRequest(input);
      applyUser(user);
      await refreshUsers();
      return user;
    },
    async changeMyPassword(input: { oldPassword: string; newPassword: string; revokeOtherSessions?: boolean }) {
      const result = await changeMyPasswordRequest(input);
      await refreshMySessions();
      return result;
    },
    async revokeMySession(sessionId: string) {
      const result = await revokeMySessionRequest(sessionId);
      if (result.revokedCurrent) {
        setStoredSessionToken(null);
        localUsers.value = [];
        applyUser(null);
        return result;
      }
      await refreshMySessions();
      return result;
    },
    async revokeOtherSessions() {
      const result = await revokeOtherSessionsRequest();
      await refreshMySessions();
      return result;
    },
    async createUser(input: { username: string; displayName: string; password: string; role: 'admin' | 'member' }) {
      await createLocalUser(input);
      await refreshUsers();
    },
    async updateUser(userId: string, input: { displayName?: string; password?: string; role?: 'admin' | 'member'; disabled?: boolean }) {
      await updateLocalUser(userId, input);
      await refreshUsers();
      if (currentUser.value?.id === userId) currentUser.value = localUsers.value.find((item) => item.id === userId) || currentUser.value;
    },
    async deleteUser(userId: string) {
      await deleteLocalUser(userId);
      await refreshUsers();
    },
    refreshUsers,
  };
}
