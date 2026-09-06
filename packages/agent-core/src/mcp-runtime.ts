import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpConnectionRuntime } from '@workmate/contracts';
import { defineAgentTool, jsonSchemaParameters, type AgentTool } from './pi-tools.js';

export interface McpConnection {
  id: string;
  name: string;
  transport: 'http' | 'sse' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled: boolean;
  apiKey?: string;
}

export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 60_000;

export type HostedMcpToolDescriptor = {
  name: string;
  description: string;
  inputSchema: unknown;
  capability?: 'network-access';
};

function sanitizeToolPrefix(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'mcp';
}

function isStdio(connection: McpConnection | McpConnectionRuntime): boolean {
  return connection.transport === 'stdio' || Boolean((connection as McpConnection).command && !(connection as McpConnection).url);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function expandUserPath(value: string): string {
  const raw = String(value || '');
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

function prepareStdioLaunch(connection: McpConnection | McpConnectionRuntime) {
  const command = 'command' in connection ? String(connection.command || '').trim() : '';
  if (!command) throw new Error('Local MCP requires a command (npx / uvx / custom).');
  const args = ('args' in connection && Array.isArray(connection.args) ? connection.args.map(String) : []).map(expandUserPath);
  // Ensure sandbox dirs exist for filesystem-style MCP seeds (e.g. ~/.workmate/mcp-files).
  for (const arg of args) {
    if (!arg.includes(`${path.sep}.workmate${path.sep}`) && !arg.endsWith(`${path.sep}.workmate`)) continue;
    try {
      fs.mkdirSync(arg, { recursive: true });
    } catch {
      /* ignore */
    }
  }
  const env =
    'env' in connection && connection.env && typeof connection.env === 'object'
      ? ({ ...process.env, ...connection.env } as Record<string, string>)
      : ({ ...process.env } as Record<string, string>);
  if (env.PYTHONUNBUFFERED === undefined) env.PYTHONUNBUFFERED = '1';
  const cwdRaw = 'cwd' in connection && connection.cwd ? String(connection.cwd) : undefined;
  const cwd = cwdRaw ? expandUserPath(cwdRaw) : undefined;
  return { command, args, env, cwd };
}

export async function connectMcpClient(connection: McpConnection | McpConnectionRuntime): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const client = new Client({ name: 'workmate', version: '0.1.0' }, { capabilities: {} });
  let transport: { close?: () => Promise<void> };

  if (isStdio(connection) || connection.transport === 'stdio') {
    const { command, args, env, cwd } = prepareStdioLaunch(connection);
    const stdio = new StdioClientTransport({ command, args, env, cwd, stderr: 'pipe' });
    transport = stdio;
    await client.connect(stdio);
  } else {
    if (!connection.url) throw new Error('This connection requires an HTTP or SSE URL.');
    const headers: Record<string, string> = {};
    if (connection.apiKey?.trim()) headers.Authorization = `Bearer ${connection.apiKey.trim()}`;
    const url = new URL(connection.url);
    if (connection.transport === 'sse') {
      const sse = new SSEClientTransport(url, Object.keys(headers).length ? { requestInit: { headers } } : undefined);
      transport = sse;
      await client.connect(sse);
    } else {
      const http = new StreamableHTTPClientTransport(url, Object.keys(headers).length ? { requestInit: { headers } } : undefined);
      transport = http;
      await client.connect(http);
    }
  }

  return {
    client,
    close: async () => {
      try { await client.close(); } catch { /* ignore */ }
      try { await transport.close?.(); } catch { /* ignore */ }
    },
  };
}

function mcpContentToDetails(result: { content?: Array<{ type: string; text?: string }>; isError?: boolean; structuredContent?: unknown }) {
  const texts = (result.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string);
  const text = texts.join('\n').trim();
  if (result.structuredContent !== undefined) {
    return {
      ok: !result.isError,
      text: text || undefined,
      structuredContent: result.structuredContent,
      isError: Boolean(result.isError),
    };
  }
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return { ok: !result.isError, text, isError: Boolean(result.isError) };
    }
  }
  return { ok: !result.isError, isError: Boolean(result.isError) };
}

