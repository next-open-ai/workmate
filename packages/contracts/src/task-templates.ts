import { z } from 'zod';

const EntrySchema = z.object({ skillId: z.string().min(1), version: z.string().min(1), entry: z.string().min(1) });
export const TaskPresentationSchema = z.object({
  title: z.string().trim().max(100).default(''),
  accent: z.enum(['blue', 'green', 'violet']).default('blue'),
  showSummary: z.boolean().default(true), showRows: z.boolean().default(true),
  defaultTab: z.enum(['report', 'data']).default('report'),
}).strict();
export type TaskPresentation = z.infer<typeof TaskPresentationSchema>;
export const TaskDeliverySchema = z.object({
  storage: z.literal('task-results').default('task-results'),
  exports: z.array(z.enum(['json', 'html', 'csv'])).max(3).default(['json']),
}).strict();
export type TaskExportFormat = 'json' | 'html' | 'csv';
export const TaskTemplateSchema = z.object({
  id: z.string().min(1).max(120), version: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(120), description: z.string().trim().max(1000),
  input: EntrySchema, execution: EntrySchema, output: EntrySchema,
  view: EntrySchema, resultType: z.string(), resultVersion: z.string(),
  defaults: z.record(z.unknown()).optional(),
  presentation: TaskPresentationSchema.optional(), delivery: TaskDeliverySchema.optional(),
}).strict();
export type TaskTemplate = z.infer<typeof TaskTemplateSchema>;
export const TaskTemplateConfigurationSchema = TaskTemplateSchema.omit({ id: true, version: true });
export type TaskTemplateConfiguration = z.infer<typeof TaskTemplateConfigurationSchema>;
export interface TaskTemplateDefinition {
  id: string; orgId: string; ownerUserId: string; revision: number;
  draft: TaskTemplate; published: TaskTemplate[]; archived: boolean;
  verifiedRevision?: number; verifiedAt?: number; createdAt: number; updatedAt: number;
}
export interface TaskSkillDescriptor {
  id: string; version: string; name: string; description: string;
  inputType: string; resultType: string; resultVersion: string;
  entries: { input: string; execution: string; output: string; view: string };
  exports: TaskExportFormat[];
}
export interface TaskTemplateTrial {
  revision: number; data: Record<string, unknown>; html: string;
  checks: string[];
}
export const TemplateTaskInputSchema = z.object({
  name: z.string().trim().min(1).max(120), templateId: z.string().min(1),
  templateVersion: z.string().min(1), parameters: z.record(z.unknown()),
}).strict();
export type TemplateTaskInput = z.infer<typeof TemplateTaskInputSchema>;
export interface TemplateTask extends TemplateTaskInput {
  id: string; orgId: string; ownerUserId: string; revision: number;
  createdAt: number; updatedAt: number;
}
export interface TaskResult {
  id: string; taskId: string; runId: string; type: string; schemaVersion: string;
  title: string; createdAt: number; data: Record<string, unknown>;
  view: z.infer<typeof EntrySchema>;
  presentation?: TaskPresentation;
  delivery?: z.infer<typeof TaskDeliverySchema>;
}
export interface TemplateTaskRun {
  id: string; taskId: string; taskRevision: number; template: TaskTemplate;
  inputSnapshot: Record<string, unknown>; startedAt: number; finishedAt?: number;
  status: 'running' | 'completed' | 'failed'; error?: string;
  steps: Array<{ stage: 'input' | 'execution' | 'output'; status: 'completed' | 'failed'; at: number }>;
  result?: TaskResult;
}
export interface TemplateTaskDetail { task: TemplateTask; runs: TemplateTaskRun[] }

const MoneySchema = z.number().finite().min(0).max(1_000_000_000)
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.0001, '金额最多两位小数');
export const BusinessSummaryInputSchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, '请选择有效月份'),
  rows: z.array(z.object({
    name: z.string().trim().min(1).max(100), revenue: MoneySchema, cost: MoneySchema,
  }).strict()).min(1).max(100),
}).strict();
export type BusinessSummaryInput = z.infer<typeof BusinessSummaryInputSchema>;
export const BusinessSummaryResultSchema = z.object({
  period: z.string(), currency: z.literal('CNY'), revenue: z.number().finite(),
  cost: z.number().finite(), profit: z.number().finite(), margin: z.number().finite().nullable(),
  rows: z.array(z.object({ name: z.string(), revenue: z.number(), cost: z.number(), profit: z.number() })),
  summary: z.string(),
});
