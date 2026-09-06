import { streamAgentReply as streamAgentReplyViaPi } from './pi-runtime.js';
import { streamAgentReplyViaAgentscope } from './agentscope/stream.js';
import { streamAgentReplyViaDsh } from './dsh/stream.js';
import {
  registerExecutionBackend,
  type ExecutionBackend,
} from './execution-backend.js';

/**
 * Builtin backends. Import this module (or `stream-reply`) before resolving.
 * dsh registers even when the runtime binary is missing — resolve/stream then
 * fails with a setup-oriented error (no silent fallback).
 */

const piBackend: ExecutionBackend = {
  id: 'pi',
  label: 'pi (in-process)',
  capabilities: {
    coding: false,
    sandbox: false,
    processIsolated: false,
    pooled: false,
  },
  stream: streamAgentReplyViaPi,
};

const agentscopeBackend: ExecutionBackend = {
  id: 'agentscope',
  label: 'AgentScope (Python sidecar pool)',
  capabilities: {
    coding: false,
    sandbox: false,
    processIsolated: true,
    pooled: true,
  },
  stream: streamAgentReplyViaAgentscope,
};

const dshBackend: ExecutionBackend = {
  id: 'dsh',
  label: 'DeepSeek Harness (coding sidecar)',
  capabilities: {
    coding: true,
    sandbox: true,
    processIsolated: true,
    pooled: false,
  },
  stream: streamAgentReplyViaDsh,
};

/** Idempotent registration of shipped backends. */
export function registerBuiltinExecutionBackends(): void {
  registerExecutionBackend(piBackend);
  registerExecutionBackend(agentscopeBackend);
  registerExecutionBackend(dshBackend);
}

registerBuiltinExecutionBackends();
