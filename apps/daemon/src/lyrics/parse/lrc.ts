import type { LyricDoc, LyricLine, LyricWord } from '@lyricroom/shared';
import { parseTime } from './time.js';
import { finalizeDoc } from '../normalize.js';

const LINE_TAG = /\[(\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?)\]/g;
/** Enhanced-LRC word tag: `<mm:ss.xx>` between words. */
const WORD_TAG = /<(\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?)>/g;

export interface LrcParseResult {
  lines: LyricLine[];
  hasWordTiming: boolean;
  offsetMs: number;
}

export function parseLrcLines(text: string): LrcParseResult {
  const out: LyricLine[] = [];
  let offsetMs = 0;
  let hasWordTiming = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const offsetTag = /^\s*\[offset:\s*([+-]?\d+)\s*\]/i.exec(rawLine);
    if (offsetTag) {
      offsetMs = Number(offsetTag[1]);
      continue;
    }
    LINE_TAG.lastIndex = 0;
    const stamps: number[] = [];
    let m: RegExpExecArray | null;
    let lastIdx = 0;
    while ((m = LINE_TAG.exec(rawLine)) !== null) {
      // Only leading timestamps belong to the line; a later one is content.
      if (m.index !== lastIdx) break;
      const t = parseTime(m[1]);
      if (t == null) break;
      stamps.push(t);
      lastIdx = m.index + m[0].length;
    }
    if (!stamps.length) continue;

    const body = rawLine.slice(lastIdx);
    const words: LyricWord[] = [];
    WORD_TAG.lastIndex = 0;
    const segments: { t: number; text: string }[] = [];
    let cursor = 0;
    let pending: number | null = null;
    let wm: RegExpExecArray | null;
    while ((wm = WORD_TAG.exec(body)) !== null) {
      const chunk = body.slice(cursor, wm.index);
      if (pending != null) segments.push({ t: pending, text: chunk });
      else if (chunk.trim()) segments.push({ t: stamps[0]!, text: chunk });
      pending = parseTime(wm[1]) ?? null;
      cursor = wm.index + wm[0].length;
    }
    const tailText = body.slice(cursor);
    if (pending != null) segments.push({ t: pending, text: tailText });
    else if (!segments.length && tailText.trim()) segments.push({ t: stamps[0]!, text: tailText });
    else if (tailText.trim()) segments.push({ t: stamps[0]!, text: tailText });

    const plain = body.replace(WORD_TAG, '').replace(/\s+/g, ' ').trim();
    if (!plain) continue;

    if (segments.length > 1) {
      hasWordTiming = true;
      for (let i = 0; i < segments.length; i += 1) {
        const seg = segments[i]!;
        if (!seg.text.trim()) {
          const prev = words[words.length - 1];
          if (prev) prev.text += seg.text;
          continue;
        }
        const end = segments[i + 1]?.t ?? seg.t + 400;
        words.push({ text: seg.text, startMs: seg.t, endMs: end });
      }
    }

    for (const start of stamps) {
      const shifted = words.map((w) => ({
        ...w,
        startMs: w.startMs - stamps[0]! + start,
        endMs: w.endMs - stamps[0]! + start,
      }));
      out.push({
        text: plain,
        startMs: start,
        endMs: shifted[shifted.length - 1]?.endMs ?? start,
        words: shifted,
      });
    }
  }

  out.sort((a, b) => a.startMs - b.startMs);
  return { lines: out, hasWordTiming, offsetMs };
}

export function parseLrc(
  text: string,
  meta: { trackKey: string; provider: string; tier: number; confidence?: number },
): LyricDoc | null {
  const { lines, hasWordTiming, offsetMs } = parseLrcLines(text);
  if (!lines.length) return null;
  if (offsetMs) {
    for (const l of lines) {
      l.startMs -= offsetMs;
      l.endMs -= offsetMs;
      for (const w of l.words) {
        w.startMs -= offsetMs;
        w.endMs -= offsetMs;
      }
    }
  }
  return finalizeDoc({
    trackKey: meta.trackKey,
    provider: meta.provider,
    tier: meta.tier,
    level: hasWordTiming ? 'word' : 'line',
    lines,
    confidence: meta.confidence ?? (hasWordTiming ? 0.85 : 0.65),
    wordsInterpolated: !hasWordTiming,
  });
}
