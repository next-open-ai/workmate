import { sessionRuns, type ServerRunRecord } from './orchestration';

export type VoiceNotice = 'started' | 'completed' | 'failed' | 'approval' | 'cancelled';
export const VOICE_NOTICE_FILES: Record<VoiceNotice, string[]> = {
  started: ['started-1.wav', 'started-2.wav'], completed: ['completed-1.wav'],
  failed: ['failed.wav'], approval: ['approval.wav'], cancelled: ['cancelled.wav'],
};
export const VOICE_NOTICE_TEXT: Record<VoiceNotice, string> = {
  started: '工作已开始。', completed: '工作已完成，请在关联对话查看结果。',
  failed: '这次执行失败了，请在关联对话查看原因。', approval: '这一步需要审批，请在关联对话确认。', cancelled: '工作已停止。',
};

export class VoiceNoticePlayer {
  private audio?: HTMLAudioElement;
  private queue: Array<{ notice: VoiceNotice; text?: string }> = [];
  private counters = new Map<VoiceNotice, number>();
  private enabled = true;
  private listening = false;
  private playing = false;
  private release?: () => void;
  constructor(private fallback: () => void) {}
  unlock() {
    this.audio ??= new Audio(`${import.meta.env.BASE_URL}voice-notices/started-1.wav`);
    if (this.playing) return;
    this.audio.muted = true;
    void this.audio.play().then(() => { this.audio?.pause(); if (this.audio) { this.audio.currentTime = 0; this.audio.muted = false; } }).catch(() => { if (this.audio) this.audio.muted = false; });
  }
  setEnabled(enabled: boolean) { this.enabled = enabled; if (!enabled) this.stop(); }
  setListening(listening: boolean) {
    this.listening = listening;
    if (listening) { this.audio?.pause(); this.release?.(); }
    else void this.drain();
  }
  enqueue(notice: VoiceNotice) { if (!this.enabled) return; this.queue.push({ notice }); this.queue = this.queue.slice(-12); void this.drain(); }
  speak(text: string, fallbackNotice: VoiceNotice = 'completed') { if (!this.enabled) return; this.queue.push({ notice: fallbackNotice, text: text.trim().slice(0, 50) }); this.queue = this.queue.slice(-12); void this.drain(); }
  private async drain() {
    if (this.playing || this.listening || !this.enabled || !this.queue.length) return;
    this.playing = true;
    const item = this.queue.shift()!;
    if (item.text && await this.speakText(item.text)) { this.playing = false; void this.drain(); return; }
    const notice = item.notice;
    const files = VOICE_NOTICE_FILES[notice]; const index = this.counters.get(notice) || 0;
    this.counters.set(notice, index + 1);
    this.audio ??= new Audio();
    const audio = this.audio; audio.muted = false; audio.src = `${import.meta.env.BASE_URL}voice-notices/${files[index % files.length]}`;
    await new Promise<void>(resolve => {
      let settled = false;
      const finish = () => { if (settled) return; settled = true; clearTimeout(timeout); audio.onended = null; audio.onerror = null; this.release = undefined; resolve(); };
      const timeout = setTimeout(() => { audio.pause(); this.fallback(); finish(); }, 12000);
      this.release = finish; audio.onended = finish; audio.onerror = () => { this.fallback(); finish(); };
      void audio.play().catch(() => { this.fallback(); finish(); });
    });
    this.playing = false; void this.drain();
  }
  private speakText(text: string) {
    if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
      const utterance = new SpeechSynthesisUtterance(text); utterance.lang = 'zh-CN'; utterance.rate = 1.02; utterance.pitch = 1.04;
      let settled = false;
      const finish = (ok: boolean) => { if (settled) return; settled = true; clearTimeout(timeout); utterance.onend = null; utterance.onerror = null; this.release = undefined; resolve(ok); };
      const timeout = setTimeout(() => { window.speechSynthesis.cancel(); finish(false); }, 12_000);
      this.release = () => { window.speechSynthesis.cancel(); finish(true); };
      utterance.onend = () => finish(true); utterance.onerror = () => finish(false);
      try { window.speechSynthesis.speak(utterance); } catch { finish(false); }
    });
  }
  stop() { this.queue = []; this.audio?.pause(); this.release?.(); }
}

export class VoiceTaskMonitor {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;
  constructor(private notify: (notice: VoiceNotice) => void, private poll = sessionRuns) {}
  track(sessionId: string, runId: string) {
    if (this.disposed || this.timers.has(runId)) return;
    const seen = new Set<VoiceNotice>(); let turnId: string | undefined; const began = Date.now();
    const tick = async () => {
      try {
        const runs = await this.poll(sessionId);
        if (this.disposed) return;
        turnId ??= runs.find(run => run.id === runId)?.turnId;
        const matching = runs.filter(run => run.id === runId || (turnId && run.turnId === turnId));
        const run = matching.sort((a, b) => b.attemptNo - a.attemptNo || b.startedAt - a.startedAt)[0];
        const notice = run && noticeForRun(run);
        if (notice && !seen.has(notice)) { seen.add(notice); this.notify(notice); }
        if (run && ['completed', 'failed', 'cancelled'].includes(run.status)) { this.timers.delete(runId); return; }
      } catch { /* Retry read failures; never infer completion from transport loss. */ }
      if (!this.disposed && Date.now() - began < 86400000) this.timers.set(runId, setTimeout(tick, 2000));
      else this.timers.delete(runId);
    };
    this.timers.set(runId, setTimeout(tick, 0));
  }
  dispose() { this.disposed = true; for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); }
}
function noticeForRun(run: ServerRunRecord): VoiceNotice | undefined {
  return ({ running: 'started', completed: 'completed', failed: 'failed', cancelled: 'cancelled', 'waiting-approval': 'approval' } as const)[run.status];
}
