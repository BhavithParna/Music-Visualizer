import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LyricDoc } from '@lyricroom/shared';
import { SIDECAR_DIR } from '../../config.js';
import { parseTtml } from '../parse/ttml.js';
import { parseLrc } from '../parse/lrc.js';
import type { Provider, ProviderContext } from './types.js';

/** Filesystem-safe form of a track key, so `spotify:abc` becomes `spotify_abc`. */
export function safeKey(trackKey: string): string {
  return trackKey.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180);
}

/**
 * Tier 1: hand-authored overrides in ~/.local/share/lyricroom/lyrics/.
 * Anything here beats every network provider, which is how a badly timed
 * song gets fixed permanently.
 */
export const sidecarProvider: Provider = {
  name: 'sidecar',
  tier: 1,
  async resolve({ track }: ProviderContext): Promise<LyricDoc | null> {
    const base = join(SIDECAR_DIR, safeKey(track.trackKey));
    for (const ext of ['ttml', 'xml', 'lrc', 'txt'] as const) {
      let raw: string;
      try {
        raw = await readFile(`${base}.${ext}`, 'utf8');
      } catch {
        continue;
      }
      const meta = { trackKey: track.trackKey, provider: 'sidecar', tier: 1, confidence: 1 };
      const doc = ext === 'ttml' || ext === 'xml' ? parseTtml(raw, meta) : parseLrc(raw, meta);
      if (doc) return doc;
    }
    return null;
  },
};
