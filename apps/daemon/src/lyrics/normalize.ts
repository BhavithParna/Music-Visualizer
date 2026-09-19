import type { LyricDoc, LyricLine, LyricWord, SyncLevel } from '@lyricroom/shared';

/** Minimum on-screen time for a word, so very fast rap lines stay readable. */
const MIN_WORD_MS = 90;

/**
 * Split a line into word timings when only the line is timed.
 * Duration is shared proportionally to each token's character count, which tracks
 * how long a word takes to sing far better than an equal split does.
 */
export function distributeWords(text: string, startMs: number, endMs: number): LyricWord[] {
  const tokens = text.split(/(\s+)/).filter((t) => t.length > 0);
  const spoken = tokens.filter((t) => !/^\s+$/.test(t));
  if (spoken.length === 0) return [];

  const weights = spoken.map((t) => Math.max(1, t.replace(/[^\p{L}\p{N}']/gu, '').length || 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const span = Math.max(endMs - startMs, spoken.length * MIN_WORD_MS);

  const words: LyricWord[] = [];
  let cursor = startMs;
  let wi = 0;
  for (const token of tokens) {
    if (/^\s+$/.test(token)) {
      const last = words[words.length - 1];
      if (last) last.text += token;
      continue;
    }
    const w = weights[wi] ?? 1;
    wi += 1;
    const dur = (w / total) * span;
    words.push({ text: token, startMs: cursor, endMs: cursor + dur });
    cursor += dur;
  }
  const last = words[words.length - 1];
  if (last) last.endMs = Math.max(last.endMs, endMs);
  return words;
}

/**
 * Fold untimed glue tokens into their neighbours and guarantee monotonic,
 * non-overlapping word timings inside a line.
 */
function repairWords(line: LyricLine): LyricWord[] {
  const raw = line.words.filter((w) => w.text.length > 0);
  if (raw.length === 0) return [];

  const merged: LyricWord[] = [];
  for (const w of raw) {
    if (w.startMs < 0) {
      const prev = merged[merged.length - 1];
      if (prev) prev.text += w.text;
      else merged.push({ ...w, startMs: line.startMs, endMs: line.startMs });
      continue;
    }
    merged.push({ ...w });
  }
  if (merged.length === 0) return [];

  // Any leading placeholder inherits the first real timing.
  let cursor = line.startMs;
  for (const w of merged) {
    if (w.startMs < cursor) w.startMs = cursor;
    if (w.endMs <= w.startMs) w.endMs = w.startMs + MIN_WORD_MS;
    cursor = w.startMs;
  }
  for (let i = 0; i < merged.length - 1; i += 1) {
    const cur = merged[i]!;
    const next = merged[i + 1]!;
    if (cur.endMs > next.startMs) cur.endMs = next.startMs;
    if (cur.endMs <= cur.startMs) cur.endMs = cur.startMs + 1;
  }
  const tail = merged[merged.length - 1]!;
  if (tail.endMs < line.endMs) tail.endMs = line.endMs;
  return merged;
}

export interface FinalizeInput {
  trackKey: string;
  provider: string;
  tier: number;
  level: SyncLevel;
  lines: LyricLine[];
  confidence: number;
  wordsInterpolated?: boolean;
}

/**
 * Normalise a provider's output into the shape the renderer relies on:
 * sorted lines, sane line ends, and every line carrying word timings.
 */
export function finalizeDoc(input: FinalizeInput): LyricDoc {
  const lines = input.lines
    .filter((l) => l.text.trim().length > 0)
    .map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() }))
    .sort((a, b) => a.startMs - b.startMs || (a.background ? 1 : 0) - (b.background ? 1 : 0));

  let interpolated = input.wordsInterpolated ?? false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    // A missing or absurd end time becomes "until the next line starts".
    const next = lines.find((l, j) => j > i && !l.background && l.startMs > line.startMs);
    if (!Number.isFinite(line.endMs) || line.endMs <= line.startMs) {
      line.endMs = next ? next.startMs : line.startMs + 4000;
    }
    if (next && line.endMs > next.startMs + 1) {
      // Overlapping lines are normal for duets; only trim same-voice overlap.
      if (!line.background && !next.background && line.agent === next.agent) {
        line.endMs = next.startMs;
      }
    }

    const repaired = repairWords(line);
    if (repaired.length && repaired.some((w) => w.endMs > w.startMs)) {
      line.words = repaired;
    } else {
      line.words = distributeWords(line.text, line.startMs, line.endMs);
      interpolated = true;
    }
  }

  return {
    trackKey: input.trackKey,
    level: input.level,
    provider: input.provider,
    tier: input.tier,
    lines,
    confidence: input.confidence,
    fetchedAt: Date.now(),
    wordsInterpolated: interpolated,
  };
}

/**
 * Sanity filter borrowed from terminal-lyrics: a document whose last line starts
 * well past the end of the track is timed against a different master (a remix,
 * an extended edit) and is worse than no sync at all.
 */
export function plausibleForDuration(doc: LyricDoc, durationMs: number, slackMs = 15_000): boolean {
  if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) return true;
  const last = doc.lines[doc.lines.length - 1];
  if (!last) return false;
  return last.startMs <= durationMs + slackMs;
}
