export interface DurableRunTiming {
  startedAt?: number;
  finishedAt?: number;
}

export interface LocalMessageTiming {
  startedAt?: number;
  elapsedMs?: number;
}

/** Restore one assistant turn from durable run time, never from component mount time. */
export function resolveAssistantTiming(
  local: LocalMessageTiming | undefined,
  run: DurableRunTiming | undefined,
  messageCreatedAt: number | undefined,
): LocalMessageTiming {
  const startedAt = local?.startedAt || run?.startedAt || messageCreatedAt;
  const elapsedMs = local?.elapsedMs != null
    ? local.elapsedMs
    : run?.finishedAt && startedAt
      ? Math.max(0, run.finishedAt - startedAt)
      : undefined;
  return {
    ...(startedAt ? { startedAt } : {}),
    ...(elapsedMs != null ? { elapsedMs } : {}),
  };
}

export function shouldPollServerMirror(serverSessionId: string | undefined, mobileMirrorEnabled: boolean | undefined) {
  return Boolean(serverSessionId && mobileMirrorEnabled);
}
