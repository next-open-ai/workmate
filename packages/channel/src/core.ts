import type { GatewayRuntime } from './runtime.js';
import type { IChannel, StreamSink, UnifiedMessage, UnifiedReply } from './types.js';

const FALLBACK_TEXT = '(无文本回复)';

function throttleMs() {
  return 240;
}

/** Small trailing throttle used for streaming sinks (mirror openclawx). */
function createThrottle(fn: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = 0;
  const run = () => {
    if (timer) clearTimeout(timer);
    const elapsed = Date.now() - last;
    if (elapsed >= throttleMs() || last === 0) {
      last = Date.now();
      fn();
    } else {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn();
      }, throttleMs() - elapsed);
    }
  };
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    fn();
  };
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return { run, flush, cancel };
}

/**
 * Route one inbound message: authorize → stream/collect runtime deltas → send
 * the reply through the channel's outbound (placeholder+updates when the
 * outbound supports streaming, else one final message).
 */
export async function handleChannelMessage(channel: IChannel, message: UnifiedMessage, runtime: GatewayRuntime): Promise<void> {
  const threadId = message.threadId;
  const outbound = channel.getOutboundForMessage ? channel.getOutboundForMessage(message) : channel.getOutbounds()[0];
  const safeSend = async (text: string) => {
    if (!outbound) return undefined;
    try {
      return await outbound.send(threadId, { text } satisfies UnifiedReply);
    } catch (error) {
      console.warn(`[channel:${channel.id}] send failed:`, error);
      return undefined;
    }
  };

  try {
    if (!threadId || threadId === 'default') {
      console.warn(`[channel:${channel.id}] invalid threadId, drop`, message.channelId, threadId);
      return;
    }
    if (!outbound) {
      console.warn(`[channel:${channel.id}] no outbound for thread`, threadId);
      return;
    }
    if (outbound.canSend && !outbound.canSend(threadId)) return;
    if (!(await runtime.isAuthorized(message))) {
      await safeSend('您不在本机白名单内，已忽略该消息。');
      await message.ack?.();
      return;
    }
    const text = message.messageText?.trim() ?? '';
    if (!text) {
      await message.ack?.();
      return;
    }

    // Try streaming outbound first (placeholder + accumulated updates).
    if (typeof outbound.sendStream === 'function') {
      let sink: StreamSink;
      try {
        sink = await outbound.sendStream(threadId);
      } catch (error) {
        console.warn(`[channel:${channel.id}] stream init failed, fallback to plain send:`, error);
        const collected = await collectReply(runtime, message);
        const result = await safeSend(collected);
        await message.ack?.(result);
        return;
      }
      let accumulated = '';
      const throttled = createThrottle(() => {
        void Promise.resolve(sink.onChunk(accumulated)).catch((error) => console.warn('[channel] onChunk failed:', error));
      });
      let done: Promise<unknown> = Promise.resolve(undefined);
      try {
        for await (const delta of runtime.process(message)) {
          accumulated += delta;
          throttled.run();
        }
        throttled.cancel();
        const final = accumulated.trim() || FALLBACK_TEXT;
        done = Promise.resolve(sink.onDone(final)).catch(() => undefined);
      } catch (error) {
        throttled.cancel();
        const fallback = accumulated.trim() || '处理时出错，请稍后再试。';
        done = Promise.resolve(sink.onDone(fallback)).catch(() => undefined);
      }
      await done;
      await message.ack?.(undefined);
      return;
    }

    // Plain outbound: collect and send once.
    const collected = await collectReply(runtime, message);
    const result = await safeSend(collected);
    await message.ack?.(result);
  } catch (error) {
    console.warn(`[channel:${channel.id}] handler error:`, error);
    await safeSend('处理时出错，请稍后再试。').catch(() => undefined);
  }
}

async function collectReply(runtime: GatewayRuntime, message: UnifiedMessage): Promise<string> {
  let accumulated = '';
  try {
    for await (const delta of runtime.process(message)) {
      accumulated += delta;
    }
  } catch (error) {
    accumulated = accumulated.trim() ? `${accumulated.trim()}\n\n处理时出错，请稍后再试。` : '处理时出错，请稍后再试。';
  }
  return accumulated.trim() || FALLBACK_TEXT;
}
