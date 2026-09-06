/**
 * Lightweight project context budgets (P0).
 *
 * Soft → 提配到 boost 上限 → 仍超则截断并标注。
 * Never throws / never blocks execution.
 */

export const CONTEXT_BUDGET = {
  objectiveSoft: 6_000,
  objectiveBoost: 12_000,
  dependencyPerParentSoft: 2_500,
  dependencyPerParentBoost: 5_000,
  dependencyTotalSoft: 8_000,
  dependencyTotalBoost: 16_000,
  summaryPerTaskSoft: 2_000,
  summaryPerTaskBoost: 4_000,
  summaryTotalSoft: 12_000,
  summaryTotalBoost: 24_000,
} as const;

export function fitBudget(
  text: string,
  softLimit: number,
  boostLimit: number,
  label?: string,
): { text: string; boosted: boolean } {
  const raw = String(text ?? '');
  if (raw.length <= softLimit) return { text: raw, boosted: false };
  // 提配：放宽到 boostLimit，执行不中断。
  if (raw.length <= boostLimit) return { text: raw, boosted: true };
  const note = label
    ? `\n…[上下文已提配截断：${label}；完整内容见任务产物/项目工作区]`
    : '\n…[上下文已提配截断；完整内容见任务产物/项目工作区]';
  const keep = Math.max(0, boostLimit - note.length);
  return { text: `${raw.slice(0, keep)}${note}`, boosted: true };
}

/** Keep head + tail so conclusions near the end are less likely to be dropped. */
function headTail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.55);
  const tail = Math.max(0, limit - head - 8);
  return `${text.slice(0, head)}\n…\n${text.slice(-tail)}`;
}

export function fitObjective(objective: string): string {
  return fitBudget(objective, CONTEXT_BUDGET.objectiveSoft, CONTEXT_BUDGET.objectiveBoost, '任务目标').text;
}

export function buildDependencyBlock(
  entries: Array<{ title: string; content: string }>,
): string {
  if (!entries.length) return '';
  const parts = entries.map((entry) => {
    const body = headTail(
      (entry.content || '无可用结果').trim() || '无可用结果',
      CONTEXT_BUDGET.dependencyPerParentBoost,
    );
    const fitted = fitBudget(
      body,
      CONTEXT_BUDGET.dependencyPerParentSoft,
      CONTEXT_BUDGET.dependencyPerParentBoost,
      entry.title,
    );
    return `### ${entry.title}\n${fitted.text}`;
  });
  const joined = fitBudget(
    parts.join('\n\n'),
    CONTEXT_BUDGET.dependencyTotalSoft,
    CONTEXT_BUDGET.dependencyTotalBoost,
    '前置任务汇总',
  );
  return `\n\n前置任务结果（摘要优先；完整交付见项目文件/工作区，请勿重复无关工作）：\n${joined.text}`;
}

export function buildSummaryEvidence(
  entries: Array<{ title: string; content: string }>,
): string {
  const parts = entries.map((entry) => {
    const fitted = fitBudget(
      (entry.content || '(无文本输出)').trim() || '(无文本输出)',
      CONTEXT_BUDGET.summaryPerTaskSoft,
      CONTEXT_BUDGET.summaryPerTaskBoost,
      entry.title,
    );
    return `### ${entry.title}\n${fitted.text}`;
  });
  return fitBudget(
    parts.join('\n\n'),
    CONTEXT_BUDGET.summaryTotalSoft,
    CONTEXT_BUDGET.summaryTotalBoost,
    '项目汇总证据',
  ).text;
}