/** Keep live MCP clients across chat turns — reconnect was a multi-second TTFT tax. */
const MCP_IDLE_TTL_MS = 90_000;
type PooledMcp = {
  key: string;
  client: Client;
  closeTransport: () => Promise<void>;
  listed: Awaited<ReturnType<Client['listTools']>>;
  instructions?: string;
  refs: number;
  idleTimer?: ReturnType<typeof setTimeout>;
};
const mcpPool = new Map<string, PooledMcp>();

function mcpConnectionKey(connection: McpConnection | McpConnectionRuntime): string {
  return JSON.stringify({
    id: connection.id,
    name: connection.name,
    transport: connection.transport,
    url: 'url' in connection ? connection.url : undefined,
    command: 'command' in connection ? connection.command : undefined,
    args: 'args' in connection ? connection.args : undefined,
    env: 'env' in connection ? connection.env : undefined,
    cwd: 'cwd' in connection ? connection.cwd : undefined,
    apiKey: 'apiKey' in connection ? String(connection.apiKey || '') : '',
  });
}

async function acquirePooledMcp(connection: McpConnectionRuntime): Promise<PooledMcp> {
  const key = mcpConnectionKey(connection);
  const existing = mcpPool.get(key);
  if (existing) {
    if (existing.idleTimer) {
      clearTimeout(existing.idleTimer);
      existing.idleTimer = undefined;
    }
    existing.refs += 1;
    return existing;
  }
  const { client, close } = await connectMcpClient(connection);
  const listed = await client.listTools();
  const instructions = (client as { getInstructions?: () => string | undefined }).getInstructions?.()?.trim()
    || (listed as { instructions?: string }).instructions?.trim();
  const pooled: PooledMcp = {
    key,
    client,
    closeTransport: close,
    listed,
    ...(instructions ? { instructions } : {}),
    refs: 1,
  };
  mcpPool.set(key, pooled);
  return pooled;
}

function releasePooledMcp(pooled: PooledMcp) {
  pooled.refs = Math.max(0, pooled.refs - 1);
  if (pooled.refs > 0) return;
  if (pooled.idleTimer) clearTimeout(pooled.idleTimer);
  pooled.idleTimer = setTimeout(() => {
    if (pooled.refs > 0) return;
    mcpPool.delete(pooled.key);
    void pooled.closeTransport().catch(() => undefined);
  }, MCP_IDLE_TTL_MS);
}

/**
 * Connect employee MCP servers and expose them as pi AgentTools (`mcp_<prefix>_<name>`).
 */
