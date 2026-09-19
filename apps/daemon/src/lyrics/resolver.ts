import type { LyricDoc, NowPlaying } from '@lyricroom/shared';
import { readCache, writeCache, forget } from './cache.js';
import { plausibleForDuration } from './normalize.js';
import { sidecarProvider } from './providers/sidecar.js';
import { amllProvider } from './providers/amll.js';
import { lyricsPlusProvider } from './providers/lyricsplus.js';
import { lrcmuxProvider } from './providers/lrcmux.js';
import { lrclibProvider } from './providers/lrclib.js';
import type { Provider } from './providers/types.js';

export const PROVIDERS: Provider[] = [
  sidecarProvider,
  amllProvider,
  lyricsPlusProvider,
  lrcmuxProvider,
  lrclibProvider,
];

export interface ResolveOptions {
  /** Ignore the cache and re-run the cascade. */
  force?: boolean;
  /** Provider names to skip, used by "try the next source" on the remote. */
  skip?: Set<string>;
  onProgress?: (providerName: string, outcome: 'hit' | 'miss' | 'error') => void;
}

/**
 * Walk the provider cascade and return the best document available.
 *
 * Stops as soon as a word-level result lands, because nothing later can improve
 * on it. Keeps the best line-level result as a running fallback so a miss at the
 * top of the cascade never costs us the safety net at the bottom.
 */
export async function resolveLyrics(
  track: NowPlaying,
  opts: ResolveOptions = {},
): Promise<LyricDoc | null> {
  if (!opts.force && !opts.skip?.size) {
    const cached = await readCache(track.trackKey);
    if (cached) return cached.doc;
  }
  if (opts.force) forget(track.trackKey);

  let best: LyricDoc | null = null;

  for (const provider of PROVIDERS) {
    if (opts.skip?.has(provider.name)) continue;
    let doc: LyricDoc | null = null;
    try {
      doc = await provider.resolve({ track, ...(opts.skip ? { skip: opts.skip } : {}) });
    } catch {
      opts.onProgress?.(provider.name, 'error');
      continue;
    }
    if (!doc || doc.lines.length === 0) {
      opts.onProgress?.(provider.name, 'miss');
      continue;
    }
    // A document timed against a different edit of the song is worse than none.
    if (!plausibleForDuration(doc, track.durationMs)) {
      opts.onProgress?.(provider.name, 'miss');
      continue;
    }
    opts.onProgress?.(provider.name, 'hit');

    if (doc.level === 'word') {
      await writeCache(track.trackKey, doc);
      return doc;
    }
    if (!best || rank(doc) > rank(best)) best = doc;
  }

  await writeCache(track.trackKey, best);
  return best;
}

function rank(doc: LyricDoc): number {
  const levelScore = doc.level === 'word' ? 3 : doc.level === 'line' ? 2 : 1;
  return levelScore * 10 + doc.confidence - doc.tier * 0.1;
}
