import type { ModelConfig } from '@workmate/contracts';
import { resolveExperienceEmbed } from './embed.js';

/**
 * Pre-turn experience recall readiness.
 *
 * Single gate aligned with product settings: the system-wide embedding /
 * vector model (ModelConfig.embeddingModel, filled from
 * Settings → activeEmbeddingModelId). If that is not configured, vector
 * features are not ready — skip with zero network cost.
 */

export type ExperienceRecallReadyReason = 'ok' | 'no-embedding';

export type ExperienceRecallReadiness = {
  ok: boolean;
  reason: ExperienceRecallReadyReason;
};

/** Sync: global vector model configured on this run's ModelConfig? */
export function getExperienceRecallReadiness(input: {
  model?: ModelConfig;
}): ExperienceRecallReadiness {
  if (!resolveExperienceEmbed(input.model)) {
    return { ok: false, reason: 'no-embedding' };
  }
  return { ok: true, reason: 'ok' };
}

/** @deprecated no-op kept for call-site compatibility after saves */
export function invalidateExperienceRecallReadiness(_agentId?: string) {
  /* readiness is derived from ModelConfig each call; nothing to cache */
}

/** @deprecated no-op — circuit breaker removed in favor of global config gate */
export function noteExperienceEmbedSuccess(_embedKey?: string) {
  /* intentionally empty */
}

/** @deprecated no-op — circuit breaker removed in favor of global config gate */
export function noteExperienceEmbedFailure(_embedKey?: string) {
  /* intentionally empty */
}

/** @deprecated no-op kept for tests */
export function resetExperienceRecallReadinessState() {
  /* intentionally empty */
}
