/**
 * Context compaction & session memory — powered by pi-coding-agent.
 *
 * Uses official `generateSummary` / `shouldCompact` / `estimateTokens`
 * (same path as pi's auto-compaction) instead of Vercel AI SDK.
 */
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { Api, Model } from '@mariozechner/pi-ai';
import { completeSimple } from '@mariozechner/pi-ai';
import {
  convertToLlm,
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  generateSummary,
  serializeConversation,
  shouldCompact,
} from '@mariozechner/pi-coding-agent';
import type { ModelConfig } from '@workmate/contracts';
import { createChatCompletionsPayloadPatch, toPiModel } from './pi-model.js';

/** Soft budget for durable session memory (summary + uncovered turns). */
export const SESSION_MEMORY_BUDGET_CHARS = 24_000;
/** Keep this many newest canonical messages verbatim after a session roll. */
export const SESSION_MEMORY_KEEP_RECENT = 8;
/** Cap stored session summary text. */
export const SESSION_MEMORY_SUMMARY_MAX_CHARS = 3_500;

/** Shared prefix for durable session memory injection into chat history. */
export const SESSION_SUMMARY_PREFIX = '[Workmate context summary]';

const WORKMATE_SUMMARY_FOCUS =
  'Workmate digital-employee session: preserve user goals, constraints, decisions, artifact paths, failed attempts, and unfinished work. Write in the same language as the user. Omit raw CSS/HTML dumps and tool JSON.';

const FALLBACK_SYSTEM =
  'You are a context summarization assistant. Read the conversation and produce a structured continuity brief. Do NOT continue the conversation. ONLY output the summary.';

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function estimateMessageTokens(messages: AgentMessage[]) {
  let tokens = 0;
  for (const message of messages) tokens += estimateTokens(message);
  return tokens;
}

/** Convert plain turns into pi AgentMessages for generateSummary. */
export function plainTurnsToAgentMessages(
  turns: Array<{ role: 'user' | 'assistant'; content: string }>,
  model: ModelConfig,
): AgentMessage[] {
  const api: Api =
    model.provider === 'anthropic'
      ? 'anthropic-messages'
      : model.provider === 'google'
        ? 'google-generative-ai'
        : 'openai-completions';
  return turns.map((turn) => {
    if (turn.role === 'user') {
      return { role: 'user' as const, content: turn.content, timestamp: Date.now() };
    }
    return {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: turn.content }],
      api,
      provider: model.provider,
      model: model.chatModel,
      usage: emptyUsage(),
      stopReason: 'stop' as const,
      timestamp: Date.now(),
    };
  });
}

function resolveApiKey(model: ModelConfig) {
  return model.apiKey?.trim() || (model.provider === 'ollama' ? 'ollama' : '');
}

function summaryAsAgentMessages(summary: string, model: ModelConfig): AgentMessage[] {
  return plainTurnsToAgentMessages(sessionSummaryMessagePair(summary), model);
}

/**
 * Fallback summarizer when generateSummary fails (e.g. provider rejects reasoning).
 * Still uses pi-ai completeSimple + pi serializeConversation.
 */
async function summarizeFallback(input: {
  messages: AgentMessage[];
  model: ModelConfig;
  previousSummary?: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  const piModel = toPiModel(input.model);
  const apiKey = resolveApiKey(input.model);
  if (!apiKey) return null;
  const onPayload = createChatCompletionsPayloadPatch(input.model);
  const conversationText = serializeConversation(convertToLlm(input.messages));
  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (input.previousSummary?.trim()) {
    promptText += `<previous-summary>\n${input.previousSummary.trim()}\n</previous-summary>\n\n`;
  }
  promptText +=
    'Produce a structured continuity brief with sections: Goal, Constraints, Progress (Done/In Progress/Blocked), Key Decisions, Next Steps, Critical Context. '
    + WORKMATE_SUMMARY_FOCUS;
  try {
    const response = await completeSimple(
      piModel,
      {
        systemPrompt: FALLBACK_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: promptText }], timestamp: Date.now() }],
      },
      {
        maxTokens: Math.floor(0.8 * DEFAULT_COMPACTION_SETTINGS.reserveTokens),
        apiKey,
        signal: input.signal,
        reasoning: undefined,
        onPayload: (payload) => onPayload?.(payload),
      },
    );
    if (response.stopReason === 'error') return null;
    const text = response.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim();
    return text ? text.slice(0, SESSION_MEMORY_SUMMARY_MAX_CHARS) : null;
  } catch {
    return null;
  }
}

