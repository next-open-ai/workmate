import type { SkillRecord } from './capabilities.js';

/**
 * Built-in skill catalog (20+ popular, high-utility packs).
 * Stable ids are merged on load; user edits to existing ids are preserved.
 * `instructions` are injected when the skill is authorized for a run (no SKILL.md path needed).
 */
type ExecLevel = 'read-only' | 'default' | 'full';

function exec(level: ExecLevel = 'default') {
  return {
    allowWorkspaceWrite: level !== 'read-only',
    allowScriptExecution: level !== 'read-only',
    allowedNetworkHosts: [] as string[],
    allowAllNonDestructive: level === 'full',
  };
}

export type BaselineCatalogSkill = SkillRecord & {
  instructions: string;
  category: string;
};

function skill(input: {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  risk?: SkillRecord['risk'];
  instructions: string;
  systemOnly?: boolean;
  write?: boolean;
  script?: boolean;
}): BaselineCatalogSkill {
  const execution = exec(input.script || input.write ? 'default' : 'read-only');
  if (input.write) execution.allowWorkspaceWrite = true;
  if (input.script) {
    execution.allowWorkspaceWrite = true;
    execution.allowScriptExecution = true;
  }
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    source: 'builtin',
    status: 'ready',
    risk: input.risk ?? 'low',
    tags: [input.category, ...input.tags],
    systemOnly: input.systemOnly,
    execution,
    instructions: input.instructions,
    category: input.category,
  };
}

