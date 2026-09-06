import type { AgentEvent, AgentProfile, ModelConfig } from '@workmate/contracts';
import type { OpcaiTool, ToolPolicy } from '@workmate/tools';
import { summarizeSessionMemory as summarizeSessionMemoryImpl } from './context-compaction.js';

export * from './skills.js';
export * from './mcp-runtime.js';
export * from './skill-runtime.js';
export * from './context-compaction.js';
export * from './search-runtime.js';
export * from './knowledge-runtime.js';
export * from './experience/index.js';
export * from './pi-model.js';
export * from './pi-tools.js';
export * from './pi-skills.js';
export { streamAgentReply, DEFAULT_RUN_TIMEOUT_MS, resolveAgentEngine } from './stream-reply.js';
export type { AgentEngineId } from './stream-reply.js';
export * from './agentscope/index.js';

/**
 * Workmate agent boundary.
 * Default loop: pi-agent-core / pi-ai
 * Optional Sidecar: AgentScope via WebSocket JSON-RPC (`WORKMATE_AGENT_ENGINE=agentscope`)
 */
export interface AgentRuntime {
  start(input: { profile: AgentProfile; prompt: string; tools: OpcaiTool[] }): AsyncIterable<AgentEvent>;
  cancel(runId: string): void;
}

export class PolicyEngine implements ToolPolicy {
  requiresApproval(risk: OpcaiTool['risk']): boolean {
    return risk !== 'read';
  }
}

export const defaultProfile: AgentProfile = {
  id: 'general',
  name: 'General Assistant',
  instructions: 'You are a helpful assistant.',
  toolIds: [],
};

/** Durable session-memory summarizer (ModelConfig → plain turns) via pi. */
export async function summarizeSessionMemory(input: {
  model: ModelConfig;
  previousSummary?: string;
  turns: Array<{ role: 'user' | 'assistant'; content: string }>;
}): Promise<string | null> {
  return summarizeSessionMemoryImpl(input);
}
