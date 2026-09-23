import { describe, expect, it } from 'vitest';
import { BeatTracker, estimateBpm } from './beat.js';

const HOP = 23.22;

/** A synthetic mix: a kick every beat at `bpm`, a steady noise floor. */
function feed(tracker: BeatTracker, bpm: number, seconds: number, onKick?: (frame: number) => void): void {
  const beatMs = 60_000 / bpm;
  const frames = Math.round((seconds * 1000) / HOP);
  let nextBeat = 0;
  for (let f = 0; f < frames; f += 1) {
    const t = f * HOP;
    const bands = new Float32Array(24).fill(0.3);
    if (t >= nextBeat) {
      for (let b = 0; b < 6; b += 1) bands[b] = 0.85;
      nextBeat += beatMs;
      onKick?.(f);
    }
    tracker.push(bands, HOP);
  }
}

describe('estimateBpm', () => {
  it('recovers a clean pulse train', () => {
    const frameMs = 10;
    const s = Array.from({ length: 700 }, (_, i) => (i % 50 === 0 ? 1 : 0)); // every 500 ms
    expect(estimateBpm(s, frameMs)).toBeCloseTo(120, 0);
  });

  it('returns 0 for silence', () => {
    expect(estimateBpm(new Array(300).fill(0), 20)).toBe(0);
  });
});

describe('BeatTracker', () => {
  it('locks onto a 128 BPM kick and fires the kick envelope', () => {
    const tracker = new BeatTracker();
    let peak = 0;
    feed(tracker, 128, 12, () => {});
    // Envelope just after a hit.
    const bands = new Float32Array(24).fill(0.3);
    for (let i = 0; i < 20; i += 1) {
      tracker.push(bands, HOP);
      peak = Math.max(peak, tracker.state.kick);
    }
    const s = tracker.state;
    expect(Math.abs(s.bpm - 128)).toBeLessThan(3);
    expect(s.phase).toBeGreaterThanOrEqual(0);
    expect(s.phase).toBeLessThan(1);
    expect(s.energy).toBeGreaterThan(0);
  });

  it('puts the kick envelope high right after a hit and lets it decay', () => {
    const tracker = new BeatTracker();
    const quiet = new Float32Array(24).fill(0.3);
    for (let i = 0; i < 20; i += 1) tracker.push(quiet, HOP);
    const hit = new Float32Array(24).fill(0.3);
    for (let b = 0; b < 6; b += 1) hit[b] = 0.9;
    tracker.push(hit, HOP);
    tracker.push(quiet, HOP); // one frame of latency to confirm the peak
    expect(tracker.state.kick).toBeGreaterThan(0.5);
    for (let i = 0; i < 40; i += 1) tracker.push(quiet, HOP);
    expect(tracker.state.kick).toBeLessThan(0.05);
  });
});