export async function loadMcpToolset(
  connections: McpConnectionRuntime[] | undefined,
  options?: { toolTimeoutMs?: number },
) {
  const toolTimeoutMs = Math.min(
    300_000,
    Math.max(3_000, Math.round(Number(options?.toolTimeoutMs) || DEFAULT_MCP_TOOL_TIMEOUT_MS)),
  );
  const acquired: PooledMcp[] = [];
  const tools: AgentTool[] = [];
  const toolDescriptors: HostedMcpToolDescriptor[] = [];
  const labels: string[] = [];
  const instructionParts: string[] = [];
  const toolCatalog: string[] = [];
  const loadErrors: string[] = [];

  const enabled = (connections ?? []).filter((connection) => {
    if (!connection?.enabled) return false;
    return connection.transport === 'stdio'
      ? Boolean(connection.command?.trim())
      : Boolean(connection.url);
  });

  // Connect in parallel; reuse pooled clients across turns.
  const loaded = await Promise.all(enabled.map(async (connection) => {
    try {
      const pooled = await acquirePooledMcp(connection);
      acquired.push(pooled);
      const { client, listed } = pooled;
      const prefix = sanitizeToolPrefix(connection.name || connection.id);
      const names: string[] = [];
      const localTools: AgentTool[] = [];
      const localDescriptors: HostedMcpToolDescriptor[] = [];
      for (const tool of listed.tools ?? []) {
        const key = `mcp_${prefix}_${tool.name}`.slice(0, 64);
        names.push(key);
        localDescriptors.push({
          name: key,
          description: (tool.description ?? '').trim() || `MCP tool ${tool.name} from ${connection.name}`,
          inputSchema: tool.inputSchema ?? { type: 'object', additionalProperties: true },
          ...(connection.transport === 'stdio' ? {} : { capability: 'network-access' as const }),
        });
        localTools.push(
          defineAgentTool({
            name: key,
            label: tool.name,
            description: (tool.description ?? '').trim() || `MCP tool ${tool.name} from ${connection.name}`,
            parameters: jsonSchemaParameters(tool.inputSchema ?? { type: 'object', additionalProperties: true }),
            execute: async (params) => {
              try {
                const result = await withTimeout(
                  client.callTool({ name: tool.name, arguments: (params && typeof params === 'object' ? params : {}) as Record<string, unknown> }),
                  toolTimeoutMs,
                  key,
                );
                return mcpContentToDetails(result as { content?: Array<{ type: string; text?: string }>; isError?: boolean; structuredContent?: unknown });
              } catch (error) {
                return { ok: false, error: error instanceof Error ? error.message : String(error) };
              }
            },
          }),
        );
      }
      return {
        ok: true as const,
        name: connection.name,
        names,
        tools: localTools,
        descriptors: localDescriptors,
        instructions: pooled.instructions,
      };
    } catch (error) {
      return {
        ok: false as const,
        name: connection.name,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));

  for (const item of loaded) {
    if (!item.ok) {
      loadErrors.push(`${item.name}: ${item.error}`);
      continue;
    }
    tools.push(...item.tools);
    toolDescriptors.push(...item.descriptors);
    labels.push(item.name);
    if (item.names.length) {
      toolCatalog.push(`- ${item.name}: ${item.names.slice(0, 24).join(', ')}${item.names.length > 24 ? ` (+${item.names.length - 24} more)` : ''}`);
    }
    if (item.instructions) instructionParts.push(`MCP 「${item.name}」使用说明：\n${item.instructions}`);
  }

  if (toolCatalog.length) {
    instructionParts.unshift(
      `Available MCP tools for this run:\n${toolCatalog.join('\n')}`,
    );
  }
  if (loadErrors.length) {
    instructionParts.push(`MCP connectors that failed to load (unavailable this run):\n${loadErrors.map((item) => `- ${item}`).join('\n')}`);
  }

  return {
    tools,
    toolDescriptors,
    instructions: instructionParts.join('\n\n'),
    labels,
    async close() {
      for (const pooled of acquired) releasePooledMcp(pooled);
    },
  };
}

export type McpProbeTool = {
  name: string;
  description?: string;
};

export type McpProbeResult = {
  ok: boolean;
  toolCount: number;
  toolNames: string[];
  tools: McpProbeTool[];
  durationMs: number;
  error?: string;
};

/** One-shot connectivity check: connect → list tools → close. */
export async function probeMcpConnection(
  connection: McpConnection | McpConnectionRuntime,
  options?: { timeoutMs?: number },
): Promise<McpProbeResult> {
  const timeoutMs = Math.min(60_000, Math.max(3_000, options?.timeoutMs ?? 25_000));
  const started = Date.now();
  let close: (() => Promise<void>) | undefined;
  try {
    const work = (async () => {
      const session = await connectMcpClient(connection);
      close = session.close;
      const listed = await session.client.listTools();
      return (listed.tools ?? []).slice(0, 80).map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: String(tool.description).slice(0, 400) } : {}),
      }));
    })();
    const tools = await withTimeout(work, timeoutMs, 'MCP probe');
    return {
      ok: true,
      toolCount: tools.length,
      toolNames: tools.map((item) => item.name),
      tools,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      toolCount: 0,
      toolNames: [],
      tools: [],
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : 'MCP probe failed.',
    };
  } finally {
    if (close) {
      try { await close(); } catch { /* ignore */ }
    }
  }
}
