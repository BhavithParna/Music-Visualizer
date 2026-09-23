import type { BeatInfo } from '@lyricroom/shared';

/**
 * Onsets, tempo and a beat clock from the log-spaced band spectrum.
 *
 * Input is one frame of dB-normalised bands (0..1, already log-compressed) per
 * FFT hop. Everything here is deliberately simple and deterministic -- a pure
 * function of the frames it has been fed -- so it can be tested with a
 * synthetic click track.
 *
 *  - Onsets: SuperFlux (Böck & Widmer, DAFx-13). Positive spectral flux where
 *    each band is compared against the max of its neighbours in the previous
 *    frame, which stops vibrato and pitch slides reading as hits. Peaks are
 *    picked against an adaptive mean + k·σ threshold with a per-group
 *    refractory period.
 *  - Tempo: autocorrelation of the kick+snare onset strength over ~7 s,
 *    weighted towards 120 BPM so it does not lock onto half or double time,
 *    then a median over the last few estimates.
 *  - Beat clock: a phase that advances at the estimated tempo and is nudged
 *    towards each kick, so the renderer can *predict* the next beat instead
 *    of reacting a frame late.
 */

export interface BandGroups {
  kick: [number, number];
  snare: [number, number][];
  hat: [number, number];
}

/**
 * Band index ranges for 24 log bands spanning 30 Hz..14 kHz (see
 * `bandEdges()` in spectrum.ts): each band is ~1.29x the one below, so
 * band i starts at 30 * 1.29^i Hz.
 */
export const DEFAULT_GROUPS: BandGroups = {
  kick: [1, 5], //   40-130 Hz
  snare: [[5, 8], [15, 17]], // 110-250 Hz body, 1.5-3 kHz crack
  hat: [21, 23], // 6-12 kHz
};

class Picker {
  private hist: number[] = [];
  private prev = 0;
  private prev2 = 0;
  private sinceOnsetMs = Infinity;

  constructor(private refractoryMs: number, private k = 1.5, private floor = 0.035, private len = 9) {}

  /** Feed one flux value; returns the onset strength (>0) when the previous frame was a peak. */
  push(flux: number, dtMs: number): number {
    this.sinceOnsetMs += dtMs;
    const cand = this.prev;
    let out = 0;
    // One frame of latency: a peak is only known once the next value is lower.
    if (cand > this.prev2 && cand >= flux && this.hist.length >= 4) {
      const mean = this.hist.reduce((a, b) => a + b, 0) / this.hist.length;
      const sd = Math.sqrt(this.hist.reduce((a, b) => a + (b - mean) ** 2, 0) / this.hist.length);
      const thresh = Math.max(this.floor, mean + this.k * sd);
      if (cand > thresh && this.sinceOnsetMs >= this.refractoryMs) {
        this.sinceOnsetMs = 0;
        out = Math.min(1, (cand - mean) / Math.max(thresh, 1e-6));
      }
    }
    this.hist.push(cand);
    if (this.hist.length > this.len) this.hist.shift();
    this.prev2 = this.prev;
    this.prev = flux;
    return out;
  }
}

/** Asymmetric one-pole follower; time constants in ms. */
function follow(cur: number, target: number, dtMs: number, attackMs: number, releaseMs: number): number {
  const tau = target > cur ? attackMs : releaseMs;
  const a = Math.exp(-dtMs / Math.max(1e-3, tau));
  return a * cur + (1 - a) * target;
}

export class BeatTracker {
  private prevBands: Float32Array | null = null;
  private kickPick = new Picker(170);
  private snarePick = new Picker(120);
  private hatPick = new Picker(40, 1.3, 0.025);

  private kickEnv = 0;
  private snareEnv = 0;
  private hatEnv = 0;
  private level = 0;
  private levelMax = 0.05;

  /** Onset strength ring buffer for tempo, one value per frame. */
  private strength: number[] = [];
  private frameMs = 23.2;
  private sinceTempoMs = 0;
  private estimates: number[] = [];
  private bpm = 0;
  private phase = 0;

  constructor(private groups: BandGroups = DEFAULT_GROUPS, private windowMs = 7000) {}

  private flux(bands: Float32Array, [from, to]: [number, number]): number {
    const prev = this.prevBands;
    if (!prev) return 0;
    let sum = 0;
    for (let b = from; b <= to && b < bands.length; b += 1) {
      const ref = Math.max(prev[b - 1] ?? prev[b]!, prev[b]!, prev[b + 1] ?? prev[b]!);
      sum += Math.max(0, bands[b]! - ref);
    }
    return sum;
  }

