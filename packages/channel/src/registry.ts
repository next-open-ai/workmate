import type { IChannel, UnifiedMessage } from './types.js';
import { handleChannelMessage } from './core.js';
import type { GatewayRuntime } from './runtime.js';

/** Channel registry: adapters register here; inbound handlers dispatch here. */

const channels = new Map<string, IChannel>();

export function registerChannel(channel: IChannel): void {
  channels.set(channel.id, channel);
}

export function unregisterChannel(channelId: string): void {
  channels.delete(channelId);
}

export function getChannel(channelId: string): IChannel | undefined {
  return channels.get(channelId);
}

export function listChannels(): IChannel[] {
  return [...channels.values()];
}

export async function dispatchMessage(message: UnifiedMessage, runtime: GatewayRuntime): Promise<void> {
  const channel = channels.get(message.channelId);
  if (!channel) {
    await runtime.notifyUnregistered(message);
    return;
  }
  await handleChannelMessage(channel, message, runtime);
}

export async function startAllChannels(): Promise<void> {
  for (const channel of channels.values()) {
    for (const inbound of channel.getInbounds()) {
      await inbound.start().catch((error) => console.warn(`[channel] start ${channel.id} failed:`, error));
    }
  }
}

export async function stopAllChannels(): Promise<void> {
  for (const channel of channels.values()) {
    for (const inbound of channel.getInbounds()) {
      await inbound.stop().catch(() => undefined);
    }
  }
}
