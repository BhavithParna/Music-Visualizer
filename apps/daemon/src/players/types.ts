import type { NowPlaying, PlaybackAnchor } from '@lyricroom/shared';

export interface PlayerState {
  track: NowPlaying | null;
  anchor: PlaybackAnchor;
}

export interface PlayerAdapter {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Fires on track change, play/pause, and whenever the position anchor is refreshed. */
  onState(listener: (state: PlayerState) => void): void;
  /** Best-effort transport control; no-op when the backend cannot do it. */
  control(action: 'playpause' | 'next' | 'previous'): Promise<void>;
  current(): PlayerState;
}

export function trackKeyFor(
  spotifyId: string | undefined,
  artist: string,
  title: string,
  durationMs: number,
): string {
  if (spotifyId) return `spotify:${spotifyId}`;
  const dur = Math.round(durationMs / 1000);
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  return `meta:${norm(artist)}|${norm(title)}|${dur}`;
}
