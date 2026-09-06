import type { AgentEvent, ChatRequest } from '@workmate/contracts';
import { streamAgentReply as streamAgentReplyViaPi, DEFAULT_RUN_TIMEOUT_MS } from './pi-runtime.js';
import { streamAgentReplyViaAgentscope } from './agentscope/stream.js';

export { DEFAULT_RUN_TIMEOUT_MS };

export type AgentEngineId = 'pi' | 'agentscope';

export function resolveAgentEngine(override?: string | null): AgentEngineId {
  const raw = (override ?? process.env.WORKMATE_AGENT_ENGINE ?? 'pi').trim().toLowerCase();
  return raw === 'agentscope' ? 'agentscope' : 'pi';
}

/**
 * Single product entry: pick pi (in-process) or AgentScope Sidecar via env.
 */
export async function* streamAgentReply(input: ChatRequest & {
  abortSignal?: AbortSignal;
  runId?: string;
}): AsyncGenerator<AgentEvent> {
  if (resolveAgentEngine() === 'agentscope') {
    yield* streamAgentReplyViaAgentscope(input);
    return;
  }
  yield* streamAgentReplyViaPi(input);
}
