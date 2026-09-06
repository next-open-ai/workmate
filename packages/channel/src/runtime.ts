import type { UnifiedMessage } from './types.js';

/**
 * The gateway-side logic bound to one orchestration backend. Channel-core only
 * routes; authorization, session mapping and agent/project scheduling live in
 * the runtime implementation (apps/gateway).
 */
export interface GatewayRuntime {
  /** Per-message allowlist/group-policy gate. */
  isAuthorized(message: UnifiedMessage): boolean | Promise<boolean>;
  /** Called when a message arrives for a channel that is not registered. */
  notifyUnregistered(message: UnifiedMessage): Promise<void>;
  /**
   * Produce the assistant reply for one inbound text message.
   * Yields incremental text deltas (streaming-capable channels mirror them);
   * the final yielded accumulation is the reply body.
   */
  process(message: UnifiedMessage): AsyncGenerator<string, void, undefined>;
}
