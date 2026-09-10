import type { ChatRequest } from '@workmate/contracts';
import { loadMcpToolset, type HostedMcpToolDescriptor } from '../mcp-runtime.js';
import { extractToolDetails, type AgentTool } from '../pi-tools.js';
import { executeAgentscopeCapabilityCalls } from '../agentscope-capability-adapter.js';
import { resolveAgentWorkspaceRoot, resolveWorkspaceMode } from '../workspace-mode.js';

export type HostToolCall = {
  id: string;
  name: string;
  input?: Record<string, unknown>;
};

export type HostToolResult = {
  id: string;
  name: string;
  output: string;
  state: 'success' | 'error';
  summary?: string;
  artifactPath?: string;
};

export type AgentscopeHostToolSession = {
  runtimePatch: {
    mcpTools?: HostedMcpToolDescriptor[];
    mcpInstructions?: string;
  };
  executeHostToolCalls: (runId: string, toolCalls: HostToolCall[]) => Promise<HostToolResult[]>;
  close: () => Promise<void>;
};

/**
 * Execute AgentScope external tools on the TypeScript host.
 */
export async function executeHostToolCalls(
  runId: string,
  toolCalls: HostToolCall[],
  workspaceAccess: 'read' | 'write' | 'full' = 'write',
  projectWorkspacePath?: string,
): Promise<HostToolResult[]> {
  const results: HostToolResult[] = [];
  for (const call of toolCalls) {
    const input = call.input && typeof call.input === 'object' ? call.input : {};
    try {
      if (call.name === 'host_ping') {
        results.push({
          id: call.id,
          name: call.name,
          state: 'success',
          output: JSON.stringify({ ok: true, echo: input.message ?? 'pong', runId }),
          summary: 'host_ping ok',
        });
        continue;
      }
      if (['read', 'write', 'edit', 'bash', 'commit_artifact', 'read_workspace_file', 'write_workspace_file'].includes(call.name)) {
        const workspaceMode = resolveWorkspaceMode(projectWorkspacePath);
        const capability = await executeAgentscopeCapabilityCalls({
          runId,
          workspaceRoot: resolveAgentWorkspaceRoot({ runId, projectWorkspacePath }),
          workspaceAccess,
          workspaceMode,
        }, [{ ...call, input }]);
        results.push(...capability);
        continue;
      }
      results.push({
        id: call.id,
        name: call.name,
        state: 'error',
        output: JSON.stringify({ ok: false, error: `Unknown host tool: ${call.name}` }),
        summary: 'unknown tool',
      });
    } catch (error) {
      results.push({
        id: call.id,
        name: call.name,
        state: 'error',
        output: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
        summary: 'tool error',
      });
    }
  }
  return results;
}

function detailsToOutput(details: unknown): string {
  return typeof details === 'string' ? details : JSON.stringify(details ?? null);
}

function detailsToState(details: unknown): HostToolResult['state'] {
  if (!details || typeof details !== 'object') return 'success';
  const row = details as Record<string, unknown>;
  if (row.ok === false || row.isError === true || typeof row.error === 'string') return 'error';
  return 'success';
}

async function executeTool(call: HostToolCall, tool: AgentTool): Promise<HostToolResult> {
  const result = await tool.execute(call.id, call.input ?? {}, undefined);
  const details = extractToolDetails(result);
  return {
    id: call.id,
    name: call.name,
    state: detailsToState(details),
    output: detailsToOutput(details),
    summary: `${call.name} via MCP`,
  };
}

export async function prepareAgentscopeHostTools(
  request: Pick<ChatRequest, 'mcpConnections' | 'mcpToolTimeoutMs' | 'workspaceAccess' | 'projectWorkspacePath'>,
): Promise<AgentscopeHostToolSession> {
  const mcp = await loadMcpToolset(request.mcpConnections, { toolTimeoutMs: request.mcpToolTimeoutMs });
  const mcpByName = new Map<string, AgentTool>(mcp.tools.map((tool) => [tool.name, tool]));
  return {
    runtimePatch: {
      ...(mcp.toolDescriptors.length ? { mcpTools: mcp.toolDescriptors } : {}),
      ...(mcp.instructions ? { mcpInstructions: mcp.instructions } : {}),
    },
    executeHostToolCalls: async (runId, toolCalls) => {
      const baseCalls: HostToolCall[] = [];
      const results: HostToolResult[] = [];
      for (const call of toolCalls) {
        const tool = mcpByName.get(call.name);
        if (!tool) {
          baseCalls.push(call);
          continue;
        }
        try {
          results.push(await executeTool(call, tool));
        } catch (error) {
          results.push({
            id: call.id,
            name: call.name,
            state: 'error',
            output: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
            summary: `${call.name} MCP error`,
          });
        }
      }
      if (baseCalls.length) results.push(...await executeHostToolCalls(runId, baseCalls, request.workspaceAccess, request.projectWorkspacePath));
      return results;
    },
    close: mcp.close,
  };
}
