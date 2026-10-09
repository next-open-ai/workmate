import type { DataApp, DataSource } from '../../services/api';

// Only presentation of server facts; never infer an Agent's execution state.
export function appPresentation(app: Pick<DataApp, 'delivery' | 'customSite'>) {
  const pending = app.delivery?.status === 'awaiting-binding';
  return {
    pending,
    label: pending ? '待交付' : app.customSite?.bound ? '定制应用 · 可用' : '模板应用 · 可用',
    primary: pending ? '继续创建' : '打开应用',
    canShare: !pending,
  };
}

export function matchesSource(source: Pick<DataSource, 'name' | 'fileType' | 'summary' | 'annotations'>, query: string) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const text = [source.name, source.fileType, source.summary, source.annotations?.description, source.annotations?.connectionDescription].join(' ').toLocaleLowerCase();
  return words.every(word => text.includes(word));
}

export function sourceNextStep(hasDescription: boolean, annotated: number, total: number) {
  if (!hasDescription) return { action: 'description', label: '补充业务说明', note: '告诉 AI 这份数据的用途和统计口径。也可以直接创建应用。' };
  if (annotated < total) return { action: 'fields', label: '补充字段说明', note: `已标注 ${annotated} / ${total} 个字段。补充关键字段含义可帮助 AI 理解数据。` };
  return { action: 'create', label: '创建应用', note: '说明已准备好。选择模板，或描述你想要的应用。' };
}
