import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTtml } from './ttml.js';
import { parseLrc } from './lrc.js';
import { parseTime } from './time.js';
import { distributeWords } from '../normalize.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../../fixtures');
const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const meta = { trackKey: 'test', provider: 'test', tier: 1 };

describe('parseTime', () => {
  it('reads clock, offset and bare-seconds forms', () => {
    expect(parseTime('00:00:18.412')).toBeCloseTo(18412);
    expect(parseTime('02:03.45')).toBeCloseTo(123450);
    expect(parseTime('18.412s')).toBeCloseTo(18412);
    expect(parseTime('250ms')).toBeCloseTo(250);
    expect(parseTime('18.412')).toBeCloseTo(18412);
    expect(parseTime('')).toBeNull();
    expect(parseTime('nope')).toBeNull();
  });
});

describe('TTML', () => {
  const doc = parseTtml(read('sample.ttml'), meta)!;

  it('detects syllable timing', () => {
    expect(doc).not.toBeNull();
    expect(doc.level).toBe('word');
    expect(doc.wordsInterpolated).toBe(false);
  });

  it('keeps one line per <p> plus a separate background line', () => {
    const lead = doc.lines.filter((l) => !l.background);
    expect(lead).toHaveLength(3);
    expect(doc.lines.some((l) => l.background)).toBe(true);
  });

  it('carries agent ids through so duets can be styled apart', () => {
    expect(doc.lines[0]!.agent).toBe('v1');
    expect(doc.lines.find((l) => l.text.startsWith('Gold'))!.agent).toBe('v2');
  });

  it('produces monotonic, non-overlapping words inside each line', () => {
    for (const line of doc.lines) {
      for (let i = 1; i < line.words.length; i += 1) {
        expect(line.words[i]!.startMs).toBeGreaterThanOrEqual(line.words[i - 1]!.startMs);
        expect(line.words[i - 1]!.endMs).toBeLessThanOrEqual(line.words[i]!.startMs + 1);
      }
    }
  });

  it('places the first word exactly where the TTML says', () => {
    expect(doc.lines[0]!.words[0]!.startMs).toBeCloseTo(1000);
    expect(doc.lines[0]!.startMs).toBeCloseTo(1000);
  });
});

describe('LRC', () => {
  it('parses enhanced word tags as real word timings', () => {
    const doc = parseLrc(read('sample-word.lrc'), meta)!;
    expect(doc.level).toBe('word');
    expect(doc.lines).toHaveLength(3);
    expect(doc.lines[0]!.words[0]!.startMs).toBeCloseTo(1000);
    expect(doc.lines[0]!.words[1]!.startMs).toBeCloseTo(1600);
  });

  it('falls back to interpolated words for plain line sync', () => {
    const doc = parseLrc(read('sample-line.lrc'), meta)!;
    expect(doc.level).toBe('line');
    expect(doc.wordsInterpolated).toBe(true);
    expect(doc.lines[0]!.words.length).toBe(4);
  });

  it('agrees with the TTML on line starts', () => {
    const ttml = parseTtml(read('sample.ttml'), meta)!;
    const lrc = parseLrc(read('sample-word.lrc'), meta)!;
    const lead = ttml.lines.filter((l) => !l.background);
    for (let i = 0; i < 3; i += 1) {
      expect(lrc.lines[i]!.startMs).toBeCloseTo(lead[i]!.startMs, 0);
    }
  });
});

describe('distributeWords', () => {
  it('covers the whole line span and stays ordered', () => {
    const words = distributeWords('Gold inside the tower', 8400, 12000);
    expect(words).toHaveLength(4);
    expect(words[0]!.startMs).toBe(8400);
    expect(words[words.length - 1]!.endMs).toBeGreaterThanOrEqual(12000);
    for (let i = 1; i < words.length; i += 1) {
      expect(words[i]!.startMs).toBeGreaterThanOrEqual(words[i - 1]!.startMs);
    }
  });

  it('gives longer words more time than short ones', () => {
    const [a, , c] = distributeWords('extraordinary a tiny', 0, 3000);
    expect(a!.endMs - a!.startMs).toBeGreaterThan(c!.endMs - c!.startMs);
  });

  it('still returns usable timings when the line span is zero', () => {
    const words = distributeWords('one two three', 5000, 5000);
    expect(words).toHaveLength(3);
    for (const w of words) expect(w.endMs).toBeGreaterThan(w.startMs);
  });
});
