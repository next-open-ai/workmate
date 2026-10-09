import { z } from 'zod';

export const dataColumnSchema = z.object({
  id: z.string().min(1), name: z.string().min(1).max(100),
  sourceName: z.string().optional(),
  type: z.enum(['文本', '整数', '小数', '日期', '布尔值']),
  nullable: z.boolean(), sample: z.string(), description: z.string().max(1000).optional(),
  unit: z.string().max(100).optional(),
  enumDescription: z.string().max(1000).optional(),
  sensitive: z.boolean().optional(),
});
export type DataColumn = z.infer<typeof dataColumnSchema>;

// Delivery facts, not an inference about the associated Agent run.
export const dataAppDeliverySchema = z.object({
  mode: z.enum(['template', 'custom']),
  status: z.enum(['template-ready', 'awaiting-binding', 'custom-ready']),
});
export type DataAppDelivery = z.infer<typeof dataAppDeliverySchema>;

export const dataApiFieldAnnotationSchema = z.object({
  path: z.string().trim().min(1).max(300),
  location: z.enum(['query', 'path', 'header', 'body', 'response']),
  type: z.enum(['string', 'number', 'integer', 'boolean', 'object', 'array']),
  required: z.boolean(),
  description: z.string().max(1000),
});
export const dataObjectAnnotationsSchema = z.object({
  description: z.string().max(4000).default(''),
  connectionDescription: z.string().max(4000).default(''),
  apiUrlDescription: z.string().max(2000).default(''),
  apiFields: z.array(dataApiFieldAnnotationSchema).max(300).default([]),
}).superRefine((value, ctx) => {
  const keys = new Set<string>();
  value.apiFields.forEach((field, index) => {
    const key = `${field.location}:${field.path}`;
    if (keys.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['apiFields', index], message: '参数位置和路径不能重复。' });
    keys.add(key);
  });
});
export type DataObjectAnnotations = z.infer<typeof dataObjectAnnotationsSchema>;
export type DataApiFieldAnnotation = z.infer<typeof dataApiFieldAnnotationSchema>;

export const dataResourceSchema = z.object({
  id: z.string(), name: z.string(), sheetName: z.string(), rowCount: z.number(),
  description: z.string().max(4000).optional(), columns: z.array(dataColumnSchema),
});
export type DataResource = z.infer<typeof dataResourceSchema>;
export const dataObjectModelSchema = z.object({
  id: z.string(), name: z.string(), kind: z.string(),
  annotations: dataObjectAnnotationsSchema,
  resources: z.array(dataResourceSchema.omit({ rowCount: true }).extend({
    columns: z.array(dataColumnSchema.omit({ sample: true })),
  })),
  api: z.object({ method: z.string(), url: z.string(), itemsPath: z.string(), description: z.string() }).optional(),
  operations: z.array(z.enum(['query', 'options'])),
});
export type DataObjectModelSchema = z.infer<typeof dataObjectModelSchema>;

export const remoteDatabaseTableSchema = z.object({
  schema: z.string().min(1).max(128), name: z.string().min(1).max(128),
});
export const remoteDatabaseConnectionSchema = z.object({
  engine: z.enum(['mysql', 'postgresql']),
  host: z.string().trim().min(1).max(253).regex(/^[a-zA-Z0-9_.:\-]+$/, '请填写主机名或 IP，不含协议和路径。'),
  port: z.number().int().min(1).max(65535).optional(),
  user: z.string().trim().min(1).max(128),
  password: z.string().max(4096).default(''),
  database: z.string().trim().max(128).default(''),
  tls: z.boolean().default(true), ca: z.string().max(32768).default(''),
}).transform(value => ({ ...value, port: value.port ?? (value.engine === 'mysql' ? 3306 : 5432) }));
export type RemoteDatabaseConnection = z.infer<typeof remoteDatabaseConnectionSchema>;
export const remoteDatabaseImportSchema = z.object({
  connection: remoteDatabaseConnectionSchema,
  name: z.string().trim().min(1).max(100),
  tables: z.array(remoteDatabaseTableSchema).min(1).max(20),
}).superRefine((value, ctx) => {
  if (!value.connection.database) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['connection', 'database'], message: '请选择数据库。' });
  const keys = value.tables.map(t => JSON.stringify([t.schema, t.name]));
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tables'], message: '不能重复选择表。' });
});
export type RemoteDatabaseImport = z.infer<typeof remoteDatabaseImportSchema>;
export type RemoteDatabasePublicConnection = Omit<RemoteDatabaseConnection, 'password'> & {
  tables: z.infer<typeof remoteDatabaseTableSchema>[]; lastSyncedAt: number; truncatedTables: string[];
};
