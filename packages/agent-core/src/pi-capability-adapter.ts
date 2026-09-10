import type { AgentTool } from '@mariozechner/pi-agent-core';
import {
  createCodingTools,
  createReadOnlyTools,
} from '@mariozechner/pi-coding-agent';
import { Type, defineAgentTool } from './pi-tools.js';
import { WorkspaceCapabilityKernel, type CapabilityContext } from './capability-kernel.js';

/**
 * Pi adapter. Pi performs ordinary filesystem operations with its unmodified
 * native coding tools; Workmate only selects tools by permission, hooks bash
 * at Pi's documented spawn boundary, and owns the artifact commit boundary.
 */
export function createPiCapabilityTools(context: CapabilityContext): AgentTool<any>[] {
  const kernel = new WorkspaceCapabilityKernel(context);
  const cwd = kernel.root;
  const nativeTools = context.workspaceAccess === 'read'
    ? createReadOnlyTools(cwd)
    : createCodingTools(cwd, {
      bash: { spawnHook: (spawn) => ({ ...spawn, cwd, command: kernel.assertCommand(spawn.command) }) },
    });
  const commitArtifact = defineAgentTool({
    name: 'commit_artifact',
    label: 'commit_artifact',
    description: 'Verify and atomically publish one finished user-facing file. Call this only after write/edit succeeds. Only a committed artifact is shown in the asset library.',
    parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 240 }) }),
    execute: ({ path }) => kernel.commitArtifact(path),
  });

  return [...nativeTools, ...(context.workspaceAccess === 'read' ? [] : [commitArtifact])];
}
