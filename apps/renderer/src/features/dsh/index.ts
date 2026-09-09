/**
 * Renderer-side dsh environment UI helpers.
 * Mirrors `packages/agent-core/src/dsh/environment-copy.ts` (no Node deps).
 */
export {
  DSH_ENV_CHECK_ID,
  DSH_ENV_FIX_ACTION_ID,
  DSH_RUNTIME_NPM_VERSION_HINT,
  buildDshRemediationPlan,
  dshInstallCardCopy,
  isDshEnvCheckId,
  isDshEnvFixAction,
} from './environment-ui.js';
export type { DshInstallCardCopy, DshRemediationKind, DshRemediationPlan } from './environment-ui.js';
