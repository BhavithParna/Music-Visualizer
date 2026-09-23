import type { LyricLine } from '@lyricroom/shared';

export type Tier = 'hero' | 'support' | 'connective';

export interface LaidWord {
  /** Index into the source line's `words`, so motion can be driven by its timing. */
  index: number;
  text: string;
  tier: Tier;
  /** Size multiplier relative to the line's base size. */
  scale: number;
  rotate: number;
  /** Offsets in em, applied on top of flex layout to break the grid. */
  dx: number;
  dy: number;
  invert: boolean;
  glyph?: string;
}

export interface LaidRow {
  words: LaidWord[];
  align: 'left' | 'center' | 'right';
}

export interface LaidLine {
  rows: LaidRow[];
  /** Font size for scale 1.0, in vmin. */
  baseSize: number;
}

const TIER_SCALE: Record<Tier, number> = { hero: 1, support: 0.56, connective: 0.34 };

/** Words that must never be the hero, however long they are held. */
const WEAK = new Set([
  'the','a','an','and','or','but','if','so','as','at','by','for','from','in','into','of','on','to',
  'with','up','down','out','off','over','is','am','are','was','were','be','been','do','does','did',
  'i','me','my','we','us','our','you','your','he','him','his','she','her','it','its','they','them',
  'that','this','these','those','oh','yeah','uh','ah','na','la','ooh','hey',
]);

/** Deterministic hash so a line looks identical every time it plays. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number): () => number {
  let s = seed || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const clean = (t: string): string => t.trim();
const isWeak = (t: string): boolean => WEAK.has(clean(t).toLowerCase().replace(/[^a-z']/g, ''));

/** Rough advance width of a heavy grotesque, in em per character, when no face is given. */
const CHAR_EM = 0.6;

export interface LayoutOptions {
  /** Viewport aspect, used to pick how much horizontal room a row may use. */
  portrait?: boolean;
  glyph?: string;
  /** Set for the rare inverted-box hook word. */
  invert?: boolean;
  /** 0..1, how loud the section is; louder lines get bigger heroes. */
  intensity?: number;
  /**
   * Mean advance per character of each tier's face, in em. A condensed face
   * like League Gothic fits almost twice the letters of Archivo Black, so the
   * first size guess has to know which one it is setting.
   */
  charEm?: Partial<Record<Tier, number>>;
  /** Multiplier on the size ceiling: verse < 1 < chorus. */
  sizeBoost?: number;
  /** Extra seed material, so a repeated chorus line does not re-use one layout. */
  seedSalt?: string;
}

/**
 * Turn a lyric line into a composition.
 *
 * Three rules carry the look:
 *  - exactly one hero word per line, chosen by how long it is *held* relative to
 *    its neighbours, which is what makes a rap line and a ballad line both work;
 *  - rows are packed to a target width in hero-ems, then the whole line is
 *    scaled to fit, so short lines get huge type and long lines stay readable;
 *  - jitter is seeded from the line text, so the same line never re-rolls.
 */
