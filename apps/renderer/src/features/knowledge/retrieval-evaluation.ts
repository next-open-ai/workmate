import { RetrievalEvaluationSchema, type RetrievalEvaluation } from '@workmate/contracts';

export const MAX_EVALUATION_BYTES = 2 * 1024 * 1024;
export function parseEvaluation(raw: string, knowledgeBaseId: string): RetrievalEvaluation {
  if (new TextEncoder().encode(raw).length > MAX_EVALUATION_BYTES) throw new Error('评测文件不能超过 2 MB。');
  let input: unknown;
  try { input = JSON.parse(raw); } catch { throw new Error('文件不是有效的 JSON。'); }
  const parsed = RetrievalEvaluationSchema.safeParse(input);
  if (!parsed.success) throw new Error('文件格式不正确：请参考格式示例；每题方案需一致，ID不能重复，最多100题、5种方案。');
  if (parsed.data.knowledgeBaseId !== knowledgeBaseId) throw new Error('报告不属于当前知识库，请切换到对应知识库。');
  if (parsed.data.cases.some(c => c.relevantGroups === null)) throw new Error('还有题目未标注正确来源。relevantGroups 为 null 表示未标注，空数组表示确认无答案。');
  return parsed.data;
}

const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
export function evaluateRetrieval(data: RetrievalEvaluation) {
  if (data.cases.some(c => c.relevantGroups === null)) throw new Error('评测需要完整标注。');
  const rows = data.cases.flatMap(sample => sample.runs.map(run => {
    const groups = sample.relevantGroups!;
    const seen = new Set<number>();
    const hits = run.hits.slice(0, data.topK);
    let firstRank = 0, dcg = 0;
    hits.forEach((hit, index) => {
      const group = groups.findIndex(ids => ids.includes(hit.id));
      if (group < 0 || seen.has(group)) return;
      seen.add(group); firstRank ||= index + 1; dcg += 1 / Math.log2(index + 2);
    });
    const ideal = Array.from({ length: Math.min(groups.length, data.topK) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
    return { id: sample.id, query: sample.query, variant: run.variant, returned: hits.length,
      firstRank: firstRank || null, hit: groups.length ? Number(firstRank > 0) : null,
      recall: groups.length ? seen.size / groups.length : null,
      mrr: groups.length ? (firstRank ? 1 / firstRank : 0) : null,
      precision: groups.length ? (hits.length ? seen.size / hits.length : 0) : null,
      ndcg: ideal ? dcg / ideal : null, emptyCorrect: groups.length ? null : Number(hits.length === 0),
      elapsedMs: run.elapsedMs ?? null };
  }));
  const summaries = data.cases[0].runs.map(run => {
    const selected = rows.filter(r => r.variant === run.variant);
    const values = (key: 'hit' | 'recall' | 'mrr' | 'precision' | 'ndcg' | 'emptyCorrect' | 'elapsedMs') => selected.flatMap(r => r[key] === null ? [] : [r[key]!]);
    const times = values('elapsedMs').sort((a, b) => a - b);
    return { variant: run.variant, answerable: values('recall').length, noAnswer: values('emptyCorrect').length,
      hit: mean(values('hit')), recall: mean(values('recall')), mrr: mean(values('mrr')), precision: mean(values('precision')),
      ndcg: mean(values('ndcg')), emptyCorrect: mean(values('emptyCorrect')),
      timingCount: times.length, p95Ms: times.length ? times[Math.ceil(times.length * .95) - 1] : null };
  });
  return { topK: data.topK, rows, summaries };
}
export type EvaluationReport = ReturnType<typeof evaluateRetrieval>;
export const metric = (value: number | null) => value === null ? '未评测' : `${(value * 100).toFixed(1)}%`;
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function evaluationHtml(data: RetrievalEvaluation, report: EvaluationReport): string {
  const cells = (values: unknown[]) => values.map(v => `<td>${escape(v)}</td>`).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Workmate 离线召回评测报告</title><style>body{font:15px/1.7 system-ui;margin:32px;color:#202638}table{border-collapse:collapse;width:100%;margin:20px 0}th,td{border:1px solid #ddd;padding:10px;text-align:left;overflow-wrap:anywhere}h1{font-size:25px}.scroll{overflow:auto}</style><h1>Workmate · 离线召回评测报告</h1><p>知识库：${escape(data.knowledgeBaseId)} · 快照：${escape(data.snapshot)} · Top ${data.topK} · ${data.cases.length}题</p><p>仅依据人工标注和导入快照计算，不验证来源当前有效性，不改变查询或配置。未标注的返回ID视为不相关；同组证据只计一次。资料版本一致性由采集者确认。无答案题单独统计。耗时仅依据提供的记录，不能视为性能基准。</p><div class="scroll"><table><tr><th>方案</th><th>有答案/无答案题</th><th>命中率</th><th>证据找全率</th><th>MRR</th><th>有效结果占比</th><th>nDCG</th><th>无答案空返回率</th><th>P95耗时/样本数</th></tr>${report.summaries.map(r => `<tr>${cells([r.variant, `${r.answerable}/${r.noAnswer}`, metric(r.hit), metric(r.recall), r.mrr?.toFixed(3) ?? '未评测', metric(r.precision), r.ndcg?.toFixed(3) ?? '未评测', metric(r.emptyCorrect), r.p95Ms === null ? '未采集' : `${r.p95Ms}ms / ${r.timingCount}`])}</tr>`).join('')}</table></div><h2>逐题明细</h2><div class="scroll"><table><tr><th>题目</th><th>问题</th><th>方案</th><th>首个有效排名</th><th>证据找全率</th><th>返回数</th></tr>${report.rows.map(r => `<tr>${cells([r.id, r.query, r.variant, r.firstRank ?? '未命中', metric(r.recall), r.returned])}</tr>`).join('')}</table></div></html>`;
}
