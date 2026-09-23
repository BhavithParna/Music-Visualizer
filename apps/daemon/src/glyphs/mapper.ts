import type { LyricDoc } from '@lyricroom/shared';
import { GLYPH_MAP, STOPWORDS } from './map.js';

/** Crude English stemmer: enough to match `burning`/`burned`/`burns` to `burn`. */
export function stem(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z']/g, '').replace(/'(s|re|ve|ll|d|m)$/,'');
  if (w.length <= 3) return w;
  for (const [suffix, min] of [['ing', 5], ['ed', 4], ['es', 4], ['s', 4], ['in', 5]] as const) {
    if (w.length >= min && w.endsWith(suffix)) {
      const base = w.slice(0, -suffix.length);
      if (GLYPH_MAP[base]) return base;
      // doubled consonant: running -> run
      const undoubled = base.replace(/([bdfglmnprt])\1$/, '$1');
      if (GLYPH_MAP[undoubled]) return undoubled;
      if (GLYPH_MAP[`${base}e`]) return `${base}e`;
      w = base;
      break;
    }
  }
  return w;
}

export interface GlyphOptions {
  /** Upper bound on the share of lines that may carry a glyph. */
  maxDensity?: number;
  /** Minimum number of lines between two glyphs. */
  minGap?: number;
}

/**
 * Choose at most one glyph per line, for a minority of lines.
 *
 * Scoring favours words that are rare *within this song*, so a track that says
 * "fire" in every line does not get a flame on every line: the first occurrence
 * carries the idea and the rest stay clean.
 */
export function mapGlyphs(doc: LyricDoc, opts: GlyphOptions = {}): Record<number, string> {
  const maxDensity = opts.maxDensity ?? 0.16;
  const minGap = opts.minGap ?? 3;

  // Document frequency of each stem across the song.
  const df = new Map<string, number>();
  const perLine: { stem: string; glyph: string; pos: number }[][] = [];

  doc.lines.forEach((line) => {
    const seen = new Set<string>();
    const hits: { stem: string; glyph: string; pos: number }[] = [];
    const tokens = line.text.split(/\s+/);
    tokens.forEach((token, i) => {
      const s = stem(token);
      if (!s || STOPWORDS.has(s)) return;
      const glyph = GLYPH_MAP[s];
      if (!glyph) return;
      if (!seen.has(s)) {
        seen.add(s);
        df.set(s, (df.get(s) ?? 0) + 1);
      }
      hits.push({ stem: s, glyph, pos: i / Math.max(1, tokens.length - 1) });
    });
    perLine.push(hits);
  });

  const total = Math.max(1, doc.lines.length);
  const scored: { line: number; glyph: string; score: number }[] = [];
  perLine.forEach((hits, lineIdx) => {
    let best: { glyph: string; score: number } | null = null;
    for (const hit of hits) {
      const freq = df.get(hit.stem) ?? 1;
      // Rare-in-song wins; a word at the end of the line (the rhyme) wins a little more.
      const idf = Math.log(total / freq);
      const score = idf + hit.pos * 0.35;
      if (!best || score > best.score) best = { glyph: hit.glyph, score };
    }
    if (best && best.score > 0.55) scored.push({ line: lineIdx, glyph: best.glyph, score: best.score });
  });

  scored.sort((a, b) => b.score - a.score);
  const budget = Math.max(1, Math.floor(total * maxDensity));
  const chosen: Record<number, string> = {};
  const taken: number[] = [];
  for (const cand of scored) {
    if (taken.length >= budget) break;
    if (taken.some((t) => Math.abs(t - cand.line) < minGap)) continue;
    chosen[cand.line] = cand.glyph;
    taken.push(cand.line);
  }
  return chosen;
}
