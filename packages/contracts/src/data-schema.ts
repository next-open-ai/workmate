import { z } from 'zod';

export const dataColumnSchema = z.object({
  id: z.string().min(1), name: z.string().min(1).max(100),
  type: z.enum(['文本', '整数', '小数', '日期', '布尔值']),
  nullable: z.boolean(), sample: z.string(), description: z.string().max(1000).optional(),
});
export type DataColumn = z.infer<typeof dataColumnSchema>;
