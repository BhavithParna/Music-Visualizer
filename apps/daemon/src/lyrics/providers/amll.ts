import type { LyricDoc } from '@lyricroom/shared';
import { AMLL_BASE } from '../../config.js';
import { fetchText, HttpError } from '../http.js';
import { parseTtml } from '../parse/ttml.js';
import type { Provider, ProviderContext } from './types.js';

/**
 * Tier 2: the AMLL TTML database, keyed by Spotify track id.
 *
 * The catalogue is small (a few thousand Spotify-keyed tracks, weighted towards
 * J-pop and anime) but it is CC0, hand-timed at syllable level, and needs no
 * fuzzy matching at all: the MPRIS track id IS the primary key. One GET, no auth.
 */
export const amllProvider: Provider = {
  name: 'amll',
  tier: 2,
  async resolve({ track }: ProviderContext): Promise<LyricDoc | null> {
    if (!track.spotifyId) return null;
    const url = `${AMLL_BASE}/spotify-lyrics/${track.spotifyId}.ttml`;
    let xml: string;
    try {
      xml = await fetchText(url);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
    return parseTtml(xml, {
      trackKey: track.trackKey,
      provider: 'amll',
      tier: 2,
      confidence: 0.97,
    });
  },
};
