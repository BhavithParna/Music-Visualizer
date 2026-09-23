export interface OverlayInfo {
  fps: number;
  mode: string;
  level: string;
  provider: string;
  lines: number;
  posMs: number;
  offsetMs: number;
  rtt: number;
  online: boolean;
  active: number;
  track: string;
  tier: string;
  look: string;
  reason: string;
  section: string;
  beat: string;
  gpu: string;
  mood: string;
}

const mmss = (ms: number): string => {
  const neg = ms < 0;
  const v = Math.abs(ms);
  const m = Math.floor(v / 60_000);
  const s = Math.floor((v % 60_000) / 1000);
  return `${neg ? '-' : ''}${m}:${String(s).padStart(2, '0')}`;
};

/** Diagnostic HUD. Toggled with `d`; hidden by default so the room stays clean. */
export class Overlay {
  private el = document.getElementById('overlay') as HTMLElement;
  private frames = 0;
  private last = performance.now();
  private fps = 0;

  toggle(): void {
    this.el.hidden = !this.el.hidden;
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  tick(now: number): void {
    this.frames += 1;
    if (now - this.last >= 500) {
      this.fps = Math.round((this.frames * 1000) / (now - this.last));
      this.frames = 0;
      this.last = now;
    }
  }

  render(info: Omit<OverlayInfo, 'fps'>): void {
    if (this.el.hidden) return;
    this.el.innerHTML =
      `<b>${info.track || '--'}</b>\n` +
      `fps ${String(this.fps).padStart(3)}   mode ${info.mode.padEnd(5)} active ${info.active}\n` +
      `pos ${mmss(info.posMs).padStart(7)}  offset ${info.offsetMs}ms\n` +
      `lyr ${info.level.padEnd(8)} ${info.lines} lines\n` +
      `src ${info.provider || '--'}\n` +
      `ws  ${info.online ? 'up' : 'DOWN'}  rtt ${info.rtt.toFixed(1)}ms\n` +
      `gfx ${info.tier}  gpu ${info.gpu}\n` +
      `look ${info.look}\n` +
      `why ${info.reason}   mood ${info.mood}\n` +
      `sec ${info.section}   beat ${info.beat}`;
  }

  get currentFps(): number {
    return this.fps;
  }
}
