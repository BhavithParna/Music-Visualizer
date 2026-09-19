import { describe, expect, it } from 'vitest';
import type { LyricLine, LyricWord } from '@lyricroom/shared';
import { buildPhrases, splitIntoPhrases } from './phrases.js';

/** Build a line from `[text, startMs, endMs]` triples. */
function line(spans: [string, number, number][], extra: Partial<LyricLine> = {}): LyricLine {
  const words: LyricWord[] = spans.map(([text, startMs, endMs]) => ({ text, startMs, endMs }));
  return {
    text: spans.map(([t]) => t).join(' '),
    startMs: words[0]?.startMs ?? 0,
    endMs: words[words.length - 1]?.endMs ?? 0,
    words,
    ...extra,
  };
}

/** Evenly spaced words, `step` ms each, back to back. */
function run(texts: string[], step = 200, from = 0): [string, number, number][] {
  return texts.map((t, i) => [t, from + i * step, from + i * step + step]);
}

describe('splitIntoPhrases', () => {
  it('leaves a short line as one phrase', () => {
    const phrases = splitIntoPhrases(line(run(['Run', 'the', 'night'])), 0);
    expect(phrases).toHaveLength(1);
    expect(phrases[0]!.text).toBe('Run the night');
    expect(phrases[0]!.lineIndex).toBe(0);
    expect(phrases[0]!.phraseIndex).toBe(0);
  });

  it('never puts more than four words on screen at once', () => {
    const bar = run(['They', 'put', 'a', 'lock', 'on', 'it', 'so', 'we', 'go'], 200);
    const phrases = splitIntoPhrases(line(bar), 3);
    expect(phrases.length).toBeGreaterThan(1);
    for (const p of phrases) {
      expect(p.words.length).toBeLessThanOrEqual(4);
      expect(p.text).toBe(p.words.map((w) => w.text).join(' '));
      expect(p.lineIndex).toBe(3);
    }
    // Every word survives the split, in order.
    expect(phrases.flatMap((p) => p.words.map((w) => w.text))).toEqual(bar.map(([t]) => t));
  });

  it('breaks at a silence inside the line', () => {
    const phrases = splitIntoPhrases(
      line([['Wait', 0, 300], ['for', 300, 600], ['me', 2000, 2400]]),
      0,
    );
    expect(phrases.map((p) => p.text)).toEqual(['Wait for', 'me']);
  });

  it('breaks early when the words are long, before the type has to shrink', () => {
    const phrases = splitIntoPhrases(line(run(['Everything', 'beautiful', 'burning'])), 0);
    expect(phrases.length).toBeGreaterThan(1);
    for (const p of phrases) {
      expect(p.text.replace(/ /g, '').length).toBeLessThanOrEqual(22);
    }
  });

  it('gives the glyph to exactly one phrase: the one holding the longest word', () => {
    const phrases = splitIntoPhrases(
      line([
        ['Two', 0, 200], ['quick', 200, 400], ['ones', 400, 600], ['here', 600, 800],
        ['then', 800, 1000], ['gone', 1000, 3000],
      ]),
      0,
    );
    expect(phrases.filter((p) => p.carriesGlyph)).toHaveLength(1);
    expect(phrases.find((p) => p.carriesGlyph)!.words.some((w) => w.text === 'gone')).toBe(true);
  });

  it('runs phrases in order without overlapping', () => {
    const phrases = splitIntoPhrases(line(run(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])), 0);
    for (let i = 0; i < phrases.length; i += 1) {
      expect(phrases[i]!.phraseIndex).toBe(i);
      expect(phrases[i]!.endMs).toBeGreaterThan(phrases[i]!.startMs);
      if (i > 0) expect(phrases[i]!.startMs).toBeGreaterThanOrEqual(phrases[i - 1]!.startMs);
    }
  });

  it('holds the last phrase past its words so a trailing rest is not empty screen', () => {
    const l = line(run(['hold', 'this', 'one']), { endMs: 5000 });
    const last = splitIntoPhrases(l, 0).at(-1)!;
    expect(last.endMs).toBeGreaterThan(600);
    // ...but never past the end of the line itself.
    expect(last.endMs).toBeLessThanOrEqual(l.endMs);
  });

  it('keeps a wordless line renderable', () => {
    const phrases = splitIntoPhrases({ text: 'Instrumental', startMs: 0, endMs: 900, words: [] }, 2);
    expect(phrases).toHaveLength(1);
    expect(phrases[0]!.text).toBe('Instrumental');
    expect(phrases[0]!.carriesGlyph).toBe(true);
  });

  it('carries the line role onto every phrase of it', () => {
    const phrases = splitIntoPhrases(
      line(run(['soft', 'in', 'the', 'back', 'of', 'the', 'room']), { background: true, part: 'chorus', agent: 'v2' }),
      1,
    );
    expect(phrases.length).toBeGreaterThan(1);
    for (const p of phrases) {
      expect(p.background).toBe(true);
      expect(p.part).toBe('chorus');
      expect(p.agent).toBe('v2');
    }
  });
});

describe('buildPhrases', () => {
  it('numbers phrases across the whole document', () => {
    const phrases = buildPhrases([
      line(run(['first', 'line', 'here'], 200, 0)),
      line(run(['second', 'line', 'now'], 200, 2000)),
    ]);
    expect(new Set(phrases.map((p) => p.lineIndex))).toEqual(new Set([0, 1]));
  });

  it('tells a phrase to leave before the next one lands, across lines too', () => {
    const phrases = buildPhrases([
      line([['hold', 0, 400]], { endMs: 4000 }),
      line([['next', 1000, 1400]]),
    ]);
    // Without the handoff the first phrase would still be held at 1000.
    expect(phrases[0]!.endMs).toBeLessThan(phrases[1]!.startMs);
  });

  it('leaves a phrase alone when nothing follows it soon', () => {
    const phrases = buildPhrases([
      line(run(['alone', 'here'], 200, 0), { endMs: 900 }),
      line([['later', 9000, 9400]]),
    ]);
    expect(phrases[0]!.endMs).toBe(900);
  });

  it('never clamps a phrase down to a flash', () => {
    const phrases = buildPhrases([
      line([['a', 0, 60]]),
      line([['b', 80, 300]]),
    ]);
    expect(phrases[0]!.endMs - phrases[0]!.startMs).toBeGreaterThanOrEqual(160);
  });
});
