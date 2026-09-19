import type { LyricLine, LyricWord } from '@lyricroom/shared';

/**
 * A phrase is what the screen actually holds at one moment: a couple of words,
 * not a whole line.
 *
 * The reference look never shows a full lyric line. It shows two or three words
 * enormous, then cuts to the next two or three. Rendering a whole line at once
 * is what makes a long rap bar overflow the frame and read as a subtitle rather
 * than as a composition.
 */
export interface Phrase extends LyricLine {
  /** Index of the source line, so glyph and invert decisions stay per line. */
  lineIndex: number;
  phraseIndex: number;
  /** True for the phrase that carries the line's hero/glyph treatment. */
  carriesGlyph: boolean;
}

const MAX_WORDS = 4;
/** A silence this long inside a line is a natural cut point. */
const GAP_MS = 320;
/** Long words earn their own breathing room, so a phrase of them stays short. */
const LONG_CHARS = 7;

/**
 * How long before the next phrase lands the current one must be gone.
 *
 * A phrase is spawned ahead of its first word so it can rise into place, so
 * without this the outgoing phrase is still at full strength when the incoming
 * one has finished arriving, and the screen holds two whole compositions at
 * once. The cut has to read as a cut.
 */
const HANDOFF_MS = 150;
/** Never clamp a phrase to less than this; a flash is worse than an overlap. */
const MIN_HOLD_MS = 160;

const clean = (t: string): string => t.trim();

function shouldBreak(acc: LyricWord[], next: LyricWord): boolean {
  if (acc.length === 0) return false;
  if (acc.length >= MAX_WORDS) return true;

  const prev = acc[acc.length - 1]!;
  if (next.startMs - prev.endMs > GAP_MS) return true;

  const chars = acc.reduce((a, w) => a + clean(w.text).length, 0) + clean(next.text).length;
  // Roughly the ink a frame can hold before the type has to shrink to fit.
  if (chars > 22) return true;
  if (acc.length >= 2 && clean(next.text).length >= LONG_CHARS) return true;
  return false;
}

/**
 * Split one lyric line into the phrases the screen will show in turn.
 * Each phrase is a standalone line with its own re-indexed words, so the layout
 * engine and the renderer need no knowledge that splitting happened.
 */
export function splitIntoPhrases(line: LyricLine, lineIndex: number): Phrase[] {
  const words = line.words.filter((w) => clean(w.text).length > 0);
  if (words.length === 0) {
    return [{
      ...line,
      words: [],
      lineIndex,
      phraseIndex: 0,
      carriesGlyph: true,
    }];
  }

  const groups: LyricWord[][] = [];
  let acc: LyricWord[] = [];
  for (const word of words) {
    if (shouldBreak(acc, word)) {
      groups.push(acc);
      acc = [];
    }
    acc.push(word);
  }
  if (acc.length) groups.push(acc);

  // The glyph belongs on the phrase holding the line's longest-held word,
  // which is where the hero will land.
  let glyphGroup = 0;
  let bestHold = -1;
  groups.forEach((group, i) => {
    const hold = Math.max(...group.map((w) => w.endMs - w.startMs));
    if (hold > bestHold) {
      bestHold = hold;
      glyphGroup = i;
    }
  });

  return groups.map((group, i) => {
    const startMs = group[0]!.startMs;
    const endMs = Math.max(group[group.length - 1]!.endMs, startMs + 180);
    const phrase: Phrase = {
      text: group.map((w) => clean(w.text)).join(' '),
      startMs,
      // Hold the last phrase of a line until the line itself is over, so a
      // trailing rest does not leave the screen empty mid-bar.
      endMs: i === groups.length - 1 ? Math.max(endMs, Math.min(line.endMs, endMs + 600)) : endMs,
      words: group.map((w) => ({ ...w })),
      lineIndex,
      phraseIndex: i,
      carriesGlyph: i === glyphGroup,
    };
    if (line.agent) phrase.agent = line.agent;
    if (line.background) phrase.background = true;
    if (line.part) phrase.part = line.part;
    return phrase;
  });
}

/**
 * The whole document as the sequence of phrases the screen will show.
 *
 * Splitting is per line, but the handoff is not: a phrase has to be told to
 * leave by whatever comes next, including the first phrase of the next line.
 */
export function buildPhrases(lines: LyricLine[]): Phrase[] {
  const all = lines.flatMap((line, i) => splitIntoPhrases(line, i));
  for (let i = 0; i < all.length - 1; i += 1) {
    const cur = all[i]!;
    const latest = all[i + 1]!.startMs - HANDOFF_MS;
    if (cur.endMs > latest) cur.endMs = Math.max(cur.startMs + MIN_HOLD_MS, latest);
  }
  return all;
}