export const BASELINE_CATALOG_SKILLS: BaselineCatalogSkill[] = [
  skill({
    id: 'skill-baseline-pdf-report',
    name: 'PDF 报告生成',
    description: '把分析结论做成可交付的中文 PDF 报告（排版、封面、目录级结构）。',
    category: '文档',
    tags: ['pdf', 'report', 'popular'],
    write: true,
    script: true,
    instructions:
      '当用户需要 PDF 报告时：先整理结构（标题/摘要/章节/结论），再在工作区用脚本生成 PDF（优先 TrueType 中文字体）。成品写入 output/，不要只给文字大纲。',
  }),
  skill({
    id: 'skill-baseline-docx',
    name: 'Word 文档撰写',
    description: '起草正式 Word/Markdown 文稿：纪要、方案、合同草案、说明文档。',
    category: '文档',
    tags: ['docx', 'writing', 'office'],
    write: true,
    instructions:
      '面向商务/办公文档：明确受众与语气，给出清晰标题层级与可执行段落。需要落盘时写入 output/ 下的 .md 或可转换稿件，避免空话。',
  }),
  skill({
    id: 'skill-baseline-spreadsheet',
    name: '表格与数据整理',
    description: '整理 CSV/Excel 风格数据，做汇总、透视思路与可下载表格产物。',
    category: '数据',
    tags: ['csv', 'excel', 'analytics'],
    write: true,
    script: true,
    instructions:
      '处理表格任务时优先产出结构化 CSV/Markdown 表，必要时用脚本清洗。说明字段含义与口径，成品放 output/。',
  }),
  skill({
    id: 'skill-baseline-slides',
    name: '演示文稿大纲',
    description: '把复杂主题压成演讲型幻灯片大纲：页标题、要点、讲者备注。',
    category: '文档',
    tags: ['pptx', 'presentation'],
    write: true,
    instructions:
      '按「一页一观点」组织：每页标题 + 3–5 条要点 + 可选备注。需要文件时输出 Markdown 幻灯片稿到 output/。',
  }),
  skill({
    id: 'skill-baseline-research',
    name: '研究综评',
    description: '多源信息综合：论点、证据、不确定点、可核查引用清单。',
    category: '研究',
    tags: ['research', 'evidence', 'popular'],
    instructions:
      '研究类任务：先澄清问题边界，再分论点组织证据；标注不确定与缺口；给出可执行下一步。有搜索/MCP 时优先取证，禁止编造来源。',
  }),
  skill({
    id: 'skill-baseline-competitive',
    name: '竞品对比',
    description: '产品/功能/定价维度的竞品矩阵与差异化建议。',
    category: '研究',
    tags: ['competitor', 'product'],
    write: true,
    instructions:
      '做竞品分析时建立统一对比维度（功能、定价、人群、渠道、优劣势），用表格呈现，并给出可落地的差异化建议。',
  }),
  skill({
    id: 'skill-baseline-data-viz',
    name: '数据可视化建议',
    description: '为指标选择合适图表，并给出可实现的可视化方案或脚本。',
    category: '数据',
    tags: ['chart', 'visualization'],
    write: true,
    script: true,
    instructions:
      '先确认指标与受众，再推荐图表类型；若需交付，生成可运行脚本或 HTML/图片产物到 output/。',
  }),
  skill({
    id: 'skill-baseline-sql',
    name: 'SQL 助手',
    description: '编写可读 SQL：查询、汇总、窗口函数、性能注意点。',
    category: '数据',
    tags: ['sql', 'database', 'popular'],
    instructions:
      '写 SQL 时说明假设表结构；给出可运行查询 + 简要解释；指出可能的性能坑与边界条件。',
  }),
  skill({
    id: 'skill-baseline-code-review',
    name: '代码审查',
    description: '按严重级别审查缺陷、可读性、安全与测试缺口。',
    category: '工程',
    tags: ['review', 'quality', 'popular'],
    instructions:
      '代码审查按 Critical/Major/Minor 分级；每条问题给位置、原因、改法。不纠缠风格偏好，聚焦正确性与风险。',
  }),
  skill({
    id: 'skill-baseline-debug',
    name: '问题排查',
    description: '系统性调试：复现路径、假设、验证、根因与修复建议。',
    category: '工程',
    tags: ['debug', 'troubleshoot'],
    write: true,
    script: true,
    instructions:
      '调试时先锁定复现步骤，再列假设并逐条验证；给出根因与最小修复。需要时写复现脚本到工作区。',
  }),
  skill({
    id: 'skill-baseline-tests',
    name: '测试用例编写',
    description: '补齐单元/集成测试思路与示例用例，覆盖边界与回归。',
    category: '工程',
    tags: ['testing', 'qa'],
    write: true,
    instructions:
      '为改动设计测试：正常路径、边界、失败路径；给出可落地的测试代码或清单。优先可维护的断言。',
  }),
  skill({
    id: 'skill-baseline-git-commit',
    name: 'Git 提交说明',
    description: '根据改动写出清晰 commit message / PR 描述。',
    category: '工程',
    tags: ['git', 'pr'],
    instructions:
      '提交说明遵循 why > what；短标题 + 要点列表；PR 描述含动机、改动、测试计划。',
  }),
  skill({
    id: 'skill-baseline-api-design',
    name: 'API 设计',
    description: 'REST/JSON API 合同：资源、错误码、分页、版本策略。',
    category: '工程',
    tags: ['api', 'backend'],
    write: true,
    instructions:
      '设计 API 时明确资源模型、鉴权、错误语义与示例请求/响应；输出可直接讨论的合同草案。',
  }),
  skill({
    id: 'skill-baseline-frontend-ui',
    name: '前端页面实现',
    description: '产出可运行的前端页面：布局、组件拆分、基础交互。',
    category: '工程',
    tags: ['frontend', 'ui', 'popular'],
    write: true,
    script: true,
    instructions:
      '实现前端时优先可运行交付：分文件写入、控制单次写入体积，核心页放 output/。缺品牌规范时用清晰默认企业规范并写进 README。',
  }),
  skill({
    id: 'skill-baseline-architecture',
    name: '架构评审',
    description: '评估系统边界、依赖、扩展性与风险，给出演进建议。',
    category: '工程',
    tags: ['architecture', 'design'],
    instructions:
      '架构评审覆盖目标、约束、备选方案、取舍与风险；给出 30/90 天可执行演进路径。',
  }),
  skill({
    id: 'skill-baseline-copywriting',
    name: '营销文案',
    description: '落地页、广告、邮件、社媒文案：卖点清晰、语气可控。',
    category: '增长',
    tags: ['copy', 'marketing', 'popular'],
    write: true,
    instructions:
      '先确认受众与转化目标，再写多版本文案（简洁/故事/专业）；标注适用渠道。',
  }),
  skill({
    id: 'skill-baseline-seo',
    name: 'SEO 内容优化',
    description: '标题、摘要、结构与内链建议，提升检索可读性。',
    category: '增长',
    tags: ['seo', 'content'],
    write: true,
    instructions:
      'SEO 优化：主关键词、标题/H 结构、摘要、FAQ；保持可读，不堆砌关键词。',
  }),
  skill({
    id: 'skill-baseline-email',
    name: '商务邮件',
    description: '专业邮件：跟进、谈判、致歉、合作邀请，多语气版本。',
    category: '办公',
    tags: ['email', 'business'],
    instructions:
      '写邮件时明确目的与 CTA；提供 2 个语气版本；主题行简短有信息量。',
  }),
  skill({
    id: 'skill-baseline-meeting-notes',
    name: '会议纪要',
    description: '把讨论整理成决议、待办、负责人与截止时间。',
    category: '办公',
    tags: ['meeting', 'notes', 'popular'],
    write: true,
    instructions:
      '纪要结构：结论 / 待办（负责人+截止）/ 开放问题 / 下次时间。可落盘为 Markdown。',
  }),
  skill({
    id: 'skill-baseline-translate',
    name: '专业翻译',
    description: '中英及其他常用语言互译，保留术语一致性与语域。',
    category: '办公',
    tags: ['translate', 'locale'],
    instructions:
      '翻译先识别语域（商务/技术/口语）；专有名词保持一致；必要时给出术语表。',
  }),
  skill({
    id: 'skill-baseline-prd',
    name: 'PRD 产品需求',
    description: '把想法写成可评审的 PRD：背景、用户、需求、验收标准。',
    category: '产品',
    tags: ['prd', 'product', 'popular'],
    write: true,
    instructions:
      'PRD 包含背景、目标指标、用户故事、功能范围、非目标、验收标准与风险。写清楚优先级。',
  }),
  skill({
    id: 'skill-baseline-brainstorm',
    name: '头脑风暴',
    description: '发散方案后收敛：机会、评估维度、推荐路径。',
    category: '产品',
    tags: ['ideation', 'workshop'],
    instructions:
      '先发散不少于 8 个点子，再按影响力/可行性筛选 Top3，并给出下一步实验。',
  }),
  skill({
    id: 'skill-baseline-finance-brief',
    name: '财经简报',
    description: '把行情/财报/行业信息整理成决策向简报（需配合数据源或 MCP）。',
    category: '金融',
    tags: ['finance', 'brief', 'popular'],
    write: true,
    instructions:
      '财经简报：先用可用行情/数据工具取证，再写要点、风险与观察清单。无数据时明确缺口，不编造点位。',
  }),
  skill({
    id: 'skill-baseline-interview',
    name: '面试辅导',
    description: '模拟问答、考点拆解与结构化回答（STAR）。',
    category: '成长',
    tags: ['interview', 'career'],
    instructions:
      '面试辅导用 STAR；针对岗位给出高频题 + 参考答法 + 追问准备。',
  }),
];

export const BASELINE_SKILL_IDS = new Set(BASELINE_CATALOG_SKILLS.map((item) => item.id));

export function isBaselineCatalogSkill(id: string) {
  return BASELINE_SKILL_IDS.has(id) || id.startsWith('skill-baseline-');
}
