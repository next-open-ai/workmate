import type { WikiDirectory, WikiPageView, WikiPage, WikiSearchHit, WikiRelatedPage, WikiSources,
  WikiGenerationJob, WikiGenerationRequest, WikiContent, WikiMergePreview, WikiMergeBody } from '@workmate/contracts';
import { getStoredSessionToken } from './auth';

const base = () => window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
export function wikiGenerationFailureMessage(code: string | null): string {
  const messages: Record<string, string> = {
    MODEL_TIMEOUT: '本批模型调用超时。请减少所选资料，或检查模型服务后重新生成。',
    MODEL_UNAVAILABLE: '模型服务未能完成请求。请检查模型配置和网络后重新生成。',
    MODEL_OUTPUT_TRUNCATED: '模型输出达到长度上限，结果不完整。请减少所选资料或更换模型后重新生成。',
    INVALID_MODEL_OUTPUT: '模型返回的内容格式不符合要求。请减少所选资料或更换模型后重新生成。',
    INVALID_MODEL_REFERENCE: '模型引用了不存在的原文块，结果未被接受。请更换模型或减少资料后重新生成。',
    INVALID_MODEL_LINK: '模型生成的页面链接无效，结果未被接受。请重新生成或更换模型。',
    INCOMPLETE_COVERAGE: '模型遗漏了部分资料的引用，结果未被接受。请减少所选资料或更换模型后重新生成。',
    INVALID_EVIDENCE: '原文证据校验失败。请检查资料并重新入库后再生成。',
    SOURCE_CHANGED: '生成期间原文已变化或不可用。请检查资料后重新选择并生成。',
  };
  return (code && Object.hasOwn(messages, code) ? messages[code] : undefined)
    ?? '生成未完成。请检查模型和资料；如有已保存草稿，请先查看，再决定是否重新生成。';
}
export class WikiRequestError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
async function request<T>(kb: string, suffix: string, body?: unknown, method?: 'PUT'): Promise<T> {
  const response = await fetch(`${base()}/api/knowledge/${encodeURIComponent(kb)}/wiki${suffix}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'x-workmate-session': getStoredSessionToken() || '', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(method === 'PUT' ? { signal: AbortSignal.timeout(30000) } : {}),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    const labels: Record<string, string> = { LIMIT_EXCEEDED: '资料较多，请减少选择并分批生成。',
      VERSIONED_SOURCES_REQUIRED: '所选资料缺少完整版本证据或含已删除的块，请重新入库后再试。',
      INVALID_EVIDENCE: '原文证据不可用，请检查资料后重新入库。', CAPACITY_EXCEEDED: '本知识库已有生成任务，请稍后再试。',
      SOURCE_CHANGED: '来源已变化，请重新生成并核对。', REVISION_CONFLICT: '页面已变化，请刷新后核对。',
      NOT_FOUND: '页面、来源或任务不可访问。', IDEMPOTENCY_CONFLICT: '请求已变化，请重新发起。' };
    labels.RESUME_UNAVAILABLE = '此任务无法继续或已达到续跑次数上限，请重新生成。';
    labels.MODEL_CHANGED = '当前模型与原任务不同，请切回原模型继续，或选择重新生成。';
    labels.MERGE_LIMIT_EXCEEDED = '合并内容超出单页容量，请精简草稿或保留为独立页面。';
    throw new WikiRequestError(String(error.code || 'WIKI_UNAVAILABLE'), labels[error.code] || 'Wiki 操作未完成，请稍后重试。');
  }
  return response.json();
}
export const wikiApi = {
  mergeCandidates: (kb: string, id: string) => request<{ items: { pageId: string; title: string }[] }>(kb, `/pages/${encodeURIComponent(id)}/merge-candidates`),
  mergePreview: (kb: string, id: string, target: string) => request<WikiMergePreview>(kb, `/pages/${encodeURIComponent(id)}/merge-preview?targetPageId=${encodeURIComponent(target)}`),
  merge: (kb: string, id: string, input: WikiMergeBody) => request<WikiPage>(kb, `/pages/${encodeURIComponent(id)}/merge`, input),
  list: (kb: string, drafts: boolean, after?: string) => request<WikiDirectory>(kb, `/pages?view=${drafts ? 'drafts' : 'published'}&limit=20${after ? '&afterPageId=' + encodeURIComponent(after) : ''}`),
  read: (kb: string, id: string, drafts: boolean) => request<WikiPageView>(kb, `/pages/${encodeURIComponent(id)}?view=${drafts ? 'drafts' : 'published'}`),
  revision: (kb: string, id: string, revisionId: string) => request<WikiPageView>(kb, `/pages/${encodeURIComponent(id)}?revisionId=${encodeURIComponent(revisionId)}`),
  edit: (kb: string, view: WikiPageView, content: WikiContent, idempotencyKey: string) => request<WikiPage>(kb,
    `/pages/${encodeURIComponent(view.page.pageId)}/draft`, { baseGeneration: view.page.generation,
      slug: view.page.slug, content, idempotencyKey }, 'PUT'),
  sources: (kb: string, id: string, revisionId: string) => request<WikiSources>(kb, `/pages/${encodeURIComponent(id)}/sources?revisionId=${encodeURIComponent(revisionId)}`),
  search: (kb: string, query: string) => request<{ items: WikiSearchHit[] }>(kb, `/search?query=${encodeURIComponent(query)}`),
  related: (kb: string, id: string) => request<{ items: WikiRelatedPage[] }>(kb, `/pages/${encodeURIComponent(id)}/related`),
  publish: (kb: string, view: WikiPageView) => request<WikiPage>(kb, `/pages/${encodeURIComponent(view.page.pageId)}/publish`, {
    baseGeneration: view.page.generation, draftRevisionId: view.revision.revisionId,
    contentHash: view.revision.contentHash, idempotencyKey: `publish:${view.revision.revisionId}`,
  }),
  start: (kb: string, input: WikiGenerationRequest) => request<WikiGenerationJob>(kb, '/generation-jobs', input),
  job: (kb: string, id: string) => request<WikiGenerationJob>(kb, `/generation-jobs/${encodeURIComponent(id)}`),
  jobs: (kb: string) => request<{ items: WikiGenerationJob[] }>(kb, '/generation-jobs'),
  cancel: (kb: string, id: string) => request<WikiGenerationJob>(kb, `/generation-jobs/${encodeURIComponent(id)}/cancel`, {}),
};
export async function downloadWikiSource(version: string, fileName: string): Promise<void> {
  const response = await fetch(`${base()}/api/knowledge/sources/${encodeURIComponent(version)}`, {
    headers: { 'x-workmate-session': getStoredSessionToken() || '' },
  });
  if (!response.ok) throw new Error('原文件暂不可下载，请检查来源是否仍可用。');
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
