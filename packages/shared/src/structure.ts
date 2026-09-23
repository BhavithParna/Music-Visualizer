import type { LyricLine, Section, SectionKind } from './types.js';

/**
 * Song structure from lyrics alone.
 *
 * TTML documents often carry part labels (verse, chorus, bridge), and when
 * they do they are the truth. Everything else falls back to repetition: a
 * chorus is the block of lines that comes back. That is crude, but it is what
 * a listener hears too -- the part you already know the words to.
 */

const norm = (t: string): string =>
  t.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, '').replace(/\s+/g, ' ').trim();

function kindFromLabel(label: string): SectionKind {
  const l = label.toLowerCase();
  if (/chorus|hook|refrain/.test(l)) return 'chorus';
  if (/bridge|breakdown/.test(l)) return 'bridge';
  if (/intro/.test(l)) return 'intro';
  if (/outro|coda/.test(l)) return 'outro';
  return 'verse';
}

interface Block {
  kind: SectionKind;
  from: number;
  to: number;
}

/**
 * A line's part label. Typed as a string, but documents cached before the
 * LyricsPlus fix carry `{ name, time, duration }` objects, so read both.
 */
function partOf(line: LyricLine | undefined): string | undefined {
  const p = line?.part as unknown;
  if (typeof p === 'string') return p || undefined;
  if (p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string') {
    return (p as { name: string }).name || undefined;
  }
  return undefined;
}

/** Identity of a part: two verses in a row share a name but not a start time. */
function partKey(line: LyricLine | undefined): string | undefined {
  const p = line?.part as unknown;
  if (p && typeof p === 'object') return `${partOf(line)}@${String((p as { time?: unknown }).time ?? '')}`;
  return partOf(line);
}

function blocksFromLabels(lines: LyricLine[]): Block[] | null {
  if (!lines.some((l) => partOf(l))) return null;
  const blocks: Block[] = [];
  let label = partOf(lines[0]) ?? 'verse';
  let key = partKey(lines[0]) ?? label;
  let from = 0;
  for (let i = 1; i <= lines.length; i += 1) {
    const nextKey = i < lines.length ? (partKey(lines[i]) ?? key) : null;
    if (nextKey !== key) {
      blocks.push({ kind: kindFromLabel(label), from, to: i });
      if (nextKey !== null) {
        key = nextKey;
        label = partOf(lines[i]) ?? label;
        from = i;
      }
    }
  }
  return blocks;
}

/** One-word lines that repeat because they are filler, not because they are a hook. */
const FILLER = new Set(['yeah', 'oh', 'ooh', 'uh', 'ah', 'hey', 'na', 'la', 'woah', 'whoa', 'mm', 'mmm', 'yo', 'huh']);

function blocksFromRepetition(lines: LyricLine[]): Block[] {
  const keys = lines.map((l) => norm(l.text));
  const count = new Map<string, number>();
  for (const [i, k] of keys.entries()) {
    if (lines[i]!.background) continue;
    const words = k.split(' ').filter(Boolean);
    // A one-word line can be a hook ("Run"), but not a filler word.
    if (words.length >= 2 || (words.length === 1 && words[0]!.length >= 3 && !FILLER.has(words[0]!))) {
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  const hooky: boolean[] = [];
  keys.forEach((k, i) => {
    // Background vocals ride along with whatever section they sit in.
    hooky.push(lines[i]!.background ? (hooky[i - 1] ?? false) : (count.get(k) ?? 0) >= 2);
  });

  // Runs of repeated lines. A single repeated line inside a verse is a
  // callback, not a chorus; it takes two in a row to make a section.
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const h = hooky[i]!;
    let j = i + 1;
    while (j < lines.length && hooky[j] === h) j += 1;
    blocks.push({ kind: h && j - i >= 2 ? 'chorus' : 'verse', from: i, to: j });
    i = j;
  }

  // A lone line of verse wedged between two chorus blocks is part of the
  // chorus (an ad-lib, a variation), and adjacent blocks of the same kind merge.
  for (let b = 1; b < blocks.length - 1; b += 1) {
    const cur = blocks[b]!;
    if (cur.kind === 'verse' && cur.to - cur.from === 1 &&
        blocks[b - 1]!.kind === 'chorus' && blocks[b + 1]!.kind === 'chorus') {
      cur.kind = 'chorus';
    }
  }
  const merged: Block[] = [];
  for (const b of blocks) {
    const last = merged[merged.length - 1];
    if (last && last.kind === b.kind) last.to = b.to;
    else merged.push({ ...b });
  }

  // A verse that sits after the second chorus and before a later one is the
  // bridge: it is new material late in the song, which is what a bridge is.
  const choruses = merged.map((b, k) => (b.kind === 'chorus' ? k : -1)).filter((k) => k >= 0);
  if (choruses.length >= 3) {
    for (let k = choruses[1]! + 1; k < choruses[choruses.length - 1]!; k += 1) {
      if (merged[k]!.kind === 'verse') merged[k]!.kind = 'bridge';
    }
  }
  return merged;
}

/**
 * Split a document into sections and say which section each line belongs to.
 *
 * `lineArousal` (0..1 per line) sharpens the energy estimate; without it
 * energy comes from density alone.
 */
export function detectSections(
  lines: LyricLine[],
  lineArousal: number[] = [],
): { sections: Section[]; lineSection: number[] } {
  if (!lines.length) return { sections: [], lineSection: [] };
  const blocks = blocksFromLabels(lines) ?? blocksFromRepetition(lines);

  const raw = blocks.map((b) => {
    const ls = lines.slice(b.from, b.to);
    const startMs = ls[0]!.startMs;
    const endMs = Math.max(ls[ls.length - 1]!.endMs, startMs + 1);
    const words = ls.reduce((a, l) => a + Math.max(1, l.words.length), 0);
    const sungMs = ls.reduce((a, l) => a + Math.max(250, l.endMs - l.startMs), 0);
    const density = words / (sungMs / 1000);
    const ar = lineArousal.slice(b.from, b.to);
    const arousal = ar.length ? ar.reduce((a, v) => a + v, 0) / ar.length : 0.5;
    // Choruses are the loud part of almost every song; the kind itself is
    // evidence, not only the words per second.
    const bias = b.kind === 'chorus' ? 1.25 : b.kind === 'bridge' ? 0.9 : 1;
    return { b, startMs, endMs, score: density * (0.5 + arousal) * bias };
  });
  const top = Math.max(...raw.map((r) => r.score), 1e-6);

  const seen = new Map<SectionKind, number>();
  const sections: Section[] = raw.map((r, k) => {
    const occurrence = seen.get(r.b.kind) ?? 0;
    seen.set(r.b.kind, occurrence + 1);
    const next = raw[k + 1];
    return {
      kind: r.b.kind,
      startMs: r.startMs,
      // A section owns the time up to the next one, so the gap before a
      // chorus belongs to the verse leading into it.
      endMs: next ? next.startMs : r.endMs,
      fromLine: r.b.from,
      toLine: r.b.to,
      energy: Math.max(0, Math.min(1, r.score / top)),
      occurrence,
    };
  });

  const lineSection = new Array<number>(lines.length).fill(0);
  sections.forEach((s, k) => {
    for (let i = s.fromLine; i < s.toLine; i += 1) lineSection[i] = k;
  });
  return { sections, lineSection };
}

/** The section at a playback position, or -1 before the first one. */
export function sectionAt(sections: Section[], posMs: number): number {
  let lo = 0;
  let hi = sections.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sections[mid]!.startMs <= posMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}
