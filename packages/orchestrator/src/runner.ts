import { streamAgentReply } from '@workmate/agent-core';
import type { AgentEvent, ChatRequest } from '@workmate/contracts';

/**
 * Abstraction over "execute one agent run" so the orchestration state machine
 * is testable without any live model provider (tests inject a FakeRunner).
 */
export interface AgentRunner {
  /**
   * Start a run. `emit` receives every AgentEvent as it is produced.
   * Resolves when the run settles (completed/failed/cancelled).
   */
  start(request: ChatRequest, emit: (event: AgentEvent) => void, options?: { abortSignal?: AbortSignal }): Promise<void>;
}

/** Production runner: delegates to the single agent-core execution boundary. */
export const agentCoreRunner: AgentRunner = {
  async start(request, emit, options) {
    for await (const event of streamAgentReply({
      ...request,
      abortSignal: options?.abortSignal,
    })) {
      emit(event);
    }
  },
};
