import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { monoNow } from '../clock.js';
import { fft, hann } from './fft.js';

const execFileP = promisify(execFile);

const FFT_SIZE = 2048;
const SAMPLE_RATE = 44100;
const BANDS = 24;
const EMIT_HZ = 60;

export interface SpectrumHandle {
  stop(): void;
}

export type SpectrumListener = (bands: number[], bass: number, atServerMs: number) => void;

/** Log-spaced band edges from 30 Hz to 14 kHz, which is where music actually lives. */
function bandEdges(): number[] {
  const low = 30;
  const high = 14_000;
  const edges: number[] = [];
  for (let i = 0; i <= BANDS; i += 1) {
    const f = low * Math.pow(high / low, i / BANDS);
    edges.push(Math.min(FFT_SIZE / 2 - 1, Math.round((f * FFT_SIZE) / SAMPLE_RATE)));
  }
  return edges;
}

async function defaultMonitor(): Promise<string | null> {
  try {
    const { stdout } = await execFileP('pactl', ['get-default-sink'], { timeout: 3000 });
    const sink = stdout.trim();
    return sink ? `${sink}.monitor` : null;
  } catch {
    return null;
  }
}

/**
 * Optional audio-reactivity feed.
 *
 * Chrome on Linux cannot capture a PipeWire monitor through getUserMedia or
 * getDisplayMedia, so the spectrum has to come from outside the browser. We read
 * the default sink's monitor with pw-record and push bands over the socket.
 *
 * Purely decorative: if pw-record or pactl is missing, the visuals simply run
 * without reactivity rather than failing.
 */
export function startSpectrum(listener: SpectrumListener): SpectrumHandle {
  let proc: ChildProcess | null = null;
  let stopped = false;
  let retry: NodeJS.Timeout | null = null;

  const window = hann(FFT_SIZE);
  const edges = bandEdges();
  const acc = new Float32Array(FFT_SIZE);
  let accLen = 0;
  let carry: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const smoothed = new Float32Array(BANDS);
  let bassEnv = 0;
  let lastEmit = 0;

  const process_ = (): void => {
    const re = new Float32Array(FFT_SIZE);
    const im = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i += 1) re[i] = acc[i]! * window[i]!;
    fft(re, im);

    const raw = new Float32Array(BANDS);
    for (let b = 0; b < BANDS; b += 1) {
      const from = edges[b]!;
      const to = Math.max(from + 1, edges[b + 1]!);
      let sum = 0;
      for (let k = from; k < to; k += 1) {
        sum += Math.hypot(re[k]!, im[k]!);
      }
      const mag = sum / (to - from);
      // dB-ish compression keeps quiet passages visible without clipping loud ones.
      raw[b] = Math.min(1, Math.max(0, (20 * Math.log10(mag + 1e-6) + 70) / 70));
    }

    // Fast attack, slow release: motion should bloom and settle, never flicker.
    for (let b = 0; b < BANDS; b += 1) {
      const target = raw[b]!;
      const cur = smoothed[b]!;
      smoothed[b] = target > cur ? cur + (target - cur) * 0.55 : cur + (target - cur) * 0.12;
    }
    const bassRaw = (smoothed[0]! + smoothed[1]! + smoothed[2]!) / 3;
    bassEnv = bassRaw > bassEnv ? bassEnv + (bassRaw - bassEnv) * 0.5 : bassEnv + (bassRaw - bassEnv) * 0.08;

    const now = monoNow();
    if (now - lastEmit >= 1000 / EMIT_HZ) {
      lastEmit = now;
      listener(Array.from(smoothed, (v) => Number(v.toFixed(3))), Number(bassEnv.toFixed(3)), now);
    }
  };

  const onData = (chunk: Buffer): void => {
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const usable = buf.length - (buf.length % 4);
    carry = buf.subarray(usable);
    for (let off = 0; off + 4 <= usable; off += 4) {
      acc[accLen] = buf.readFloatLE(off);
      accLen += 1;
      if (accLen === FFT_SIZE) {
        process_();
        // 50% overlap keeps the response smooth at 60 Hz output.
        acc.copyWithin(0, FFT_SIZE / 2);
        accLen = FFT_SIZE / 2;
      }
    }
  };

  const launch = async (): Promise<void> => {
    if (stopped) return;
    const monitor = await defaultMonitor();
    if (!monitor || stopped) return;
    const child = spawn(
      'pw-record',
      ['--target', monitor, '--rate', String(SAMPLE_RATE), '--channels', '1', '--format', 'f32', '-'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    proc = child;
    child.stdout?.on('data', onData);
    const restart = (): void => {
      if (stopped || proc !== child) return;
      proc = null;
      // The default sink changes when headphones are plugged in; just reconnect.
      retry = setTimeout(() => void launch(), 4000);
    };
    child.on('exit', restart);
    child.on('error', restart);
  };

  void launch();

  return {
    stop(): void {
      stopped = true;
      if (retry) clearTimeout(retry);
      proc?.kill();
      proc = null;
    },
  };
}
