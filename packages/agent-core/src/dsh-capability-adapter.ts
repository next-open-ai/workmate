import { harvestWorkspaceDeliverables } from './skill-runtime.js';
import { WorkspaceCapabilityKernel, type CapabilityContext } from './capability-kernel.js';

/**
 * DSH owns its local fs/bash plugins, so it cannot invoke TypeScript tools per
 * call without a dedicated DSH plugin. This adapter owns the shared workspace
 * contract and the post-run atomic publication boundary until that plugin is
 * installed. It is intentionally separate from DSH's own tool configuration.
 */
export class DshCapabilityAdapter {
  private readonly kernel: WorkspaceCapabilityKernel;

  constructor(context: CapabilityContext) {
    this.kernel = new WorkspaceCapabilityKernel(context);
  }

  systemPromptContract() {
    return [
      'Workmate capability policy: operate only inside the current workspace.',
      'Use the engine filesystem and bash tools only for the task. Do not access parent paths or network resources.',
      'For a conversation deliverable, write the finished file under output/. It will be verified and atomically committed only after this run completes successfully.',
    ].join(' ');
  }

  async commitCompletedArtifacts(startedAtMs: number): Promise<string[]> {
    if (this.kernel.context.workspaceMode === 'project') return [];
    const candidates = await harvestWorkspaceDeliverables(this.kernel.root, { startedAtMs });
    // A multi-file website is a single package, rooted at index.html.  Emitting
    // every dependent stylesheet/image would archive broken, standalone files.
    if (candidates.includes('output/index.html')) return ['output/index.html'];
    const committed: string[] = [];
    for (const candidate of candidates) {
      const result = await this.kernel.commitArtifact(candidate);
      if (result.ok && result.deliverable && result.path) committed.push(result.path);
    }
    return [...new Set(committed)];
  }
}
