import { z } from 'zod';

export const MobileVoiceCreateSchema = z.object({}).strict();
export const MobileVoiceCapabilitiesSchema = z.object({ enabled: z.boolean(), workEnabled: z.boolean() }).strict();
export const MobileVoiceSessionSchema = z.object({ session_id: z.string().min(1).max(80), expiresAt: z.number().positive() }).strict();
export const MobileVoiceAudioSchema = z.object({
  audio: z.string().min(4).max(12800).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict();
