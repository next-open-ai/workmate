/**
 * 用户手册运行时适配器。
 * Markdown 在构建/开发启动前由 scripts/generate-user-manual.mjs 转换为章节 HTML/JSON；
 * renderer 只注入 Vite 生成的图片 URL，不再解析 Markdown。
 */
import generatedManual from '../generated/user-manual.json';
import imgOverview from '../../../../docs/guides/images/user-manual-1-overview.webp?url';
import imgModelConfig from '../../../../docs/guides/images/user-manual-2-model-config.webp?url';
import imgProviderAutoConfig from '../../../../docs/guides/images/user-manual-provider-auto-config.webp?url';
import imgChat from '../../../../docs/guides/images/user-manual-3-chat.webp?url';
import imgKnowledge from '../../../../docs/guides/images/user-manual-4-knowledge.webp?url';
import imgEnvCheck from '../../../../docs/guides/images/user-manual-5-env-check.webp?url';
import imgFaq from '../../../../docs/guides/images/user-manual-6-faq.webp?url';

const IMAGE_URLS: Record<string, string> = {
  'images/user-manual-1-overview.png': imgOverview,
  'images/user-manual-2-model-config.png': imgModelConfig,
  'images/user-manual-provider-auto-config.png': imgProviderAutoConfig,
  'images/user-manual-3-chat.png': imgChat,
  'images/user-manual-4-knowledge.png': imgKnowledge,
  'images/user-manual-5-env-check.png': imgEnvCheck,
  'images/user-manual-6-faq.png': imgFaq,
};

export interface ManualHeading {
  level: number;
  text: string;
  id: string;
}

export interface ManualSection {
  id: string;
  title: string;
  html: string;
  headingIds: string[];
}

const headings = generatedManual.headings as ManualHeading[];
const sections = generatedManual.sections.map((section) => ({
  ...section,
  html: section.html.replace(/src="(images\/[^\"]+)"/g, (match, src: string) => (IMAGE_URLS[src] ? `src="${IMAGE_URLS[src]}"` : match)),
})) as ManualSection[];

export function manualHeadings(): ManualHeading[] {
  return headings;
}

export function manualSections(): ManualSection[] {
  return sections;
}
