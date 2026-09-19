import type { LyricDoc, LyricLine, LyricWord } from '@lyricroom/shared';
import { LYRICSPLUS_BASES } from '../../config.js';
import { fetchJson, qs } from '../http.js';
import { queryVariants } from '../title.js';
import { finalizeDoc } from '../normalize.js';
import type { Provider, ProviderContext } from './types.js';

interface KpoeSyllable { time: number; duration: number; text: string; isLineEnding?: number | boolean }
interface KpoeLine {
  time: number;
  duration: number;
  text: string;
  syllabus?: KpoeSyllable[];
  element?: { key?: string; singer?: string; songPartIndex?: number; isBackground?: boolean };
}
interface KpoeResponse {
  type?: string;
  lyrics?: KpoeLine[];
  metadata?: { source?: string; songParts?: string[] };
  error?: string;
}

/** Remember which instance answered last so we do not re-pay for dead hosts. */
let preferredBase = 0;

function toLines(data: KpoeResponse, parts: string[] | undefined): LyricLine[] {
  const out: LyricLine[] = [];
  for (const raw of data.lyrics ?? []) {
    const text = (raw.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const startMs = raw.time;
    const endMs = raw.time + (raw.duration || 0);
    const words: LyricWord[] = [];
    for (const syl of raw.syllabus ?? []) {
      if (!syl.text) continue;
      words.push({
        text: syl.text,
        startMs: syl.time,
        endMs: syl.time + Math.max(syl.duration || 0, 1),
      });
    }
    const line: LyricLine = { text, startMs, endMs, words };
    const singer = raw.element?.singer;
    if (singer) line.agent = singer;
    if (raw.element?.isBackground) line.background = true;
    const partIdx = raw.element?.songPartIndex;
    if (parts && typeof partIdx === 'number' && parts[partIdx]) line.part = parts[partIdx];
    out.push(line);
  }
  return out;
}

/**
 * Tier 3: LyricsPlus / KPoe, an open reimplementation that proxies Apple Music's
 * TTML. This is the workhorse for mainstream Western catalogue -- it returns real
 * per-syllable timings plus duet agents and song-part labels.
 *
 * Public instances churn constantly (429 / 402 / gone), so we rotate through a
 * configurable list and stick to whichever answered last.
 */
export const lyricsPlusProvider: Provider = {
  name: 'lyricsplus',
  tier: 3,
  async resolve({ track }: ProviderContext): Promise<LyricDoc | null> {
    if (!track.title) return null;
    const durationSec = Math.round(track.durationMs / 1000) || undefined;

    // A raw player title such as "Song (feat. X)" is not how lyric databases
    // index the track, so each simplified variant gets its own attempt.
    for (const variant of queryVariants(track.title, track.artist, track.album)) {
      const query = qs({ ...variant, duration: durationSec });

      for (let i = 0; i < LYRICSPLUS_BASES.length; i += 1) {
        const idx = (preferredBase + i) % LYRICSPLUS_BASES.length;
        const base = LYRICSPLUS_BASES[idx]!;
        let data: KpoeResponse;
        try {
          data = await fetchJson<KpoeResponse>(`${base}/v2/lyrics/get?${query}`);
        } catch {
          continue; // instance down or rate limited: try the next one
        }
        // The instance answered, so it is healthy even if this title missed.
        preferredBase = idx;
        if (data.error || !data.lyrics?.length) break;
        const lines = toLines(data, data.metadata?.songParts);
        if (!lines.length) break;

        const isWord = (data.type ?? '').toLowerCase() === 'word'
          || lines.some((l) => l.words.length > 1);
        return finalizeDoc({
          trackKey: track.trackKey,
          provider: `lyricsplus:${data.metadata?.source ?? 'unknown'}`,
          tier: 3,
          level: isWord ? 'word' : 'line',
          lines,
          confidence: isWord ? 0.93 : 0.7,
          wordsInterpolated: !isWord,
        });
      }
    }
    return null;
  },
};
