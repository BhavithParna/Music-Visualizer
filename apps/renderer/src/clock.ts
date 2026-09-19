import type { PlaybackAnchor } from '@lyricroom/shared';

/**
 * Estimates the daemon's monotonic clock in terms of our own.
 *
 * Both sides use performance.now(), which share no epoch, so we run a tiny
 * NTP-style exchange: the sample with the smallest round trip is the least
 * distorted by scheduling, so it wins outright rather than being averaged in.
 */
export class ServerClock {
  private offset = 0;
  private bestRtt = Number.POSITIVE_INFINITY;
  private samples = 0;

  /** Feed a pong: the time we sent, and the server clock reading it returned. */
  accept(clientSent: number, serverMs: number, now = performance.now()): void {
    const rtt = now - clientSent;
    if (rtt < 0) return;
    // Assume a symmetric path: the reading was taken rtt/2 ago.
    const offset = serverMs - (clientSent + rtt / 2);
    this.samples += 1;
    if (rtt <= this.bestRtt) {
      this.bestRtt = rtt;
      this.offset = offset;
      return;
    }
    // Let the estimate drift slowly towards later samples so a one-off fast
    // round trip cannot pin us to a stale offset forever.
    this.bestRtt += 6;
    this.offset += (offset - this.offset) * 0.02;
  }

  /** Our best guess at the daemon's clock right now. */
  serverNow(now = performance.now()): number {
    return now + this.offset;
  }

  get ready(): boolean {
    return this.samples > 0;
  }

  get rtt(): number {
    return Number.isFinite(this.bestRtt) ? this.bestRtt : 0;
  }
}

/** Where the playhead is, given an anchor and the estimated server clock. */
export function positionFrom(anchor: PlaybackAnchor, serverNow: number): number {
  if (anchor.status !== 'playing') return anchor.positionMs;
  return anchor.positionMs + (serverNow - anchor.atServerMs) * anchor.rate;
}
