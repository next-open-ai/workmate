import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentSkillRuntime } from '@workmate/contracts';

/** Stable identifier used by the PDF Skill and its private runtime adapter. */
export const PDF_SKILL_ID = 'skill-baseline-pdf-report';

const PDF_SKILL_MD = `---
name: PDF 报告生成
description: 用内置渲染脚本生成并校验中文 PDF。
---

此 Skill 已提供可执行渲染器，**不要**自行探测字体、编写 ReportLab 脚本或读取虚构的 Skill 文件。

首选路径：调用本 Skill 专属的 \`render_pdf_report\` 适配器，并传入 \`title\`、\`content\` 和 \`filename\`。它会在隔离工作区中处理输入 JSON、Python 依赖、渲染、PDF 校验和唯一交付物登记。

不要自行编写 JSON、复制渲染器、调用 \`run_workspace_script\`，也不要将过程文件写入 \`output/\`。适配器成功后，面向用户只说文件名，不要暴露内部的 \`output/\` 路径。
`;

const PDF_RENDERER = String.raw`import json, os, sys
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak

src, out = sys.argv[1], sys.argv[2]
with open(src, encoding='utf-8') as f: data = json.load(f)
os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
base = getSampleStyleSheet()
title = ParagraphStyle('title', parent=base['Title'], fontName='STSong-Light', fontSize=22, leading=30, spaceAfter=14)
head = ParagraphStyle('head', parent=base['Heading2'], fontName='STSong-Light', fontSize=15, leading=22, spaceBefore=9, spaceAfter=5)
body = ParagraphStyle('body', parent=base['BodyText'], fontName='STSong-Light', fontSize=10.5, leading=17, spaceAfter=4)
story = [Paragraph(str(data.get('title') or '旅行行程'), title)]
for raw in str(data.get('content') or '').splitlines():
    line = raw.strip()
    if line == '---': story.append(PageBreak()); continue
    if not line: story.append(Spacer(1, 2 * mm)); continue
    safe = line.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    story.append(Paragraph(safe[1:].strip() if line.startswith('#') else safe, head if line.startswith('#') else body))
SimpleDocTemplate(out, pagesize=A4, leftMargin=18*mm, rightMargin=18*mm, topMargin=16*mm, bottomMargin=16*mm).build(story)
print('WORKMATE_DELIVERABLE:' + out)
`;

/** Materialize bundled business Skills into the managed Skill library. */
export async function attachBuiltinSkillPackages(skills: AgentSkillRuntime[]): Promise<AgentSkillRuntime[]> {
  const root = process.env.WORKMATE_SKILLS_DIR?.trim();
  if (!root) return skills;
  return Promise.all(skills.map(async (skill) => {
    if (skill.id !== PDF_SKILL_ID) return skill;
    const packageRoot = path.join(root, PDF_SKILL_ID);
    await mkdir(path.join(packageRoot, 'scripts'), { recursive: true, mode: 0o700 });
    await writeFile(path.join(packageRoot, 'SKILL.md'), PDF_SKILL_MD, 'utf8');
    await writeFile(path.join(packageRoot, 'scripts', 'render_pdf.py'), PDF_RENDERER, 'utf8');
    return { ...skill, rootPath: packageRoot, instructions: PDF_SKILL_MD };
  }));
}