export function layoutLine(line: LyricLine, opts: LayoutOptions = {}): LaidLine {
  const spoken = line.words
    .map((w, index) => ({ w, index }))
    .filter(({ w }) => clean(w.text).length > 0 && !w.glue);

  const source = spoken.length
    ? spoken
    : line.text.split(/\s+/).filter(Boolean).map((text, index) => ({
        w: { text, startMs: line.startMs, endMs: line.endMs },
        index,
      }));

  const durations = source.map(({ w }) => Math.max(1, w.endMs - w.startMs));
  const meanDur = durations.reduce((a, b) => a + b, 0) / Math.max(1, durations.length);

  // Score every token; the winner becomes the hero.
  const scores = source.map(({ w }, i) => {
    const text = clean(w.text);
    const hold = durations[i]! / meanDur;
    const len = Math.min(text.replace(/[^\p{L}\p{N}']/gu, '').length, 10) / 10;
    const rhyme = i === source.length - 1 ? 0.45 : 0;
    const weak = isWeak(text) ? -1.4 : 0;
    return hold * 1.15 + len * 0.7 + rhyme + weak;
  });

  // A weak word must never become the hero, however long it happens to be held.
  // Providers routinely stretch a trailing "a" or "the" across a rest, and
  // blowing that up to 25vmin instantly breaks the look.
  const strong = scores
    .map((s, i) => ({ s, i }))
    .filter(({ i }) => !isWeak(clean(source[i]!.w.text)));
  const pool = strong.length ? strong : scores.map((s, i) => ({ s, i }));
  let heroAt = pool[0]!.i;
  for (const cand of pool) if (cand.s > scores[heroAt]!) heroAt = cand.i;

  // Up to two supports: the next best non-weak tokens, never adjacent to nothing.
  const supportBudget = source.length <= 2 ? 1 : source.length <= 5 ? 2 : 3;
  const supportSet = new Set(
    scores
      .map((s, i) => ({ s, i }))
      .filter(({ i }) => i !== heroAt && !isWeak(clean(source[i]!.w.text)))
      .sort((a, b) => b.s - a.s)
      .slice(0, supportBudget)
      .map(({ i }) => i),
  );

  const charEm = (t: Tier): number => opts.charEm?.[t] ?? CHAR_EM;
  const wordWidth = (w: LaidWord): number => Math.max(1, clean(w.text).length) * charEm(w.tier) * w.scale;
  const seed = hash(line.text + (opts.seedSalt ?? ''));
  const rand = rng(seed);
  const intensity = opts.intensity ?? 0.5;

  const words: LaidWord[] = source.map(({ w, index }, i) => {
    const tier: Tier = i === heroAt ? 'hero' : supportSet.has(i) ? 'support' : 'connective';
    const jitter = rand();
    const word: LaidWord = {
      index,
      text: clean(w.text),
      tier,
      // Loud sections push the hero larger; quiet ones pull it back.
      scale: TIER_SCALE[tier] * (tier === 'hero' ? 0.92 + intensity * 0.22 : 1),
      rotate: 0,
      dx: (jitter - 0.5) * 0.06,
      dy: (rand() - 0.5) * 0.07,
      invert: false,
    };
    return word;
  });

  // At most one word per line is tilted, and never the hero by more than a hair.
  const tiltAt = Math.floor(rand() * words.length);
  const tilt = words[tiltAt];
  if (tilt && words.length > 1) tilt.rotate = (rand() - 0.5) * (tilt.tier === 'hero' ? 2.4 : 6);

  const hero = words[heroAt];
  if (hero) {
    if (opts.invert) hero.invert = true;
    if (opts.glyph) hero.glyph = opts.glyph;
  }

  // ---- row packing -------------------------------------------------------
  // Target width is in hero-ems. Portrait screens get narrower rows, which is
  // what makes a vertical display read as a deliberate "lyric poster".
  const target = opts.portrait ? 3.6 : 5.2;
  const rows: LaidRow[] = [];
  let current: LaidWord[] = [];
  let width = 0;
  for (const word of words) {
    const ww = wordWidth(word);
    if (current.length && width + ww > target) {
      rows.push({ words: current, align: 'left' });
      current = [];
      width = 0;
    }
    current.push(word);
    width += ww;
  }
  if (current.length) rows.push({ words: current, align: 'left' });

  // Alternate alignment down the stack so consecutive rows never twin.
  const aligns: LaidRow['align'][] = ['left', 'center', 'right'];
  rows.forEach((row, i) => {
    row.align = aligns[(seed + i) % 3]!;
  });

  // ---- fit ---------------------------------------------------------------
  const widest = Math.max(...rows.map((r) => r.words.reduce((a, w) => a + wordWidth(w), 0) + (r.words.length - 1) * 0.22), 0.5);
  const totalHeight = rows.reduce((a, r) => a + Math.max(...r.words.map((w) => w.scale)) * 0.94, 0);

  // Available box in vmin, leaving the padding declared in the stylesheet.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const vmin = Math.min(vw, vh) / 100;
  const availW = (vw * 0.84) / vmin;
  const availH = (vh * 0.84) / vmin;

  // A one- or two-word line is the reference look at its most striking, so the
  // ceiling rises as the line gets shorter instead of being a flat cap.
  const ceiling = words.length <= 1 ? 46 : words.length <= 2 ? 40 : words.length <= 4 ? 32 : 27;
  const boost = opts.sizeBoost ?? 1;
  const baseSize = Math.max(
    4,
    Math.min(availW / widest, availH / Math.max(totalHeight, 0.6), (opts.portrait ? ceiling * 1.12 : ceiling) * boost),
  );

  return { rows, baseSize };
}
