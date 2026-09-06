export type {
  IChannel,
  IInboundTransport,
  IOutboundTransport,
  StreamSink,
  UnifiedMessage,
  UnifiedReply,
  ChannelAttachment,
} from './types.js';
export type { GatewayRuntime } from './runtime.js';
export { handleChannelMessage } from './core.js';
export {
  registerChannel,
  unregisterChannel,
  getChannel,
  listChannels,
  dispatchMessage,
  startAllChannels,
  stopAllChannels,
} from './registry.js';
