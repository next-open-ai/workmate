import type { AgentTool } from '@mariozechner/pi-agent-core';
import { extractToolDetails } from './pi-tools.js';
import { createPiCapabilityTools } from './pi-capability-adapter.js';
import type { CapabilityContext } from './capability-kernel.js';

export type AgentscopeCapabilityCall = { id: string; name: string; input?: Record<string, unknown> };
export type AgentscopeCapabilityResult = {
  id: string;
  name: string;
  output: string;
  state: 'success' | 'error';
  summary?: string;
  artifactPath?: string;
};

/**
 * AgentScope's reverse-RPC bridge adapter. It deliberately reuses the Pi
 * native tool implementations, but exposes their engine-neutral names through
 * the AgentScope host ABI.
 */
export async function executeAgentscopeCapabilityCalls(
  context: CapabilityContext,
  calls: AgentscopeCapabilityCall[],
): Promise<AgentscopeCapabilityResult[]> {
  const tools = new Map<string, AgentTool<any>>(createPiCapabilityTools(context).map((tool) => [tool.name, tool]));
  const aliases: Record<string, string> = {
    read_workspace_file: 'read',
    write_workspace_file: 'write',
  };
  const results: AgentscopeCapabilityResult[] = [];
  for (const call of calls) {
    const name = aliases[call.name] || call.name;
    const tool = tools.get(name);
    if (!tool) {
      results.push({
        id: call.id, name: call.name, state: 'error',
        output: JSON.stringify({ ok: false, error: { code: 'UNKNOWN_CAPABILITY', message: `Unknown capability: ${call.name}`, retryable: false } }),
        summary: 'unknown capability',
      });
      continue;
    }
    try {
      const result = await tool.execute(call.id, call.input ?? {}, undefined);
      const details = extractToolDetails(result);
      const record = details && typeof details === 'object' ? details as Record<string, unknown> : null;
      const failed = Boolean(record?.ok === false || record?.error);
      const artifactPath = name === 'commit_artifact' && record?.deliverable === true && typeof record.path === 'string'
        ? record.path
        : undefined;
      results.push({
        id: call.id,
        name: call.name,
        state: failed ? 'error' : 'success',
        output: typeof details === 'string' ? details : JSON.stringify(details ?? null),
        summary: failed ? 'capability failed' : `${name} completed`,
        ...(artifactPath ? { artifactPath } : {}),
      });
    } catch (error) {
      results.push({
        id: call.id, name: call.name, state: 'error',
        output: JSON.stringify({ ok: false, error: { code: 'CAPABILITY_FAILED', message: error instanceof Error ? error.message : String(error), retryable: false } }),
        summary: 'capability error',
      });
    }
  }
  return results;
}
