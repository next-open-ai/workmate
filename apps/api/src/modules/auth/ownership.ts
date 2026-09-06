import type { AuthPrincipal } from './service.js';

export type OwnedResource = {
  orgId?: string | null;
  userId?: string | null;
  ownerUserId?: string | null;
  accessScope?: 'private' | 'org-shared' | 'delegated' | null;
  accessGrants?: Array<{
    subjectType?: 'user' | null;
    subjectId?: string | null;
    permissions?: Array<'read' | 'write'> | null;
    expiresAt?: number | null;
  }> | null;
};

function ownerIdOf(record: OwnedResource) {
  return String(record.ownerUserId || record.userId || '').trim() || null;
}

function accessScopeOf(record: OwnedResource) {
  return record.accessScope === 'org-shared' || record.accessScope === 'delegated' ? record.accessScope : 'private';
}

function hasDelegatedPermission(record: OwnedResource, userId: string, permission: 'read' | 'write') {
  const now = Date.now();
  return (record.accessGrants ?? []).some((grant) => {
    if (grant?.subjectType !== 'user') return false;
    if (grant.subjectId !== userId) return false;
    if (grant.expiresAt && grant.expiresAt < now) return false;
    return Array.isArray(grant.permissions) && grant.permissions.includes(permission);
  });
}

export function canReadOwnedResource(
  record: OwnedResource | null | undefined,
  principal: Pick<AuthPrincipal, 'orgId' | 'userId' | 'role'>,
  options: { allowLegacyUnowned?: boolean } = {},
) {
  if (!record) return false;
  if (record.orgId && record.orgId !== principal.orgId) return false;
  const ownerUserId = ownerIdOf(record);
  if (!ownerUserId) return Boolean(options.allowLegacyUnowned);
  if (ownerUserId === principal.userId) return true;
  if (principal.role === 'admin') return true;
  switch (accessScopeOf(record)) {
    case 'org-shared':
      return true;
    case 'delegated':
      return hasDelegatedPermission(record, principal.userId, 'read');
    default:
      return false;
  }
}

export function canWriteOwnedResource(
  record: OwnedResource | null | undefined,
  principal: Pick<AuthPrincipal, 'orgId' | 'userId' | 'role'>,
  options: { allowLegacyUnowned?: boolean } = {},
) {
  if (!record) return false;
  if (record.orgId && record.orgId !== principal.orgId) return false;
  const ownerUserId = ownerIdOf(record);
  if (!ownerUserId) return Boolean(options.allowLegacyUnowned);
  if (ownerUserId === principal.userId) return true;
  if (principal.role === 'admin') return true;
  if (accessScopeOf(record) === 'delegated') return hasDelegatedPermission(record, principal.userId, 'write');
  return false;
}

export function requireSystemAdmin(principal: Pick<AuthPrincipal, 'role'>) {
  if (principal.role !== 'admin') throw new Error('Admin permission required.');
}
