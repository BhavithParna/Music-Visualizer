import { XMLParser } from 'fast-xml-parser';
import type { LyricDoc, LyricLine, LyricWord } from '@lyricroom/shared';
import { parseTime } from './time.js';
import { finalizeDoc } from '../normalize.js';

/** preserveOrder node: `{ tag: children[], ':@'?: attrs }` or `{ '#text': string }`. */
type Node = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  preserveOrder: true,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
});

function tagOf(node: Node): string | null {
  for (const k of Object.keys(node)) if (k !== ':@') return k;
  return null;
}
function attrs(node: Node): Record<string, string> {
  return (node[':@'] as Record<string, string> | undefined) ?? {};
}
function childrenOf(node: Node): Node[] {
  const t = tagOf(node);
  if (!t) return [];
  const v = node[t];
  return Array.isArray(v) ? (v as Node[]) : [];
}
function findAll(nodes: Node[], tag: string, out: Node[] = []): Node[] {
  for (const n of nodes) {
    const t = tagOf(n);
    if (t === tag) out.push(n);
    if (t && t !== '#text') findAll(childrenOf(n), tag, out);
  }
  return out;
}

/** Collect the plain text of a subtree, spans included, in document order. */
function textOf(nodes: Node[]): string {
  let s = '';
  for (const n of nodes) {
    const t = tagOf(n);
    if (t === '#text') s += String(n['#text'] ?? '');
    else if (t) s += textOf(childrenOf(n));
  }
  return s;
}

interface Collected {
  words: LyricWord[];
  /** Background-vocal spans become their own line so the renderer can subdue them. */
  background: { words: LyricWord[] }[];
}

function collect(nodes: Node[], into: Collected): void {
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === '#text') {
      const text = String(node['#text'] ?? '');
      if (!text) continue;
      // Whitespace between spans belongs to the word before it, so the karaoke
      // sweep does not stall on a gap with no timing of its own.
      const last = into.words[into.words.length - 1];
      if (last && /^\s+$/.test(text)) last.text += text;
      else if (text.trim()) into.words.push({ text, startMs: -1, endMs: -1, glue: true });
      continue;
    }
    if (tag !== 'span') continue;

    const a = attrs(node);
    const role = a['ttm:role'] ?? a['role'];
    const kids = childrenOf(node);

    if (role === 'x-bg') {
      const nested: Collected = { words: [], background: [] };
      collect(kids, nested);
      if (nested.words.length) into.background.push({ words: nested.words });
      continue;
    }
    // Roles like x-translation / x-roman are alternate renderings, not sung words.
    if (role === 'x-translation' || role === 'x-roman') continue;

    const begin = parseTime(a['begin']);
    const end = parseTime(a['end']);
    const hasKids = kids.some((k) => tagOf(k) === 'span');

    if (hasKids) {
      collect(kids, into);
      continue;
    }
    const text = textOf(kids);
    if (!text) continue;
    if (begin == null || end == null) {
      const last = into.words[into.words.length - 1];
      if (last) last.text += text;
      else into.words.push({ text, startMs: -1, endMs: -1, glue: true });
      continue;
    }
    into.words.push({ text, startMs: begin, endMs: Math.max(end, begin) });
  }
}

export interface TtmlParseResult {
  lines: LyricLine[];
  hasWordTiming: boolean;
}

export function parseTtmlLines(xml: string): TtmlParseResult {
  const tree = parser.parse(xml) as Node[];
  const ps = findAll(tree, 'p');
  const lines: LyricLine[] = [];
  let hasWordTiming = false;

  for (const p of ps) {
    const a = attrs(p);
    const begin = parseTime(a['begin']);
    const end = parseTime(a['end']);
    const kids = childrenOf(p);

    const collected: Collected = { words: [], background: [] };
    collect(kids, collected);

    const timed = collected.words.filter((w) => w.startMs >= 0);
    if (timed.length) hasWordTiming = true;

    const rawText = collected.words.length ? collected.words.map((w) => w.text).join('') : textOf(kids);
    const text = rawText.replace(/\s+/g, ' ').trim();

    const lineStart = begin ?? (timed[0]?.startMs ?? null);
    const lineEnd = end ?? (timed[timed.length - 1]?.endMs ?? null);
    if (lineStart == null || lineEnd == null) continue;
    if (!text && collected.background.length === 0) continue;

    const line: LyricLine = {
      text,
      startMs: lineStart,
      endMs: Math.max(lineEnd, lineStart),
      words: collected.words,
    };
    const agent = a['ttm:agent'] ?? a['agent'];
    if (agent) line.agent = agent;
    if (text) lines.push(line);

    for (const bg of collected.background) {
      const bgTimed = bg.words.filter((w) => w.startMs >= 0);
      const bgText = bg.words.map((w) => w.text).join('').replace(/\s+/g, ' ').trim();
      if (!bgText || !bgTimed.length) continue;
      const bgLine: LyricLine = {
        text: bgText,
        startMs: bgTimed[0]!.startMs,
        endMs: bgTimed[bgTimed.length - 1]!.endMs,
        words: bg.words,
        background: true,
      };
      if (agent) bgLine.agent = agent;
      lines.push(bgLine);
    }
  }

  lines.sort((a, b) => a.startMs - b.startMs);
  return { lines, hasWordTiming };
}

export function parseTtml(
  xml: string,
  meta: { trackKey: string; provider: string; tier: number; confidence?: number },
): LyricDoc | null {
  const { lines, hasWordTiming } = parseTtmlLines(xml);
  if (!lines.length) return null;
  return finalizeDoc({
    trackKey: meta.trackKey,
    provider: meta.provider,
    tier: meta.tier,
    level: hasWordTiming ? 'word' : 'line',
    lines,
    confidence: meta.confidence ?? (hasWordTiming ? 0.95 : 0.7),
  });
}
