import { z } from 'zod';

export const VoiceSessionCreateSchema = z.object({ conversationId: z.string().uuid().optional() }).strict();

export const VoiceWorkStartSchema = z.object({
  objective: z.string().trim().min(1).max(4_000),
  employeeId: z.string().trim().min(1).max(160).optional(),
}).strict();
export const VoiceWorkTaskSchema = z.object({ taskId: z.string().uuid() }).strict();
export const VoiceWorkBindingSchema = z.object({
  version: z.literal(1), taskId: z.string().uuid(), conversationId: z.string().uuid(),
  orgId: z.string().min(1), userId: z.string().min(1), employeeId: z.string(),
  title: z.string().max(80), createdAt: z.number(), turnId: z.string().uuid().optional(),
});
export type VoiceWorkBinding = z.infer<typeof VoiceWorkBindingSchema>;
export const VoiceWorkResultSchema = z.object({
  ok: z.boolean(), taskId: z.string().optional(), conversationId: z.string().optional(),
  title: z.string().optional(), status: z.string(), spokenSummary: z.string().max(240),
  artifactCount: z.number().optional(),
});
export type VoiceWorkResult = z.infer<typeof VoiceWorkResultSchema>;
export const VoiceWorkNoticeSchema = z.object({
  type: z.literal('completed'), taskId: z.string().uuid(), text: z.string().trim().min(1).max(50),
}).strict();
export type VoiceWorkNotice = z.infer<typeof VoiceWorkNoticeSchema>;
