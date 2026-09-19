import type { LyricDoc, NowPlaying } from '@lyricroom/shared';

export interface ProviderContext {
  track: NowPlaying;
  /** Set when the user has asked to skip past the provider that is currently winning. */
  skip?: Set<string>;
}

export interface Provider {
  readonly name: string;
  /** Lower runs first. Providers are tried in order until a word-level hit lands. */
  readonly tier: number;
  /** Returns null on a clean miss; throws only on an unexpected failure. */
  resolve(ctx: ProviderContext): Promise<LyricDoc | null>;
}
