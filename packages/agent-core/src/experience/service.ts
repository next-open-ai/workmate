import type { ModelConfig } from '@workmate/contracts';
import { cosine, embedExperienceTexts, resolveExperienceEmbed } from './embed.js';
import {
  getExperienceRecallReadiness,
  invalidateExperienceRecallReadiness,
  noteExperienceEmbedFailure,
  noteExperienceEmbedSuccess,
} from './readiness.js';
import {
  bumpExperienceHit,
  findNearDuplicate,
  getExperience,
  saveExperienceRecord,
  searchExperienceVectors,
} from './store.js';
import {
  EXPERIENCE_LIMITS,
  buildEmbedText,
  formatExperienceCard,
  type ExperienceHit,
  type ExperienceRecord,
} from './types.js';

function clip(value: string, max: number) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeTags(tags?: string[]) {
  const rows = Array.isArray(tags) ? tags : [];
  const out: string[] = [];
  for (const raw of rows) {
    const tag = clip(String(raw || ''), EXPERIENCE_LIMITS.tagLen);
    if (!tag) continue;
    if (out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= EXPERIENCE_LIMITS.tags) break;
  }
  return out;
}

function embedKeyOf(embed: { baseUrl: string; model: string }) {
  return `${embed.baseUrl}|${embed.model}`;
}

export type SaveExperienceInput = {
  agentId: string;
  title: string;
  situation: string;
  action: string;
  pitfall?: string;
  whenNot?: string;
  tags?: string[];
  model?: ModelConfig;
};

export async function saveExperience(input: SaveExperienceInput) {
  const agentId = String(input.agentId || '').trim();
  if (!agentId) throw new Error('agentId is required.');
  const title = clip(input.title, EXPERIENCE_LIMITS.title);
  const situation = clip(input.situation, EXPERIENCE_LIMITS.situation);
  const action = clip(input.action, EXPERIENCE_LIMITS.action);
  const pitfall = clip(input.pitfall || '', EXPERIENCE_LIMITS.pitfall);
  const whenNot = clip(input.whenNot || '', EXPERIENCE_LIMITS.whenNot);
  const tags = normalizeTags(input.tags);
  if (!title || !situation || !action) {
    throw new Error('title, situation and action are required.');
  }

  const embed = resolveExperienceEmbed(input.model);
  if (!embed) {
    throw new Error('Configure an embedding model (Settings → Models) before saving experience.');
  }

  const embedText = buildEmbedText({ title, situation, action, pitfall, whenNot, tags });
  const embedKey = embedKeyOf(embed);
  let vector: number[];
  try {
    [vector] = await embedExperienceTexts(embed, [embedText]);
    noteExperienceEmbedSuccess(embedKey);
  } catch (error) {
    noteExperienceEmbedFailure(embedKey);
    throw error;
  }
  const now = Date.now();
  const dup = findNearDuplicate(agentId, vector);
  const base: ExperienceRecord = dup
    ? {
      ...dup.record,
      title,
      situation,
      action,
      pitfall,
      whenNot,
      tags: tags.length ? tags : dup.record.tags,
      embedText,
      vector,
      quality: Math.min(1, Math.max(dup.record.quality, 0.55)),
      updatedAt: now,
    }
    : {
      id: crypto.randomUUID(),
      agentId,
      title,
      situation,
      action,
      pitfall,
      whenNot,
      tags,
      embedText,
      vector,
      quality: 0.55,
      hitCount: 0,
      createdAt: now,
      updatedAt: now,
    };

  const saved = await saveExperienceRecord(base);
  invalidateExperienceRecallReadiness(agentId);
  return {
    ...saved,
    merged: Boolean(dup),
    title: base.title,
    card: formatExperienceCard(base),
  };
}

export type LoadExperienceInput = {
  agentId: string;
  query: string;
  /** Max candidates to consider before score filter. */
  topK?: number;
  /** High-confidence threshold; below → empty. */
  minScore?: number;
  model?: ModelConfig;
};

