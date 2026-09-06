import { Type, type Static, type TSchema } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { StringEnum } from '@mariozechner/pi-ai';

export { Type, StringEnum };
export type { Static, TSchema, AgentTool, AgentToolResult };

/** Serialize tool details for the model-facing text channel. */
export function toolTextResult<T>(details: T): AgentToolResult<T> {
  const text = typeof details === 'string' ? details : JSON.stringify(details ?? null);
  return {
    content: [{ type: 'text', text }],
    details,
  };
}

export function toolErrorResult(error: unknown): AgentToolResult<{ ok: false; error: string }> {
  const message = error instanceof Error ? error.message : String(error);
  return toolTextResult({ ok: false as const, error: message });
}

/**
 * Define a pi-agent-core AgentTool with TypeBox parameters.
 * Prefer this over Vercel AI SDK `tool()` — schemas go straight to the provider.
 */
export function defineAgentTool<T extends TSchema>(options: {
  name: string;
  label?: string;
  description: string;
  parameters: T;
  execute: (params: Static<T>, ctx: { toolCallId: string; signal?: AbortSignal }) => Promise<unknown> | unknown;
}): AgentTool {
  return {
    name: options.name,
    label: options.label ?? options.name,
    description: options.description,
    parameters: options.parameters,
    execute: async (toolCallId, params, signal) => {
      try {
        const details = await options.execute(params as Static<T>, { toolCallId, signal });
        return toolTextResult(details);
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  };
}

/** Flatten AgentTool arrays / records into one list (later names win). */
export function collectAgentTools(
  ...groups: Array<AgentTool[] | Record<string, AgentTool | undefined | null> | undefined | null>
): AgentTool[] {
  const byName = new Map<string, AgentTool>();
  for (const group of groups) {
    if (!group) continue;
    if (Array.isArray(group)) {
      for (const tool of group) byName.set(tool.name, tool);
      continue;
    }
    for (const [name, tool] of Object.entries(group)) {
      if (tool) byName.set(tool.name || name, tool);
    }
  }
  return [...byName.values()];
}

/** Wrap an MCP JSON Schema object as a TypeBox schema for AgentTool.parameters. */
export function jsonSchemaParameters(schema: unknown): TSchema {
  if (schema && typeof schema === 'object') {
    try {
      return Type.Unsafe(schema);
    } catch {
      /* fall through */
    }
  }
  return Type.Record(Type.String(), Type.Any());
}

export function extractToolDetails(result: unknown): unknown {
  if (result && typeof result === 'object' && 'details' in (result as object)) {
    return (result as { details?: unknown }).details;
  }
  return result;
}