/** Durable session-memory summarizer — pi generateSummary (with safe fallback). */
export async function summarizeSessionMemory(input: {
  model: ModelConfig;
  previousSummary?: string;
  turns: Array<{ role: 'user' | 'assistant'; content: string }>;
  signal?: AbortSignal;
}): Promise<string | null> {
  if (!input.turns.length) return null;

  // Phase 3: when AgentScope engine is selected, prefer Sidecar summarizer.
  if ((process.env.WORKMATE_AGENT_ENGINE || 'pi').trim().toLowerCase() === 'agentscope') {
    try {
      const { ensureSharedAgentscopeRuntime } = await import('./agentscope/process.js');
      const handle = await ensureSharedAgentscopeRuntime();
      const result = await handle.client.summarizeMemory({
        model: {
          provider: input.model.provider,
          chatModel: input.model.chatModel,
          baseUrl: input.model.baseUrl,
          apiKey: input.model.apiKey,
          disableThinking: input.model.disableThinking,
        },
        previousSummary: input.previousSummary,
        turns: input.turns,
      });
      const trimmed = result.summary?.trim().slice(0, SESSION_MEMORY_SUMMARY_MAX_CHARS);
      if (trimmed) return trimmed;
    } catch {
      /* fall through to pi path */
    }
  }

  const messages = plainTurnsToAgentMessages(input.turns, input.model);
  const piModel = toPiModel(input.model);
  const apiKey = resolveApiKey(input.model);
  if (!apiKey) return null;
  try {
    const summary = await generateSummary(
      messages,
      piModel,
      DEFAULT_COMPACTION_SETTINGS.reserveTokens,
      apiKey,
      input.signal,
      WORKMATE_SUMMARY_FOCUS,
      input.previousSummary,
    );
    const trimmed = summary?.trim().slice(0, SESSION_MEMORY_SUMMARY_MAX_CHARS);
    return trimmed || null;
  } catch {
    return summarizeFallback({
      messages,
      model: input.model,
      previousSummary: input.previousSummary,
      signal: input.signal,
    });
  }
}

/** @deprecated Prefer summarizeSessionMemory. */
export async function summarizePlainTurns(input: {
  previousSummary?: string;
  turns: Array<{ role: 'user' | 'assistant'; content: string }>;
  model: ModelConfig;
  signal?: AbortSignal;
}): Promise<string | null> {
  return summarizeSessionMemory(input);
}

/** Build the user/assistant pair used to inject a durable summary into chat history. */
export function sessionSummaryMessagePair(summary: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  const text = summary.trim();
  if (!text) return [];
  return [
    {
      role: 'user',
      content: `${SESSION_SUMMARY_PREFIX}\n${text}\n\nContinue from this summary and the recent messages below. Do not re-read the entire history.`,
    },
    {
      role: 'assistant',
      content: 'Understood. I will use the summary as prior context and continue with the recent turns.',
    },
  ];
}

function findPreviousInjectedSummary(messages: AgentMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    const text = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.filter((part): part is { type: 'text'; text: string } => part.type === 'text').map((part) => part.text).join('\n')
        : '';
    if (text.startsWith(SESSION_SUMMARY_PREFIX)) {
      return text.slice(SESSION_SUMMARY_PREFIX.length).replace(/^\n/, '').split('\n\nContinue from this summary')[0]?.trim();
    }
  }
  return undefined;
}

/**
 * Mid-run context transform for pi Agent: when context is near the window,
 * summarize older messages with pi generateSummary and keep recent turns.
 */
export async function compactAgentContext(input: {
  messages: AgentMessage[];
  model: ModelConfig;
  piModel?: Model<Api>;
  signal?: AbortSignal;
}): Promise<AgentMessage[]> {
  const messages = input.messages;
  if (messages.length < 6) return messages;

  const piModel = input.piModel ?? toPiModel(input.model);
  const contextWindow = piModel.contextWindow || 128_000;
  const settings = DEFAULT_COMPACTION_SETTINGS;
  const tokens = estimateMessageTokens(messages);
  if (!shouldCompact(tokens, contextWindow, settings)) return messages;

  // 提配：刚触达默认压缩点时先继续执行，不中断；仅更接近窗口上限才摘要。
  const boostCeiling = Math.floor(contextWindow * 0.88);
  if (tokens < boostCeiling) return messages;

  let keptTokens = 0;
  let cut = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    keptTokens += estimateTokens(messages[i]!);
    if (keptTokens >= settings.keepRecentTokens) {
      let boundary = i;
      while (boundary > 0 && messages[boundary]?.role !== 'user') boundary -= 1;
      cut = boundary > 0 ? boundary : i;
      break;
    }
  }
  if (cut <= 1 || cut >= messages.length - 1) return messages;

  const older = messages.slice(0, cut);
  const recent = messages.slice(cut);
  const apiKey = resolveApiKey(input.model);
  if (!apiKey) return messages;

  const previousSummary = findPreviousInjectedSummary(older);
  try {
    const summary = await generateSummary(
      older,
      piModel,
      settings.reserveTokens,
      apiKey,
      input.signal,
      WORKMATE_SUMMARY_FOCUS,
      previousSummary,
    );
    if (!summary?.trim()) return messages;
    return [...summaryAsAgentMessages(summary.trim().slice(0, SESSION_MEMORY_SUMMARY_MAX_CHARS), input.model), ...recent];
  } catch {
    const fallback = await summarizeFallback({
      messages: older,
      model: input.model,
      previousSummary,
      signal: input.signal,
    });
    if (!fallback) return messages;
    return [...summaryAsAgentMessages(fallback, input.model), ...recent];
  }
}

export { convertToLlm, DEFAULT_COMPACTION_SETTINGS, shouldCompact };
