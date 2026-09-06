import type { RuntimeSkill } from '../services/api.js';
import type { ExecutionLevel } from './capabilities.js';
import { defaultSkillExecution } from './capabilities.js';

/** Stable id for the platform-injected workspace harness (not user-editable). */
export const BASELINE_WORKSPACE_SKILL_ID = 'workmate-workspace';

const BASELINE_INSTRUCTIONS = `---
name: workmate-workspace
description: Workmate platform workspace harness for isolated read/write and script execution in the current run directory, plus optional publish into a shared project workspace.
---

You are using the **Workmate workspace harness** (\`workmate-workspace\`). It is always authorized for this run.

## Two directories (do not confuse them)

1. **Run workspace** (isolated, per attempt) — generators, scratch, and process scripts live here (prefer \`scripts/\`). Users do **not** browse this tree in the project UI.
2. **Business outputs** — finished products the user should keep. They **must** live under \`output/\`. Only \`output/\` is archived to the asset library / auto-promoted to a project.

## Tools (always pass skillId \`workmate-workspace\` unless noted)

- \`read_workspace_file\` — read text already in the **run** workspace (no skillId).
- \`write_workspace_file\` — create/replace/append text. Process files: any path outside \`output/\`. Deliverables: path under \`output/\` **or** \`deliverable: true\` (auto-places under \`output/\`).
- \`run_workspace_script\` — execute a \`.py\` / \`.sh\` / \`.js\` you wrote (prefer \`scripts/…\`). Scripts should write finals to \`output/<name>\`.
- \`register_deliverable\` — copy an existing finished file into \`output/\` and mark it for the asset library (use for final \`.py\`/\`.js\` products — never for throwaway generators).
- \`install_python_dependency\` — install a PyPI package into \`.python-packages\` for workspace scripts only.
- \`publish_to_project\` — promote an \`output/\` deliverable into the **shared project workspace** (project-bound runs only).

### Deliverable contract (important)

- **Intent, not file-type guessing:** a final product may be PDF, HTML, **or** a \`.py\`/\`.js\` the user asked for.
- Generators stay outside \`output/\` (e.g. \`scripts/generate_pdf.py\`).
- Finished products go to \`output/上海到桂林5日游行程.pdf\` or \`output/analyze.py\`.
- Do **not** register \`__pycache__\`, tooling under \`scripts/\`, or other process paths.

### write_workspace_file contract

- Args: \`skillId\`, \`path\`, and either \`content\` (≤12KB) or \`chunks\` (each ≤4KB), optional \`mode\`: \`replace\` | \`append\`, optional \`deliverable\`: boolean.
- **Keep each call small** (ideally ≤6KB).
- For a website: write pages under \`output/\` (or \`deliverable: true\`).
- Do not claim a file was saved unless the tool returned \`ok: true\`.

### publish_to_project contract

- Source should be under \`output/\`. Process paths are rejected.
- The left project file tree updates after publish, end-of-run auto-promote of \`output/\`, or client sync.

## Rules

1. Build with process files; finish by placing products under \`output/\` (or \`register_deliverable\`).
2. When a project is bound, \`publish_to_project\` each \`output/\` asset (auto-promote also runs at the end).
3. Respect the run permission tier: read-only runs cannot write, execute scripts, or publish.
4. Missing files on \`read_workspace_file\` mean they are not created yet — write them; do not treat ENOENT as a hard stop.
`;

export const baselineWorkspaceSkillMeta = {
  id: BASELINE_WORKSPACE_SKILL_ID,
  name: 'Workmate Workspace',
  description: 'Platform harness: isolated run workspace I/O/scripts, output/ deliverables, plus publish_to_project for shared project trees.',
  source: 'builtin' as const,
  status: 'ready' as const,
  risk: 'medium' as const,
  tags: ['platform', 'workspace'],
  systemOnly: true,
};

/** Maps UI permission tier to harness execution flags (single policy surface). */
export function baselineExecutionForTier(tier: ExecutionLevel) {
  const base = defaultSkillExecution(tier);
  return {
    allowWorkspaceWrite: tier !== 'read-only' && base.allowWorkspaceWrite,
    allowScriptExecution: tier !== 'read-only' && base.allowScriptExecution,
    allowedNetworkHosts: [] as string[],
    allowAllNonDestructive: tier === 'full' && base.allowAllNonDestructive,
  };
}

/** Runtime Skill payload merged into every agent run before user-selected Skills. */
export function buildBaselineWorkspaceRuntimeSkill(tier: ExecutionLevel): RuntimeSkill {
  return {
    id: BASELINE_WORKSPACE_SKILL_ID,
    name: baselineWorkspaceSkillMeta.name,
    description: baselineWorkspaceSkillMeta.description,
    mode: 'default',
    instructions: BASELINE_INSTRUCTIONS,
    resources: [],
    execution: baselineExecutionForTier(tier),
  };
}

export function mergeRuntimeSkills(tier: ExecutionLevel, userSkills: RuntimeSkill[]): RuntimeSkill[] {
  const baseline = buildBaselineWorkspaceRuntimeSkill(tier);
  const rest = userSkills.filter((skill) => skill.id !== BASELINE_WORKSPACE_SKILL_ID);
  return [baseline, ...rest];
}