  push(bands: Float32Array, dtMs: number): void {
    this.frameMs = this.frameMs * 0.95 + dtMs * 0.05;
    const kf = this.flux(bands, this.groups.kick);
    const sf = this.groups.snare.reduce((a, g) => a + this.flux(bands, g), 0);
    const hf = this.flux(bands, this.groups.hat);
    this.prevBands = Float32Array.from(bands);

    const kick = this.kickPick.push(kf, dtMs);
    const snare = this.snarePick.push(sf, dtMs);
    const hat = this.hatPick.push(hf, dtMs);

    // Hits are instant, releases take ~180 ms: motion should land on the
    // frame of the hit and then settle, never flicker.
    this.kickEnv = kick > 0 ? Math.max(this.kickEnv, 0.55 + 0.45 * kick) : follow(this.kickEnv, 0, dtMs, 1, 180);
    this.snareEnv = snare > 0 ? Math.max(this.snareEnv, 0.5 + 0.5 * snare) : follow(this.snareEnv, 0, dtMs, 1, 160);
    this.hatEnv = hat > 0 ? Math.max(this.hatEnv, 0.4 + 0.6 * hat) : follow(this.hatEnv, 0, dtMs, 1, 90);

    // Energy relative to what this song has done so far, so a drop reads as a
    // drop in a quiet song and a loud one alike.
    let mean = 0;
    for (let b = 0; b < bands.length; b += 1) mean += bands[b]!;
    mean /= Math.max(1, bands.length);
    this.level = follow(this.level, mean, dtMs, 2500, 3500);
    this.levelMax = Math.max(this.level, this.levelMax * Math.exp(-dtMs / 60_000), 0.05);

    // Tempo.
    this.strength.push(kf + sf * 0.6);
    const maxFrames = Math.ceil(this.windowMs / this.frameMs);
    if (this.strength.length > maxFrames) this.strength.splice(0, this.strength.length - maxFrames);
    this.sinceTempoMs += dtMs;
    if (this.sinceTempoMs >= 2000 && this.strength.length >= maxFrames * 0.6) {
      this.sinceTempoMs = 0;
      const est = estimateBpm(this.strength, this.frameMs);
      if (est > 0) {
        this.estimates.push(est);
        if (this.estimates.length > 5) this.estimates.shift();
        const sorted = [...this.estimates].sort((a, b) => a - b);
        this.bpm = sorted[sorted.length >> 1]!;
      }
    }

    // Beat clock: free-run at the tempo, pull towards each kick.
    if (this.bpm > 0) {
      this.phase = (this.phase + (dtMs / 60_000) * this.bpm) % 1;
      if (kick > 0) {
        const err = this.phase > 0.5 ? this.phase - 1 : this.phase;
        this.phase = ((this.phase - err * 0.35) % 1 + 1) % 1;
      }
    } else if (kick > 0) {
      this.phase = 0;
    }
  }

  get state(): BeatInfo {
    const r = (v: number): number => Number(v.toFixed(3));
    return {
      bpm: Number(this.bpm.toFixed(1)),
      phase: r(this.phase),
      kick: r(this.kickEnv),
      snare: r(this.snareEnv),
      hat: r(this.hatEnv),
      energy: r(Math.min(1, this.level / this.levelMax)),
    };
  }
}

/**
 * Tempo from an onset-strength envelope sampled every `frameMs`.
 * Returns 0 when there is no periodicity worth trusting.
 */
export function estimateBpm(strength: number[], frameMs: number): number {
  const n = strength.length;
  if (n < 16) return 0;
  const mean = strength.reduce((a, b) => a + b, 0) / n;
  const x = strength.map((v) => v - mean);
  const energy = x.reduce((a, v) => a + v * v, 0);
  if (energy <= 1e-9) return 0;

  const minLag = Math.max(2, Math.floor(333 / frameMs)); // 180 BPM
  const maxLag = Math.min(n - 2, Math.ceil(1000 / frameMs)); // 60 BPM
  const ac: number[] = [];
  let best = -Infinity;
  let bestLag = 0;
  for (let lag = minLag - 1; lag <= maxLag + 1; lag += 1) {
    let s = 0;
    for (let i = lag; i < n; i += 1) s += x[i]! * x[i - lag]!;
    s /= energy;
    ac[lag] = s;
    if (lag < minLag || lag > maxLag) continue;
    const lagSec = (lag * frameMs) / 1000;
    // Log-Gaussian prior around 120 BPM (0.5 s), one octave wide.
    const w = Math.exp(-0.5 * Math.log2(lagSec / 0.5) ** 2);
    if (s * w > best) {
      best = s * w;
      bestLag = lag;
    }
  }
  if (bestLag === 0 || (ac[bestLag] ?? 0) < 0.08) return 0;

  // Parabolic refinement between frames.
  const a = ac[bestLag - 1] ?? 0;
  const b = ac[bestLag]!;
  const c = ac[bestLag + 1] ?? 0;
  const denom = a - 2 * b + c;
  const shift = Math.abs(denom) > 1e-9 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
  const lagMs = (bestLag + shift) * frameMs;
  let bpm = 60_000 / lagMs;
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return bpm;
}
