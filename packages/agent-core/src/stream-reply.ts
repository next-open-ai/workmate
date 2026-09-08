import type { AgentEvent } from '@workmate/contracts';
import { DEFAULT_RUN_TIMEOUT_MS } from './pi-runtime.js';
import './execution-backends.js';
import {
  resolveExecutionBackend,
  resolveAgentEngine,
  type AgentEngineId,
  type BackendResolveInput,
  type ExecutionBackendStreamInput,
} from './execution-backend.js';
import { loadExecutionRoutingConfig } from './execution-routing-config.js';
import { attachBuiltinSkillPackages } from './builtin-skill-packages.js';

export { DEFAULT_RUN_TIMEOUT_MS };
export {
  resolveAgentEngine,
  resolveExecutionBackend,
  registerExecutionBackend,
  unregisterExecutionBackend,
  getExecutionBackend,
  listExecutionBackends,
  availableExecutionBackendIds,
  resetExecutionBackendRegistryForTests,
  type AgentEngineId,
  type ExecutionBackend,
  type ExecutionBackendCapabilities,
  type ExecutionBackendStreamInput,
  type BackendResolveInput,
} from './execution-backend.js';
export { registerBuiltinExecutionBackends } from './execution-backends.js';
export {
  loadExecutionRoutingConfig,
  type ExecutionRoutingConfig,
} from './execution-routing-config.js';

/**
 * Single product entry: resolve an ExecutionBackend then stream AgentEvents.
 *
 * Routing: runtime-settings allowlist/default + ChatRequest.engine + optional hints.
 * Ops force: `resolve.override`, or `WORKMATE_AGENT_ENGINE` + `WORKMATE_AGENT_ENGINE_FORCE=1`.
 */
export async function* streamAgentReply(
  input: ExecutionBackendStreamInput,
  resolve?: BackendResolveInput,
): AsyncGenerator<AgentEvent> {
  const preparedInput: ExecutionBackendStreamInput = {
    ...input,
    skills: await attachBuiltinSkillPackages(input.skills ?? []),
  };
  const stored = loadExecutionRoutingConfig();
  const backend = resolveExecutionBackend({
    enabledEngines: resolve?.enabledEngines ?? stored.enabledEngines,
    defaultEngine: resolve?.defaultEngine ?? stored.defaultEngine,
    override: resolve?.override,
    employeeEngine: resolve?.employeeEngine ?? preparedInput.engine ?? null,
    preferCoding: resolve?.preferCoding,
    preferProcessIsolation: resolve?.preferProcessIsolation,
  });
  console.info('[workmate] execution backend selected', {
    engine: backend.id,
    requestEngine: preparedInput.engine ?? null,
    profileId: preparedInput.profile?.id ?? null,
  });
  let annotatedStarted = false;
  for await (const event of backend.stream(preparedInput)) {
    if (event.type === 'run.started' && !annotatedStarted) {
      annotatedStarted = true;
      yield { ...event, engine: backend.id };
      continue;
    }
    yield event;
  }
}
