import { createApp } from './app.js';
import { requestParentSecrets } from './modules/orchestration/secrets.js';
import { ensureSharedAgentscopeRuntime, stopSharedAgentscopeRuntime, resolveAgentEngine } from '@workmate/agent-core';

async function bootstrap() {
  const port = Number(process.env.WORKMATE_API_PORT ?? 4328);
  const host = process.env.WORKMATE_API_HOST || '127.0.0.1';
  const engine = resolveAgentEngine();
  const warmAgentscope = process.env.WORKMATE_AGENTSCOPE_ENABLED === '1' || engine === 'agentscope';
  // Pull decrypted secrets before warming the sidecar so the first user turn
  // does not pay the cold-start cost after the UI is already interactive.
  await requestParentSecrets().catch(() => undefined);
  if (warmAgentscope) {
    try {
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

  const close = async () => {
    await stopSharedAgentscopeRuntime().catch(() => undefined);
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

void bootstrap();
