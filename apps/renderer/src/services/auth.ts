const apiBase = () => (window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '');

export interface AuthUser {
  id: string;
  orgId: string;
  username: string;
  displayName: string;
  role: 'admin' | 'member';
  disabled?: boolean;
  lastLoginAt?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface AuthSessionInfo {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  userAgent: string;
  clientType: string;
  current: boolean;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, {
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
  const body = (await response.json().catch(() => ({}))) as { message?: string } & T;
  if (!response.ok) throw new Error(body.message || `Auth request failed: ${response.status}`);
  return body;
}

export function getStoredSessionToken() {
  return window.localStorage.getItem('auth.session.token');
}

export function setStoredSessionToken(token: string | null) {
  if (token) window.localStorage.setItem('auth.session.token', token);
  else window.localStorage.removeItem('auth.session.token');
}

export async function getBootstrapStatus(): Promise<{ needsSetup: boolean; orgId: string }> {
  return request('/api/auth/bootstrap');
}

export async function bootstrapAdmin(input: { orgId?: string; username: string; displayName: string; password: string }): Promise<{ token: string; user: AuthUser }> {
  return request('/api/auth/bootstrap', { method: 'POST', body: JSON.stringify(input) });
}

export async function login(input: { username: string; password: string }): Promise<{ token: string; user: AuthUser }> {
  return request('/api/auth/login', { method: 'POST', body: JSON.stringify(input) });
}

export async function logout(): Promise<void> {
  await request('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) });
}

export async function getCurrentUser(): Promise<AuthUser> {
  const result = await request<{ user: AuthUser }>('/api/auth/me');
  return result.user;
}

export async function getMyProfile(): Promise<AuthUser> {
  const result = await request<{ user: AuthUser }>('/api/auth/me/profile');
  return result.user;
}

export async function updateMyProfile(input: { displayName?: string }): Promise<AuthUser> {
  const result = await request<{ user: AuthUser }>('/api/auth/me/profile', { method: 'PATCH', body: JSON.stringify(input) });
  return result.user;
}

export async function changeMyPassword(input: { oldPassword: string; newPassword: string; revokeOtherSessions?: boolean }): Promise<{ ok: true; revokedOtherSessions: number }> {
  return request('/api/auth/me/password', { method: 'POST', body: JSON.stringify(input) });
}

export async function listMySessions(): Promise<{ currentSessionId: string; sessions: AuthSessionInfo[] }> {
  return request('/api/auth/me/sessions');
}

export async function revokeMySession(sessionId: string): Promise<{ ok: true; revokedCurrent: boolean }> {
  return request(`/api/auth/me/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
}

export async function revokeOtherSessions(): Promise<{ ok: true; revokedCount: number }> {
  return request('/api/auth/me/sessions', { method: 'DELETE' });
}

export async function listLocalUsers(): Promise<AuthUser[]> {
  const result = await request<{ users: AuthUser[] }>('/api/auth/users');
  return result.users;
}

export async function createLocalUser(input: { username: string; displayName: string; password: string; role: 'admin' | 'member' }): Promise<AuthUser> {
  const result = await request<{ user: AuthUser }>('/api/auth/users', { method: 'POST', body: JSON.stringify(input) });
  return result.user;
}

export async function updateLocalUser(userId: string, input: { displayName?: string; password?: string; role?: 'admin' | 'member'; disabled?: boolean }): Promise<AuthUser> {
  const result = await request<{ user: AuthUser }>(`/api/auth/users/${encodeURIComponent(userId)}`, { method: 'PATCH', body: JSON.stringify(input) });
  return result.user;
}

export async function deleteLocalUser(userId: string): Promise<void> {
  await request(`/api/auth/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
}
