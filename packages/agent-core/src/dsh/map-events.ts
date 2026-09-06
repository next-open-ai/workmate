import type { AgentEvent } from '@workmate/contracts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textFromContentBlocks(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('');
}

/**
 * Map one DeepSeek Harness session-log event onto zero or more Workmate AgentEvents.
 * Only emits user-visible text deltas (not reasoning) and tool activity.
 */
export function mapDshSessionEvent(runId: string, event: unknown): AgentEvent[] {
  if (!isRecord(event) || typeof event.type !== 'string') return [];
  const data = isRecord(event.data) ? event.data : {};
  const out: AgentEvent[] = [];

  switch (event.type) {
    case 'assistant/chunk': {
      const chunk = isRecord(data.chunk) ? data.chunk : null;
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text) {
        out.push({ type: 'message.delta', runId, text: chunk.text });
      }
      break;
    }
    case 'assistant/message': {
      // Prefer live chunks; use assembled message only as a fallback marker via empty skip.
      // If the stream had no text-delta (some adapters), emit full text once.
      const message = isRecord(data.message) ? data.message : null;
      const text = textFromContentBlocks(message?.content);
      if (text) {
        // Caller tracks whether deltas already arrived; we still emit here only when
        // tagged — stream.ts decides based on emittedText flag by re-checking.
        out.push({ type: 'message.delta', runId, text: `\u0000${text}` }); // sentinel prefix for stream.ts
      }
      if (isRecord(data.usage)) {
        const usage = data.usage;
        const inputTokens = Math.max(0, Math.round(Number(usage.inputTokens ?? usage.prompt_tokens ?? 0)) || 0);
        const outputTokens = Math.max(0, Math.round(Number(usage.outputTokens ?? usage.completion_tokens ?? 0)) || 0);
        const reasoningTokens = Math.max(0, Math.round(Number(usage.reasoningTokens ?? 0)) || 0);
        const cacheReadTokens = Math.max(0, Math.round(Number(usage.cacheReadTokens ?? 0)) || 0);
        out.push({
          type: 'run.usage',
          runId,
          usage: {
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens + reasoningTokens,
            ...(reasoningTokens ? { reasoningTokens } : {}),
            ...(cacheReadTokens ? { cacheReadTokens } : {}),
          },
        });
      }
      break;
    }
    case 'tool/call': {
      const name = String(data.name || 'tool');
      const args = String(data.arguments || '').slice(0, 200);
      out.push({
        type: 'tool.started',
        runId,
        toolName: name,
        summary: args ? `${name}(${args})` : name,
      });
      break;
    }
    case 'tool/result': {
      const message = isRecord(data.message) ? data.message : null;
      const name = String(message?.name || data.name || 'tool');
      const failed = Boolean(data.error);
      const summary = failed
        ? String((isRecord(data.error) && data.error.name) || 'tool failed')
        : `${name} completed`;
      if (failed) {
        out.push({ type: 'tool.failed', runId, toolName: name, summary });
      } else {
        out.push({ type: 'tool.completed', runId, toolName: name, summary, ok: true });
      }
      break;
    }
    case 'turn/end': {
      const reason = isRecord(data.reason) ? data.reason : null;
      const kind = String(reason?.kind || '');
      if (kind === 'error') {
        const message = String(reason?.message || reason?.error || 'DeepSeek Harness turn failed.');
        out.push({ type: 'run.failed', runId, message });
      }
      break;
    }
    default:
      break;
  }

  return out;
}

/** Strip the assembled-message sentinel used to distinguish fallback full text. */
export function unwrapAssembledDelta(text: string): { assembled: boolean; text: string } {
  if (text.startsWith('\u0000')) return { assembled: true, text: text.slice(1) };
  return { assembled: false, text };
}
