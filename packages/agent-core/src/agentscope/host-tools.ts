import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChatRequest } from '@workmate/contracts';
import { loadMcpToolset, type HostedMcpToolDescriptor } from '../mcp-runtime.js';
import { extractToolDetails, type AgentTool } from '../pi-tools.js';

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

function workspaceRootFor(runId: string): string {
  const base = process.env.WORKMATE_WORKSPACES_DIR || path.join(process.env.WORKMATE_DATA_DIR || path.join(process.env.HOME || '/tmp', '.workmate'), 'workspaces');
  return path.join(base, runId);
}

function safeRel(rel: string): string {
  const normalized = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..')) throw new Error(`Unsafe path: ${rel}`);
  return normalized;
}

async function readWorkspaceFile(runId: string, input: Record<string, unknown>): Promise<HostToolResult['output']> {
  const rel = safeRel(String(input.path || ''));
  const full = path.join(workspaceRootFor(runId), rel);
  return fs.readFile(full, 'utf8');
}

async function writeWorkspaceFile(runId: string, input: Record<string, unknown>): Promise<{ output: string; artifactPath?: string }> {
  const rel = safeRel(String(input.path || ''));
  const deliverable = Boolean(input.deliverable);
  const targetRel = deliverable && !rel.startsWith('output/') ? path.posix.join('output', path.posix.basename(rel)) : rel;
  const full = path.join(workspaceRootFor(runId), targetRel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, String(input.content ?? ''), 'utf8');
  return {
    output: JSON.stringify({ ok: true, path: targetRel }),
    artifactPath: targetRel.startsWith('output/') ? targetRel : undefined,
  };
}

/**
 * Execute AgentScope external tools on the TypeScript host.
 */
export async function executeHostToolCalls(
  runId: string,
  toolCalls: HostToolCall[],
  workspaceAccess: 'read' | 'write' | 'full' = 'write',
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
      if (call.name === 'read_workspace_file') {
        const text = await readWorkspaceFile(runId, input);
        results.push({
          id: call.id,
          name: call.name,
          state: 'success',
          output: text.slice(0, 48_000),
          summary: `read ${String(input.path || '')}`,
        });
        continue;
      }
      if (call.name === 'write_workspace_file') {
        if (workspaceAccess === 'read') {
          results.push({
            id: call.id,
            name: call.name,
            state: 'error',
            output: JSON.stringify({ ok: false, error: 'Workspace write is not permitted for this run.' }),
            summary: 'workspace write denied',
          });
          continue;
        }
        const written = await writeWorkspaceFile(runId, input);
        results.push({
          id: call.id,
          name: call.name,
          state: 'success',
          output: written.output,
          summary: `write ${String(input.path || '')}`,
          ...(written.artifactPath ? { artifactPath: written.artifactPath } : {}),
        });
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
  request: Pick<ChatRequest, 'mcpConnections' | 'mcpToolTimeoutMs' | 'workspaceAccess'>,
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
      if (baseCalls.length) results.push(...await executeHostToolCalls(runId, baseCalls, request.workspaceAccess));
      return results;
    },
    close: mcp.close,
  };
}
