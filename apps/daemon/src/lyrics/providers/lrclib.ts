import type { LyricDoc } from '@lyricroom/shared';
import { LRCLIB_BASE } from '../../config.js';
import { fetchJson, qs } from '../http.js';
import { finalizeDoc } from '../normalize.js';
import { parseLrc } from '../parse/lrc.js';
import { primaryArtist, simplifyTitle as simplify } from '../title.js';
import type { Provider, ProviderContext } from './types.js';

interface LrclibRecord {
  id: number;
  trackName: string;
  artistName: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

function score(rec: LrclibRecord, track: ProviderContext['track']): number {
  let s = 0;
  const durSec = track.durationMs / 1000;
  if (rec.duration && durSec) {
    const diff = Math.abs(rec.duration - durSec);
    if (diff > 5) return -1; // wrong edit of the song
    s += 5 - diff;
  }
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (norm(rec.trackName) === norm(track.title)) s += 4;
  if (norm(rec.artistName) === norm(track.artist)) s += 4;
  if (rec.syncedLyrics) s += 6;
  return s;
}

function build(rec: LrclibRecord, track: ProviderContext['track']): LyricDoc | null {
  if (rec.instrumental) return null;
  if (rec.syncedLyrics) {
    const doc = parseLrc(rec.syncedLyrics, {
      trackKey: track.trackKey,
      provider: 'lrclib',
      tier: 5,
      confidence: 0.7,
    });
    if (doc) return doc;
  }
  if (rec.plainLyrics?.trim()) {
    // Unsynced text still beats a blank screen: the renderer shows it as a still card.
    return finalizeDoc({
      trackKey: track.trackKey,
      provider: 'lrclib',
      tier: 5,
      level: 'unsynced',
      lines: rec.plainLyrics
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l, i) => ({ text: l, startMs: i * 3000, endMs: i * 3000 + 3000, words: [] })),
      confidence: 0.2,
      wordsInterpolated: true,
    });
  }
  return null;
}

/**
 * Tier 5: LRCLIB. Open, key-less, community-owned and by far the broadest
 * coverage, but line-level in practice -- word timings are distributed by the
 * normaliser rather than supplied. This is the safety net that stops the
 * display going blank.
 */
export const lrclibProvider: Provider = {
  name: 'lrclib',
  tier: 5,
  async resolve({ track }: ProviderContext): Promise<LyricDoc | null> {
    const durSec = Math.round(track.durationMs / 1000);
    const attempts: Record<string, string | number | undefined>[] = [
      { artist_name: track.artist, track_name: track.title, album_name: track.album, duration: durSec || undefined },
      { artist_name: track.artist, track_name: track.title, duration: durSec || undefined },
      { artist_name: track.artist, track_name: simplify(track.title) },
      { artist_name: primaryArtist(track.artist), track_name: simplify(track.title) },
    ];

    for (const params of attempts) {
      try {
        const rec = await fetchJson<LrclibRecord>(`${LRCLIB_BASE}/api/get?${qs(params)}`);
        const doc = build(rec, track);
        if (doc) return doc;
      } catch {
        /* 404 is the normal miss here */
      }
    }

    try {
      const results = await fetchJson<LrclibRecord[]>(
        `${LRCLIB_BASE}/api/search?${qs({ artist_name: track.artist, track_name: simplify(track.title) })}`,
      );
      const ranked = results
        .map((r) => ({ r, s: score(r, track) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s);
      for (const { r } of ranked.slice(0, 3)) {
        const doc = build(r, track);
        if (doc) return doc;
      }
    } catch {
      /* search unavailable */
    }
    return null;
  },
};
