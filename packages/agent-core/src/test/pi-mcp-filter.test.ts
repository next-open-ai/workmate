import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentSkillRuntime } from '@workmate/contracts';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '../pi-tools.js';
import { filterMcpToolsetForTask } from '../pi-runtime.js';

function tool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: { ok: true } }),
  };
}

function skill(partial: Partial<AgentSkillRuntime> = {}): AgentSkillRuntime {
  return {
    id: partial.id || 'skill-baseline-pdf-report',
    name: partial.name || 'PDF 报告生成',
    description: partial.description || '生成 PDF 行程',
    mode: partial.mode || 'available',
    instructions: partial.instructions || 'Write the final PDF under output/.',
    resources: partial.resources ?? [],
    execution: partial.execution ?? {
      allowWorkspaceWrite: true,
      allowScriptExecution: true,
      allowedNetworkHosts: [],
      allowAllNonDestructive: false,
    },
  };
}

test('document artifact tasks hide irrelevant finance and sequential-thinking MCP tools', () => {
  const filtered = filterMcpToolsetForTask({
    tools: [
      tool('mcp_akshare_list_akshare_categories_tool'),
      tool('mcp_sequential_thinking_sequentialthinking'),
      tool('mcp_filesystem_list_allowed_directories'),
      tool('mcp_amap_maps_geocode'),
    ],
    toolDescriptors: [
      { name: 'mcp_akshare_list_akshare_categories_tool', description: 'finance', inputSchema: { type: 'object' } },
      { name: 'mcp_sequential_thinking_sequentialthinking', description: 'reasoning', inputSchema: { type: 'object' } },
      { name: 'mcp_filesystem_list_allowed_directories', description: 'filesystem', inputSchema: { type: 'object' } },
      { name: 'mcp_amap_maps_geocode', description: 'map', inputSchema: { type: 'object' } },
    ],
    labels: ['Akshare', 'Sequential Thinking', 'Filesystem', 'Amap Maps'],
    instructions: 'Available MCP tools for this run: ...',
    close: async () => undefined,
  }, '创建一个从上海到西藏的10天的行程pdf', [skill()]);

  assert.deepEqual(filtered.tools.map((item) => item.name), ['mcp_amap_maps_geocode']);
  assert.deepEqual(filtered.labels, ['Amap Maps']);
  assert.equal(filtered.instructions, '');
});
