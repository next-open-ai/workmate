/** Visual-only PCM envelope; no fake animation or persisted audio. */
export function voiceEnvelope(samples: ArrayLike<number>, count = 28): number[] {
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor(index * samples.length / count);
    const end = Math.floor((index + 1) * samples.length / count);
    let power = 0;
    for (let i = start; i < end; i++) power += (Number.isFinite(samples[i]) ? samples[i] : 0) ** 2;
    return Math.min(1, Math.sqrt(power / Math.max(1, end - start)) * 4);
  });
}

/** ASR sends full revisions, not append-only deltas. Protect manual edits. */
export class VoiceDraftProjection {
  private base = '';
  private projected = '';
  begin(draft: string) { this.base = draft; this.projected = draft; }
  update(current: string, recognized: string): string {
    if (current !== this.projected) return current;
    this.projected = this.base + (this.base && recognized ? '\n' : '') + recognized;
    return this.projected;
  }
}

export type VoiceCaption = { id: string; question: string; answer: string };
export function mergeVoiceCaption(rows: VoiceCaption[], next: VoiceCaption): VoiceCaption[] {
  if (!next.question && !next.answer) return rows;
  const exists = rows.some(row => row.id === next.id);
  return (exists ? rows.map(row => row.id === next.id ? next : row) : [...rows, next]).slice(-20);
}
