import { describe, expect, it } from 'vitest';
import type { LyricDoc } from '@lyricroom/shared';
import { analyzeSong } from './mood.js';

function doc(texts: string[], wordMs = 350): LyricDoc {
  let t = 0;
  const lines = texts.map((text) => {
    const words = text.split(' ').map((w, i) => ({ text: w, startMs: t + i * wordMs, endMs: t + (i + 1) * wordMs }));
    const line = { text, startMs: t, endMs: t + words.length * wordMs, words };
    t = line.endMs + 500;
    return line;
  });
  return { trackKey: 'test', level: 'word', provider: 'test', tier: 0, lines, confidence: 1, fetchedAt: 0 };
}

describe('analyzeSong', () => {
  it('reads a happy love song as positive', () => {
    const p = analyzeSong(doc([
      'I love you baby you make me smile', 'hold me close my darling', 'this love is beautiful and bright',
      'kiss me happy forever together',
    ]));
    expect(p.valence).toBeGreaterThan(0.3);
    expect(p.themes[0]).toBe('love');
  });

  it('reads a slow sad song as negative and calm', () => {
    const p = analyzeSong(doc([
      'I cry alone in the cold rain', 'you are gone and I miss you', 'empty room and broken heart',
      'the tears fall slow tonight',
    ], 700));
    expect(p.valence).toBeLessThan(-0.3);
    expect(p.arousal).toBeLessThan(0.45);
    expect(p.themes).toContain('heartbreak');
  });

  it('reads a fast shouted party track as intense', () => {
    const p = analyzeSong(doc([
      'JUMP jump get wild tonight!', 'fire in the club go crazy!', 'party party bang bang!', 'JUMP jump get wild tonight!',
    ], 160));
    expect(p.arousal).toBeGreaterThan(0.65);
    expect(p.density).toBeGreaterThan(4);
    expect(p.lineMood).toHaveLength(4);
    expect(p.lineSection).toHaveLength(4);
  });
});
