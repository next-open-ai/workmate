import type { AgentEvent, AgentEngineId, ChatRequest } from '@workmate/contracts';
import { AGENT_ENGINE_IDS } from '@workmate/contracts';

/**
 * Pluggable execution backends (pi / AgentScope / dsh, …).
 *
 * Orchestrator and product code should keep depending on `streamAgentReply` /
 * `AgentRunner` + `ChatRequest` → `AgentEvent`. Backend choice is an
 * implementation detail resolved here — not three parallel product stacks.
 *
 * See docs/design/execution-backend.md
 */

export type { AgentEngineId };

export type ExecutionBackendCapabilities = {
  /** Strong multi-step coding / repo edit loop */
  coding: boolean;
  /** OS-level or equivalent execution sandbox */
  sandbox: boolean;
  /** Runs outside the API Node process */
  processIsolated: boolean;
  /** Supports a process / worker pool under load */
  pooled: boolean;
};

export type ExecutionBackendStreamInput = ChatRequest & {
  abortSignal?: AbortSignal;
  runId?: string;
};

/**
 * One concrete agent execution engine.
 * Implementations own their loop, tools, and (if any) sidecar lifecycle.
 */
export interface ExecutionBackend {
  id: AgentEngineId;
  label: string;
  capabilities: ExecutionBackendCapabilities;
  stream(input: ExecutionBackendStreamInput): AsyncGenerator<AgentEvent>;
}

/**
 * Routing input for one turn.
 * Env `WORKMATE_AGENT_ENGINE` always wins when set (ops force).
 */
export type BackendResolveInput = {
  /** Explicit force (same tier as env when provided). */
  override?: string | null;
  /** Deployment allowlist; empty/omit = all registered backends. */
  enabledEngines?: AgentEngineId[];
  /** Global default when employee does not pin an engine. */
  defaultEngine?: AgentEngineId;
  /** Per-employee / per-request pin from ChatRequest.engine. */
  employeeEngine?: AgentEngineId | null;
  preferCoding?: boolean;
  preferProcessIsolation?: boolean;
};

const backends = new Map<AgentEngineId, ExecutionBackend>();

function normalizeEngineId(raw: string | null | undefined): AgentEngineId | null {
  const id = String(raw || '').trim().toLowerCase();
  if (!id) return null;
  return (AGENT_ENGINE_IDS as readonly string[]).includes(id) ? (id as AgentEngineId) : null;
}

/** Register or replace a backend (idempotent for the same id). */
export function registerExecutionBackend(backend: ExecutionBackend): void {
  backends.set(backend.id, backend);
}

export function unregisterExecutionBackend(id: AgentEngineId): boolean {
  return backends.delete(id);
}

export function getExecutionBackend(id: AgentEngineId): ExecutionBackend | undefined {
  return backends.get(id);
}

export function listExecutionBackends(): ExecutionBackend[] {
  return [...backends.values()];
}

export function availableExecutionBackendIds(): AgentEngineId[] {
  return listExecutionBackends().map((item) => item.id);
}

function isAllowed(id: AgentEngineId, enabled: AgentEngineId[] | undefined): boolean {
  if (!enabled?.length) return true;
  return enabled.includes(id);
}

function pickRegistered(id: AgentEngineId | null | undefined, enabled: AgentEngineId[] | undefined): ExecutionBackend | null {
  if (!id) return null;
  if (!isAllowed(id, enabled)) return null;
  return backends.get(id) ?? null;
}

/**
 * Resolve which backend runs this turn.
 *
 * Priority:
 * 1. `WORKMATE_AGENT_ENGINE` / `override` (ops force; bypasses allowlist)
 * 2. `employeeEngine` when in allowlist + registered
 * 3. `defaultEngine` when in allowlist + registered
 * 4. `preferCoding` → `dsh` / `preferProcessIsolation` → `agentscope` (allowlist)
 * 5. first enabled registered backend, else `pi`
 */
export function resolveExecutionBackend(input: BackendResolveInput = {}): ExecutionBackend {
  const enabled = input.enabledEngines?.length
    ? [...new Set(input.enabledEngines.map((id) => normalizeEngineId(id)).filter((id): id is AgentEngineId => Boolean(id)))]
    : undefined;

  const forced = normalizeEngineId(input.override ?? process.env.WORKMATE_AGENT_ENGINE);
  if (forced) {
    const backend = backends.get(forced);
    if (!backend) {
      const available = availableExecutionBackendIds().join(', ') || '(none)';
      throw new Error(
        `Execution backend "${forced}" is not registered. Available: ${available}.`,
      );
    }
    return backend;
  }

  const fromEmployee = pickRegistered(normalizeEngineId(input.employeeEngine), enabled);
  if (fromEmployee) return fromEmployee;

  const fromDefault = pickRegistered(normalizeEngineId(input.defaultEngine), enabled);
  if (fromDefault) return fromDefault;

  if (input.preferCoding) {
    const coding = pickRegistered('dsh', enabled);
    if (coding) return coding;
  }
  if (input.preferProcessIsolation) {
    const isolated = pickRegistered('agentscope', enabled);
    if (isolated) return isolated;
  }

  if (enabled?.length) {
    for (const id of enabled) {
      const backend = backends.get(id);
      if (backend) return backend;
    }
    throw new Error(
      `No registered execution backend in enabledEngines=[${enabled.join(', ')}]. `
      + `Registered: ${availableExecutionBackendIds().join(', ') || '(none)'}.`,
    );
  }

  const pi = backends.get('pi');
  if (!pi) {
    throw new Error('Default execution backend "pi" is not registered. Import execution-backends bootstrap first.');
  }
  return pi;
}

/** Backward-compatible id resolver used by API boot / compaction. */
export function resolveAgentEngine(override?: string | null): AgentEngineId {
  return resolveExecutionBackend({ override }).id;
}

/** Test helper: clear registry. */
export function resetExecutionBackendRegistryForTests(): void {
  backends.clear();
}