/**
 * Load experiences for an agent. Only returns hits with score >= minScore.
 * Otherwise returns empty (caller should treat as no memory).
 */
export async function loadExperience(input: LoadExperienceInput): Promise<{
  ok: true;
  count: number;
  minScore: number;
  results: ExperienceHit[];
  backend: string;
}> {
  const agentId = String(input.agentId || '').trim();
  const query = String(input.query || '').trim();
  const minScore = Math.min(0.99, Math.max(0.5, Number(input.minScore) || EXPERIENCE_LIMITS.minScore));
  const topK = Math.min(5, Math.max(1, Math.round(Number(input.topK) || 3)));
  if (!agentId || query.length < 2) {
    return { ok: true, count: 0, minScore, results: [], backend: 'none' };
  }

  const embed = resolveExperienceEmbed(input.model);
  if (!embed) {
    return { ok: true, count: 0, minScore, results: [], backend: 'no-embedding' };
  }

  const embedKey = embedKeyOf(embed);
  let vector: number[];
  try {
    [vector] = await embedExperienceTexts(embed, [query]);
    noteExperienceEmbedSuccess(embedKey);
  } catch (error) {
    noteExperienceEmbedFailure(embedKey);
    throw error;
  }
  const ranked = await searchExperienceVectors({ agentId, vector, topK });
  const backend = ranked.length && ranked[0] ? 'vector' : 'empty';

  // Re-score against stored vectors when possible (more stable than distance transform).
  const hits: ExperienceHit[] = [];
  for (const row of ranked) {
    const record = getExperience(agentId, row.id);
    if (!record) continue;
    const score = record.vector.length ? cosine(vector, record.vector) : row.score;
    if (score < minScore) continue;
    hits.push({
      id: record.id,
      title: record.title,
      situation: record.situation,
      action: record.action,
      pitfall: record.pitfall,
      whenNot: record.whenNot,
      tags: record.tags,
      score: Number(score.toFixed(4)),
    });
  }

  hits.sort((a, b) => b.score - a.score);
  const results = hits.slice(0, Math.min(2, topK));
  for (const hit of results) bumpExperienceHit(agentId, hit.id);
  return { ok: true, count: results.length, minScore, results, backend };
}

/** Default TTFT budget once readiness is ok; skip path is sync and ignores this. */
export const EXPERIENCE_RECALL_BUDGET_MS = 800;

/**
 * Build a short system-prompt block for the run.
 *
 * Hot path:
 * 1. Sync readiness — no system-wide embedding model on ModelConfig → '' immediately.
 * 2. Only when ready, run vector recall under a short budget so a slow
 *    embeddings endpoint cannot stall first token.
 */
export async function recallExperienceBlock(input: {
  agentId: string;
  query: string;
  model?: ModelConfig;
  minScore?: number;
  /** Max wait when ready; default EXPERIENCE_RECALL_BUDGET_MS. Use 0 to skip async work. */
  budgetMs?: number;
}): Promise<string> {
  const readiness = getExperienceRecallReadiness({
    model: input.model,
  });
  if (!readiness.ok) return '';

  const budgetMs = Math.max(
    0,
    Math.round(input.budgetMs ?? EXPERIENCE_RECALL_BUDGET_MS),
  );
  if (budgetMs === 0) return '';

  const work = (async () => {
    const loaded = await loadExperience({
      agentId: input.agentId,
      query: input.query,
      model: input.model,
      minScore: input.minScore,
      topK: 3,
    });
    if (!loaded.results.length) return '';
    const body = loaded.results
      .map((item, index) => `#${index + 1} (score ${item.score})\n${formatExperienceCard(item)}`)
      .join('\n\n');
    return [
      'Relevant past experiences for this agent (high-confidence matches only).',
      'Use when applicable; ignore if the current task differs.',
      body,
    ].join('\n');
  })().catch(() => '');

  return Promise.race([
    work,
    new Promise<string>((resolve) => {
      setTimeout(() => resolve(''), budgetMs);
    }),
  ]);
}
