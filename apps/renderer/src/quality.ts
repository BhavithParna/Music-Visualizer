import type { RenderTier, TierSetting } from '@lyricroom/shared';

/**
 * The render tier: Cinema (the full look, for a strong GPU) or Smooth (holds
 * 60 fps on integrated graphics).
 *
 * The daemon stores the user's choice; `auto` is resolved here, per display,
 * because only the machine doing the drawing knows how fast it is. The first
 * time a display runs on `auto` it renders the Cinema look for a few seconds,
 * measures, and remembers the answer for this screen and this GPU.
 */

const PROBE_WARMUP = 60;
const PROBE_FRAMES = 180;
const STORE_KEY = 'lyricroom.tierProbe.v1';

interface ProbeRecord {
  key: string;
  tier: RenderTier;
  medianMs: number;
  slowShare: number;
  gpuP95Ms: number | null;
}

function readStore(): ProbeRecord | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as ProbeRecord) : null;
  } catch {
    return null;
  }
}

function writeStore(rec: ProbeRecord): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(rec));
  } catch {
    /* private window: we simply probe again next time */
  }
}

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
};

export class Quality {
  private setting: TierSetting = 'auto';
  /** A `?tier=` URL pin wins over everything, for iterating in the fixture. */
  private pinned: RenderTier | null = null;
  private probed: ProbeRecord | null = null;
  private probing = false;
  private frames: number[] = [];
  private gpu: number[] = [];
  private seen = 0;
  private last = 0;
  private listeners: ((tier: RenderTier) => void)[] = [];
  private current: RenderTier;
  private deviceKey = '';

  constructor(pin: string | null) {
    if (pin === 'cinema' || pin === 'smooth') this.pinned = pin;
    this.current = this.resolve();
  }

  /** Called once the GL stage knows which GPU it is on. */
  setDevice(renderer: string): void {
    this.deviceKey = `${screen.width}x${screen.height}|${renderer}`;
    const rec = readStore();
    this.probed = rec && rec.key === this.deviceKey ? rec : null;
    this.update();
  }

  setSetting(setting: TierSetting): void {
    this.setting = setting;
    this.update();
  }

  get tier(): RenderTier {
    return this.current;
  }

  /** True while the startup probe is measuring; the stage then draws its heaviest look. */
  get isProbing(): boolean {
    return this.probing;
  }

  get settingLabel(): string {
    if (this.pinned) return `${this.pinned} (url)`;
    if (this.setting !== 'auto') return this.setting;
    if (this.probing) return 'auto: probing';
    if (this.probed) return `auto: ${this.probed.tier} (${this.probed.medianMs.toFixed(1)}ms` +
      `${this.probed.gpuP95Ms !== null ? `, gpu ${this.probed.gpuP95Ms.toFixed(1)}ms` : ''})`;
    return 'auto';
  }

  onChange(fn: (tier: RenderTier) => void): void {
    this.listeners.push(fn);
  }

  /** Forget the probe and measure again (after a GPU or display change). */
  reprobe(): void {
    this.probed = null;
    try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
    this.update();
  }

  /**
   * Feed every frame: its rAF timestamp and, when the GPU timer extension is
   * available, the stage's measured GPU time. Only used while probing.
   */
  sample(now: number, gpuMs: number | null): void {
    if (!this.probing) return;
    if (this.last) {
      this.seen += 1;
      if (this.seen > PROBE_WARMUP) {
        this.frames.push(now - this.last);
        if (gpuMs !== null) this.gpu.push(gpuMs);
      }
    }
    this.last = now;
    if (this.frames.length >= PROBE_FRAMES) this.finishProbe();
  }

  private finishProbe(): void {
    const medianMs = pct(this.frames, 0.5);
    // A frame is slow when it took well over the typical interval: that is a
    // dropped vsync, whatever the refresh rate of this panel.
    const slowShare = this.frames.filter((d) => d > Math.max(medianMs * 1.5, 20)).length / this.frames.length;
    const gpuP95Ms = this.gpu.length > 20 ? pct(this.gpu, 0.95) : null;
    const tooSlow = medianMs > 20 || slowShare > 0.08 || (gpuP95Ms !== null && gpuP95Ms > 9);
    this.probed = { key: this.deviceKey, tier: tooSlow ? 'smooth' : 'cinema', medianMs, slowShare, gpuP95Ms };
    writeStore(this.probed);
    this.probing = false;
    this.update();
  }

  private resolve(): RenderTier {
    if (this.pinned) return this.pinned;
    if (this.setting !== 'auto') return this.setting;
    if (this.probed) return this.probed.tier;
    // Probe on the heavier tier: that is the one whose cost we need to know.
    return 'cinema';
  }

  private update(): void {
    const wantProbe = !this.pinned && this.setting === 'auto' && !this.probed && this.deviceKey !== '';
    if (wantProbe && !this.probing) {
      this.probing = true;
      this.frames = [];
      this.gpu = [];
      this.seen = 0;
      this.last = 0;
    } else if (!wantProbe) {
      this.probing = false;
    }
    const next = this.resolve();
    if (next !== this.current) {
      this.current = next;
      for (const fn of this.listeners) fn(next);
    }
  }
}
