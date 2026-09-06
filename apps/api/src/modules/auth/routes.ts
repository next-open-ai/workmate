import type { FastifyPluginAsync } from 'fastify';
import { authTokenOf, authenticateRequest, localUserAuthService, requireAdmin, requireAuth, sendAuthError } from './service.js';

export const authRoutes: FastifyPluginAsync = async (app) => {
  const auth = localUserAuthService();
  const ensureAuth = (request: Parameters<typeof requireAuth>[0]) => {
    request.auth = authenticateRequest(request);
  };

  app.get('/auth/bootstrap', async () => auth.bootstrapStatus());

  app.post('/auth/bootstrap', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      return auth.createInitialAdmin({
        orgId: typeof body.orgId === 'string' ? body.orgId : undefined,
        username: String(body.username || ''),
        displayName: String(body.displayName || ''),
        password: String(body.password || ''),
      }, request);
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.post('/auth/login', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      return auth.login({
        username: String(body.username || ''),
        password: String(body.password || ''),
      }, request);
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.post('/auth/logout', async (request, reply) => {
    try {
      return auth.logout(authTokenOf(request));
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.get('/auth/me', async (request, reply) => {
    const token = authTokenOf(request);
    const user = token ? auth.currentUser(token) : null;
    if (!user) return reply.code(401).send({ message: 'Not logged in.' });
    return { user };
  });

  app.get('/auth/me/profile', async (request, reply) => {
    try {
      ensureAuth(request);
      return { user: auth.currentUser(authTokenOf(request)) };
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.patch('/auth/me/profile', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      ensureAuth(request);
      const current = requireAuth(request);
      return {
        user: auth.updateProfile(current.userId, {
          displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
        }),
      };
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.post('/auth/me/password', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      ensureAuth(request);
      const current = requireAuth(request);
      return auth.changePassword({
        userId: current.userId,
        oldPassword: String(body.oldPassword || ''),
        newPassword: String(body.newPassword || ''),
        currentSessionId: current.sessionId,
        revokeOtherSessions: body.revokeOtherSessions !== false,
      });
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.get('/auth/me/sessions', async (request, reply) => {
    try {
      ensureAuth(request);
      const current = requireAuth(request);
      return auth.listSessions(current.userId, current.sessionId);
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.delete('/auth/me/sessions/:sessionId', async (request, reply) => {
    try {
      ensureAuth(request);
      const current = requireAuth(request);
      const sessionId = String((request.params as Record<string, string>).sessionId || '');
      return auth.revokeSession(current.userId, sessionId, current.sessionId);
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.delete('/auth/me/sessions', async (request, reply) => {
    try {
      ensureAuth(request);
      const current = requireAuth(request);
      return auth.revokeOtherSessions(current.userId, current.sessionId);
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.get('/auth/users', async (request, reply) => {
    try {
      ensureAuth(request);
      requireAdmin(request);
      return { users: auth.listUsers() };
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.post('/auth/users', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      ensureAuth(request);
      const current = requireAdmin(request);
      return {
        user: auth.createUser({
          orgId: current.orgId,
          username: String(body.username || ''),
          displayName: String(body.displayName || ''),
          password: String(body.password || ''),
          role: body.role === 'admin' ? 'admin' : 'member',
        }),
      };
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.patch('/auth/users/:userId', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      ensureAuth(request);
      const current = requireAdmin(request);
      const targetId = String((request.params as Record<string, string>).userId);
      if (current.userId === targetId && body.disabled === true) throw new Error('不能禁用当前登录用户。');
      if (current.userId === targetId && body.role === 'member') throw new Error('不能将当前登录管理员降级为 member。');
      return {
        user: auth.updateUser(targetId, {
          displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
          password: typeof body.password === 'string' && body.password ? body.password : undefined,
          role: body.role === 'admin' || body.role === 'member' ? body.role : undefined,
          disabled: typeof body.disabled === 'boolean' ? body.disabled : undefined,
        }),
      };
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.delete('/auth/users/:userId', async (request, reply) => {
    try {
      ensureAuth(request);
      const current = requireAdmin(request);
      const targetId = String((request.params as Record<string, string>).userId);
      if (current.userId === targetId) throw new Error('不能删除当前登录用户。');
      return auth.deleteUser(targetId);
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.get('/auth/context', async (request, reply) => {
    try {
      ensureAuth(request);
      const current = requireAuth(request);
      return { user: current };
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });
};
