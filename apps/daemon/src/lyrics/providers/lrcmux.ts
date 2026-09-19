import type { LyricDoc, LyricLine, LyricWord } from '@lyricroom/shared';
import { ALLOW_KUGOU, LRCMUX_BASE } from '../../config.js';
import { fetchText, qs } from '../http.js';
import { finalizeDoc } from '../normalize.js';
import { parseLrc } from '../parse/lrc.js';
import { queryVariants } from '../title.js';
import type { Provider, ProviderContext } from './types.js';

interface MuxWord { text: string; start: number; end: number }
interface MuxLine { text: string; start: number; end: number; words?: MuxWord[] }
type MuxPayload = MuxLine[] | { lines?: MuxLine[]; lyrics?: MuxLine[] };

function extractLines(payload: MuxPayload): MuxLine[] {
  if (Array.isArray(payload)) return payload;
  return payload.lines ?? payload.lyrics ?? [];
}

/**
 * Tier 4: lrcmux, an aggregator in front of several lyric sources.
 *
 * KuGou is excluded by default: its word timings are machine-transcribed and a
 * measured lower quartile of word accuracy means whole songs of confidently
 * timed *wrong words*. A correct line-level result beats that every time.
 * Set LYRICROOM_ALLOW_KUGOU=1 to opt back in.
 */
export const lrcmuxProvider: Provider = {
  name: 'lrcmux',
  tier: 4,
  async resolve({ track }: ProviderContext): Promise<LyricDoc | null> {
    if (!track.title) return null;
    const sources = ALLOW_KUGOU ? undefined : '!kugou';
    const durationSec = Math.round(track.durationMs / 1000) || undefined;

    // The player's raw title is not how the aggregator indexes the track, so
    // each simplified variant gets the full word -> line ladder of its own.
    for (const variant of queryVariants(track.title, track.artist, track.album)) {
      const common = { ...variant, duration: durationSec };

      for (const attempt of [
        { level: 'word', strict: 'true' },
        { level: 'word', strict: 'false' },
        { level: 'line', strict: 'false' },
      ] as const) {
        const url = `${LRCMUX_BASE}/get?${qs({ ...common, ...attempt, sources, format: 'json' })}`;
        let body: string;
        try {
          body = await fetchText(url);
        } catch {
          continue;
        }
        let payload: MuxPayload;
        try {
          payload = JSON.parse(body) as MuxPayload;
        } catch {
          // Some deployments answer `format=json` with LRC text.
          const doc = parseLrc(body, { trackKey: track.trackKey, provider: 'lrcmux', tier: 4 });
          if (doc) return doc;
          continue;
        }
        const raw = extractLines(payload);
        if (!raw.length) continue;

        const lines: LyricLine[] = [];
        let sawWords = false;
        for (const l of raw) {
          const text = (l.text ?? '').replace(/\s+/g, ' ').trim();
          if (!text) continue;
          const words: LyricWord[] = (l.words ?? []).map((w) => ({
            text: w.text,
            startMs: w.start,
            endMs: w.end,
          }));
          if (words.length > 1) sawWords = true;
          lines.push({ text, startMs: l.start, endMs: l.end, words });
        }
        if (!lines.length) continue;
        return finalizeDoc({
          trackKey: track.trackKey,
          provider: 'lrcmux',
          tier: 4,
          level: sawWords ? 'word' : 'line',
          lines,
          confidence: sawWords ? 0.8 : 0.65,
          wordsInterpolated: !sawWords,
        });
      }
    }
    return null;
  },
};
