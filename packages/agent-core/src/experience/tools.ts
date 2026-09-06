import type { ModelConfig } from '@workmate/contracts';
import { Type } from '@sinclair/typebox';
import { defineAgentTool, type AgentTool } from '../pi-tools.js';
import { getExperienceRecallReadiness } from './readiness.js';
import { loadExperience, saveExperience } from './service.js';
import { EXPERIENCE_LIMITS, formatExperienceCard } from './types.js';

/**
 * Agent-scoped experience tools as native pi AgentTools.
 * agentId is closed over from the run profile (cannot be spoofed by the model).
 */
export function createExperienceTools(input: {
  agentId: string;
  model?: ModelConfig;
  enabled?: boolean;
  minScore?: number;
}): AgentTool[] {
  const agentId = String(input.agentId || '').trim();
  if (!agentId || input.enabled === false) return [];
  // No system-wide embedding model → skip tools entirely (zero catalog/prompt tax).
  if (!getExperienceRecallReadiness({ model: input.model }).ok) return [];

  const minScore = input.minScore ?? EXPERIENCE_LIMITS.minScore;

  return [
    defineAgentTool({
      name: 'save_experience',
      description:
        'Save a short reusable experience for THIS agent after a meaningful complex task '
        + '(successful approach, hard-won pitfall, or durable project convention). '
        + 'Keep fields concise. Do not dump raw chat logs. Skip trivial one-shot answers.',
      parameters: Type.Object({
        title: Type.String({ minLength: 2, maxLength: EXPERIENCE_LIMITS.title }),
        situation: Type.String({ minLength: 8, maxLength: EXPERIENCE_LIMITS.situation, description: 'When this experience applies.' }),
        action: Type.String({ minLength: 8, maxLength: EXPERIENCE_LIMITS.action, description: 'What worked / recommended steps.' }),
        pitfall: Type.Optional(Type.String({ maxLength: EXPERIENCE_LIMITS.pitfall, description: 'What to avoid.' })),
        whenNot: Type.Optional(Type.String({ maxLength: EXPERIENCE_LIMITS.whenNot, description: 'When NOT to apply this.' })),
        tags: Type.Optional(Type.Array(Type.String({ maxLength: EXPERIENCE_LIMITS.tagLen }), { maxItems: EXPERIENCE_LIMITS.tags })),
      }),
      execute: async ({ title, situation, action, pitfall, whenNot, tags }) => {
        try {
          const saved = await saveExperience({
            agentId,
            title,
            situation,
            action,
            pitfall,
            whenNot,
            tags,
            model: input.model,
          });
          return {
            ok: true,
            id: saved.id,
            merged: saved.merged,
            backend: saved.backend,
            title: saved.title,
          };
        } catch (error) {
          return {
            ok: false,
            message: error instanceof Error ? error.message : 'Failed to save experience.',
          };
        }
      },
    }),
    defineAgentTool({
      name: 'load_experience',
      description:
        'Load high-confidence past experiences for THIS agent by semantic similarity to a query. '
        + `Only returns items with score >= ${minScore}; otherwise empty. `
        + 'Use when starting or pivoting a complex task that may match prior work.',
      parameters: Type.Object({
        query: Type.String({ minLength: 2, maxLength: 400 }),
        topK: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
      }),
      execute: async ({ query, topK }) => {
        try {
          const loaded = await loadExperience({
            agentId,
            query,
            topK,
            minScore,
            model: input.model,
          });
          return {
            ok: true,
            count: loaded.count,
            minScore: loaded.minScore,
            backend: loaded.backend,
            results: loaded.results.map((item) => ({
              id: item.id,
              score: item.score,
              card: formatExperienceCard(item),
              tags: item.tags,
            })),
          };
        } catch (error) {
          return {
            ok: false,
            count: 0,
            results: [],
            message: error instanceof Error ? error.message : 'Failed to load experience.',
          };
        }
      },
    }),
  ];
}
