import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  handleChannelMessage,
  registerChannel,
  dispatchMessage,
  unregisterChannel,
  type GatewayRuntime,
  type IChannel,
  type IInboundTransport,
  type IOutboundTransport,
  type StreamSink,
  type UnifiedMessage,
  type UnifiedReply,
} from '../index.js';

/* ------------------------------------------------------------------ *
 * Test helpers
 * ------------------------------------------------------------------ */

class CollectingOutbound implements IOutboundTransport {
  readonly sent: UnifiedReply[] = [];
  readonly streamSink: {
    chunks: string[];
    doneText?: string;
    sink: StreamSink;
  };

  constructor() {
    const record = { chunks: [] as string[] };
    this.streamSink = {
      chunks: record.chunks,
      sink: {
        onChunk: async (accumulated) => {
          record.chunks.push(accumulated);
        },
        onDone: async (accumulated) => {
          this.streamSink.doneText = accumulated;
        },
      },
    };
  }

  async send(_targetId: string, reply: UnifiedReply): Promise<unknown> {
    this.sent.push(reply);
    return { ok: true };
  }

  async sendStream(): Promise<StreamSink> {
    return this.streamSink.sink;
  }
}

class PlainOutbound extends CollectingOutbound {
  async sendStream(): Promise<StreamSink> {
    throw new Error('stream unsupported');
  }
}

function makeChannel(outbound: IOutboundTransport): IChannel {
  const inbound: IInboundTransport = {
    start: async () => undefined,
    stop: async () => undefined,
    setMessageHandler: () => undefined,
  };
  return {
    id: 'test',
    name: 'Test',
    defaultEmployeeId: 'general',
    getInbounds: () => [inbound],
    getOutbounds: () => [outbound],
  };
}

function echoRuntime(allowed = true): GatewayRuntime {
  return {
    async isAuthorized() {
      return allowed;
    },
    async notifyUnregistered() {
      /* noop */
    },
    async *process(message: UnifiedMessage) {
      for (const chunk of `echo:${message.messageText}`.match(/.{1,4}/gs) ?? []) {
        yield chunk;
      }
    },
  };
}

const baseMessage: UnifiedMessage = {
  channelId: 'test',
  threadId: 'chat-1',
  userId: 'u1',
  messageText: 'hello',
};

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

test('streaming outbound mirrors accumulated deltas and finalizes', async () => {
  const outbound = new CollectingOutbound();
  const channel = makeChannel(outbound);
  let acked = false;
  const result = await handleChannelMessage(channel, { ...baseMessage, ack: () => { acked = true; } }, echoRuntime());
  void result;
  assert.equal(outbound.streamSink.doneText, 'echo:hello');
  assert.ok(outbound.streamSink.chunks.length >= 1, 'received at least one interim chunk');
  assert.equal(acked, true);
});

test('plain outbound (no stream) collects and sends once', async () => {
  const outbound = new PlainOutbound();
  const channel = makeChannel(outbound);
  await handleChannelMessage(channel, baseMessage, echoRuntime());
  assert.equal(outbound.sent.length, 1);
  assert.equal(outbound.sent[0].text, 'echo:hello');
});

test('allowlist gate rejects unauthorized users with a notice', async () => {
  const outbound = new PlainOutbound();
  const channel = makeChannel(outbound);
  await handleChannelMessage(channel, baseMessage, echoRuntime(false));
  assert.equal(outbound.sent.length, 1);
  assert.match(outbound.sent[0].text, /白名单/);
});

test('registry dispatch routes to the registered channel', async () => {
  const outbound = new PlainOutbound();
  registerChannel(makeChannel(outbound));
  await dispatchMessage(baseMessage, echoRuntime());
  assert.equal(outbound.sent.length, 1);
  assert.equal(outbound.sent[0].text, 'echo:hello');
  unregisterChannel('test');
});
