import { createApp } from './app.js';
import { requestParentSecrets } from './modules/orchestration/secrets.js';
import { ensureSharedAgentscopeRuntime, stopSharedAgentscopeRuntime, resolveAgentEngine } from '@workmate/agent-core';

async function bootstrap() {
  const port = Number(process.env.WORKMATE_API_PORT ?? 4328);
  const host = process.env.WORKMATE_API_HOST || '127.0.0.1';
  const engine = resolveAgentEngine();
  const warmAgentscope = process.env.WORKMATE_AGENTSCOPE_ENABLED === '1' || engine === 'agentscope';
  // Kick off secrets early, but do not block /api/health on the full 4s parent
  // IPC timeout — that raced Electron's waitForApi and left Vite ECONNREFUSED.
  const secretsReady = requestParentSecrets().catch(() => undefined);
  await Promise.race([
    secretsReady,
    new Promise<void>((resolve) => setTimeout(resolve, 750)),
  ]);
  if (warmAgentscope) {
    try {
      await secretsReady;
      const handle = await ensureSharedAgentscopeRuntime();
      const health = await handle.client.health();
      console.info('[workmate-api] AgentScope runtime ready', { engine, port: handle.port, host, health });
    } catch (error) {
      console.error('[workmate-api] AgentScope runtime failed to start', { engine, error });
      if (engine === 'agentscope') throw error;
    }
  }
  const app = await createApp();
  await app.listen({ port, host });
  void secretsReady;

  const close = async () => {
    await stopSharedAgentscopeRuntime().catch(() => undefined);
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

void bootstrap();
