import { z } from 'zod';

export const VoiceModeSchema = z.enum(['realtime', 'input']);
export const AsrResourceSchema = z.enum(['volc.seedasr.sauc.duration', 'volc.seedasr.sauc.concurrent', 'volc.bigasr.sauc.duration', 'volc.bigasr.sauc.concurrent']);
export const AsrSessionSchema = z.object({ session_id: z.string().uuid() }).strict();
export const AsrAudioSchema = AsrSessionSchema.extend({ audio: z.string().min(4).max(44_000).regex(/^[A-Za-z0-9+/]+={0,2}$/) });
export const AsrEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('connected') }),
  z.object({ type: z.literal('transcript'), text: z.string().max(32_000), isFinal: z.boolean() }),
  z.object({ type: z.literal('completed'), text: z.string().max(32_000) }),
  z.object({ type: z.literal('error'), message: z.string().max(500) }),
  z.object({ type: z.literal('closed') }),
]);
export type AsrEvent = z.infer<typeof AsrEventSchema>;
export const AsrPublicSettingsSchema = z.object({
  voiceMode: VoiceModeSchema.default('realtime'), asrEnabled: z.boolean().default(true),
  asrReuseKey: z.boolean().default(true), asrResourceId: AsrResourceSchema.default('volc.seedasr.sauc.duration'),
  asrEnablePunc: z.boolean().default(true), asrEnableItn: z.boolean().default(true),
  asrConfigured: z.boolean(), asrApiKeyMasked: z.string(), asrKeySource: z.enum(['realtime', 'environment', 'settings']),
});
export type AsrPublicSettings = z.infer<typeof AsrPublicSettingsSchema>;
