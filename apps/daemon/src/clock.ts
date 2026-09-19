import type { PlaybackAnchor, PlaybackStatus } from '@lyricroom/shared';

/** Monotonic milliseconds since process start. Never jumps with wall-clock changes. */
export function monoNow(): number {
  return performance.now();
}

/**
 * Dead-reckons the current playback position from an anchor.
 * MPRIS forbids PropertiesChanged on Position and Spotify omits the Seeked signal,
 * so between anchors the only honest estimate is anchor + elapsed monotonic time.
 */
export function projectPosition(anchor: PlaybackAnchor, at = monoNow()): number {
  if (anchor.status !== 'playing') return anchor.positionMs;
  return anchor.positionMs + (at - anchor.atServerMs) * anchor.rate;
}

export function makeAnchor(
  positionMs: number,
  status: PlaybackStatus,
  rate = 1,
  at = monoNow(),
): PlaybackAnchor {
  return { positionMs, atServerMs: at, rate, status };
}

/**
 * True when a fresh reading disagrees with the projection by more than `toleranceMs`,
 * i.e. the user seeked or the player drifted and we must re-anchor.
 */
export function needsReanchor(
  anchor: PlaybackAnchor,
  observedMs: number,
  at = monoNow(),
  toleranceMs = 350,
): boolean {
  return Math.abs(observedMs - projectPosition(anchor, at)) > toleranceMs;
}
