import type { FastifyInstance } from 'fastify';
import { registerAsrRoutes } from './asr-routes.js';
import { registerRealtimeVoiceRoutes } from './realtime-routes.js';

/** Composition root: the two transports keep independent sessions/settings. */
export async function voiceRoutes(app: FastifyInstance) {
  await registerAsrRoutes(app);
  await registerRealtimeVoiceRoutes(app);
}
