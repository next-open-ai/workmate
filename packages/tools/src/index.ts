import type { z } from 'zod';

export type ToolRisk = 'read' | 'write' | 'execute' | 'external';

export interface OpcaiTool<TSchema extends z.ZodType = z.ZodType> {
  id: string;
  description: string;
  risk: ToolRisk;
  inputSchema: TSchema;
  execute(input: z.infer<TSchema>, signal: AbortSignal): Promise<unknown>;
}

export interface ToolPolicy {
  requiresApproval(risk: ToolRisk): boolean;
}
