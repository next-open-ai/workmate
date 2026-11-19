import { z } from 'zod';

const text = z.string().trim().min(1).max(500);
const hit = z.object({ id: text, title: z.string().max(500) }).strict();
export const RetrievalEvaluationSchema = z.object({
  version: z.literal(1), knowledgeBaseId: text, snapshot: text,
  topK: z.number().int().min(1).max(20),
  cases: z.array(z.object({
    id: text, query: z.string().trim().min(1).max(2000),
    relevantGroups: z.array(z.array(text).min(1).max(20)).max(50).nullable(),
    runs: z.array(z.object({
      variant: text, hits: z.array(hit).max(20),
      elapsedMs: z.number().finite().min(0).max(3_600_000).optional(),
    }).strict()).min(1).max(5),
  }).strict()).min(1).max(100),
}).strict().superRefine((data, ctx) => {
  if (!data.cases.length) return;
  const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (new Set(data.cases.map(c => c.id)).size !== data.cases.length) fail('题目ID不能重复');
  const variants = JSON.stringify(data.cases[0].runs.map(r => r.variant).sort());
  for (const sample of data.cases) {
    if (new Set(sample.runs.map(r => r.variant)).size !== sample.runs.length) fail('同题方案名称不能重复');
    if (JSON.stringify(sample.runs.map(r => r.variant).sort()) !== variants) fail('所有题目必须具有相同的方案集合');
    const ids = sample.relevantGroups?.flat() ?? [];
    if (new Set(ids).size !== ids.length) fail('标准证据组的ID不能重复或跨组重叠');
  }
});
export type RetrievalEvaluation = z.infer<typeof RetrievalEvaluationSchema>;
