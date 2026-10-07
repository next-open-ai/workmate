export function isVoiceWorkCommand(text: string): boolean {
  const value = text.trim();
  if (/[?？“”「」『』"']|不要|别|不用|无需|不必|没必要|不执行|不开始|先不|暂不|停止|暂缓|等一下|等会|先等等|先记|能不能|可不可以|能否|可以吗|是否|是不是|假如|如果|举例|比如|邮件里|他说|她说|取消/.test(value)) return false;
  const match = value.match(/(?:[,，。！!\s]*)(开始干活|开始执行|开始工作|现在执行|执行吧|开始吧|动手吧)[。！!\s]*$/);
  if (!match || match.index === undefined) return false;
  const objective = value.slice(0, match.index).trim();
  return objective.length >= 6 && !/^(就按刚才|按刚才|照刚才)/.test(objective);
}

export class VoiceCommandCandidate {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private revision = 0;
  private rejected = '';
  constructor(private pending: (active: boolean) => void, private execute: () => void) {}
  reset() { this.rejected = ''; this.cancel(); }
  cancel(rejectText?: string) {
    this.revision++; clearTimeout(this.timer); this.timer = undefined; this.pending(false);
    if (rejectText !== undefined) this.rejected = rejectText;
  }
  update(text: string, allowed: boolean) {
    this.cancel();
    if (!allowed || text === this.rejected || !isVoiceWorkCommand(text)) return;
    const revision = this.revision;
    this.timer = setTimeout(() => {
      if (revision !== this.revision) return;
      this.pending(true);
      this.timer = setTimeout(() => {
        if (revision !== this.revision) return;
        this.rejected = text; this.pending(false); this.execute();
      }, 1000);
    }, 1200);
  }
}
