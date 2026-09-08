import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentSkillRuntime } from '@workmate/contracts';

const PDF_SKILL_ID = 'skill-baseline-pdf-report';

const PDF_SKILL_MD = `---
name: PDF 报告生成
description: 用内置渲染脚本生成并校验中文 PDF。
---

此 Skill 已提供可执行渲染器，**不要**自行探测字体、编写 ReportLab 脚本或读取虚构的 Skill 文件。

最短路径：
1. 用 \`write_workspace_file\` 一次写入 \`tmp/pdf-input.json\`，格式为 \`{"title":"...","content":"..."}\`；输入 JSON 是过程文件，**绝不可**写到 \`output/\`。
2. 用 \`run_skill_script\` 执行 \`scripts/render_pdf.py\`，参数为 \`["tmp/pdf-input.json", "output/<文件名>.pdf"]\`。
3. 脚本只会声明最终 PDF 为交付物；不要重新命名、复制或再次登记。面向用户回答时只说文件名，不要暴露内部的 \`output/\` 路径。

只有脚本返回明确依赖错误时，才调用 \`install_python_dependency\` 安装 \`reportlab\` 后重试一次。
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
