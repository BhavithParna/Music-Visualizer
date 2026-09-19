import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { NowPlaying, PlaybackStatus } from '@lyricroom/shared';
import { makeAnchor, monoNow, needsReanchor } from '../clock.js';
import { PLAYER_PRIORITY, POSITION_POLL_MS } from '../config.js';
import { trackKeyFor, type PlayerAdapter, type PlayerState } from './types.js';

const execFileP = promisify(execFile);

/** `playerctl --follow` with stdin closed and both output streams piped. */
type FollowProc = ChildProcessByStdio<null, Readable, Readable>;

const FIELDS = [
  '{{playerName}}',
  '{{status}}',
  '{{position}}',
  '{{mpris:trackid}}',
  '{{mpris:length}}',
  '{{xesam:artist}}',
  '{{xesam:title}}',
  '{{xesam:album}}',
  '{{mpris:artUrl}}',
].join('\t'); // a real tab: playerctl does NOT expand escape sequences in --format

interface Row {
  player: string;
  status: PlaybackStatus;
  positionMs: number;
  trackid: string;
  lengthMs: number;
  artist: string;
  title: string;
  album: string;
  artUrl: string;
}

function parseStatus(s: string): PlaybackStatus {
  const v = s.trim().toLowerCase();
  if (v === 'playing') return 'playing';
  if (v === 'paused') return 'paused';
  return 'stopped';
}

function parseRow(line: string): Row | null {
  const parts = line.split('\t');
  if (parts.length < 9) return null;
  const [player, status, position, trackid, length, artist, title, album, artUrl] = parts as [
    string, string, string, string, string, string, string, string, string,
  ];
  if (!player.trim()) return null;
  return {
    player: player.trim(),
    status: parseStatus(status),
    // playerctl format templates report position and length in MICROseconds.
    positionMs: Number(position || 0) / 1000,
    trackid: trackid.trim(),
    lengthMs: Number(length || 0) / 1000,
    artist: artist.trim(),
    title: title.trim(),
    album: album.trim(),
    artUrl: artUrl.trim(),
  };
}

/** `/com/spotify/track/<id>` or `spotify:track:<id>` -> `<id>`. */
export function spotifyIdFromTrackId(trackid: string): string | undefined {
  const m = /(?:\/com\/spotify\/track\/|spotify:track:)([A-Za-z0-9]{22})/.exec(trackid);
  return m?.[1];
}

function sourceFor(player: string): NowPlaying['source'] {
  const p = player.toLowerCase();
  if (p.includes('spotify')) return 'spotify';
  if (p.includes('chrome') || p.includes('chromium') || p.includes('brave') || p.includes('firefox')) {
    return 'browser';
  }
  return 'browser';
}

function priorityOf(player: string): number {
  const p = player.toLowerCase();
  const i = PLAYER_PRIORITY.findIndex((n) => p.includes(n));
  return i === -1 ? PLAYER_PRIORITY.length : i;
}

function rowToTrack(row: Row): NowPlaying | null {
  if (!row.title && !row.artist) return null;
  const spotifyId = spotifyIdFromTrackId(row.trackid);
  const track: NowPlaying = {
    trackKey: trackKeyFor(spotifyId, row.artist, row.title, row.lengthMs),
    title: row.title,
    artist: row.artist,
    durationMs: row.lengthMs,
    source: sourceFor(row.player),
    playerName: row.player,
  };
  if (spotifyId) track.spotifyId = spotifyId;
  if (row.album) track.album = row.album;
  if (row.artUrl) track.artUrl = row.artUrl;
  return track;
}

/**
 * Linux now-playing via `playerctl`.
 *
 * Two channels, because MPRIS gives us no position signal:
 *  - a long-lived `--follow` process that prints on every metadata/status change;
 *  - a 1 Hz position re-read, but ONLY while something is playing, so an idle
 *    room costs zero subprocesses.
 */
export class MprisAdapter implements PlayerAdapter {
  readonly name = 'mpris';

  private proc: FollowProc | null = null;
  private poll: NodeJS.Timeout | null = null;
  private respawn: NodeJS.Timeout | null = null;
  private stopped = false;
  private buf = '';
  private rows = new Map<string, Row>();
  private listeners: ((s: PlayerState) => void)[] = [];
  private state: PlayerState = { track: null, anchor: makeAnchor(0, 'stopped') };
  private activePlayer: string | null = null;

  onState(listener: (s: PlayerState) => void): void {
    this.listeners.push(listener);
  }

  current(): PlayerState {
    return this.state;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.spawnFollow();
    this.poll = setInterval(() => {
      void this.pollPosition();
    }, POSITION_POLL_MS);
    // Prime immediately; --follow only speaks when something changes.
    await this.pollOnce();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.poll) clearInterval(this.poll);
    if (this.respawn) clearTimeout(this.respawn);
    this.poll = null;
    this.respawn = null;
    this.proc?.kill();
    this.proc = null;
  }

  async control(action: 'playpause' | 'next' | 'previous'): Promise<void> {
    const player = this.activePlayer;
    const args = player ? ['-p', player, action] : [action];
    try {
      await execFileP('playerctl', args, { timeout: 3000 });
    } catch {
      /* no player, or the player refused; not fatal for a display app */
    }
  }

  private spawnFollow(): void {
    if (this.stopped) return;
    const proc = spawn('playerctl', ['-a', '--follow', 'metadata', '--format', FIELDS], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onChunk(chunk));
    proc.stderr.resume();
    const restart = () => {
      if (this.stopped || this.proc !== proc) return;
      this.proc = null;
      // playerctl exits when the last player disappears; come back and wait for one.
      this.respawn = setTimeout(() => this.spawnFollow(), 1500);
    };
    proc.on('exit', restart);
    proc.on('error', restart);
  }

  private onChunk(chunk: string): void {
    this.buf += chunk;
    const lines = this.buf.split('\n');
    this.buf = lines.pop() ?? '';
    let changed = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      const row = parseRow(line);
      if (!row) continue;
      this.rows.set(row.player, row);
      changed = true;
    }
    if (changed) this.recompute(true);
  }

  /** One-shot read of every player, used to prime state and to catch silent seeks. */
  private async pollOnce(): Promise<void> {
    try {
      const { stdout } = await execFileP(
        'playerctl',
        ['-a', 'metadata', '--format', FIELDS],
        { timeout: 3000 },
      );
      const seen = new Set<string>();
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        const row = parseRow(line);
        if (!row) continue;
        this.rows.set(row.player, row);
        seen.add(row.player);
      }
      for (const key of [...this.rows.keys()]) if (!seen.has(key)) this.rows.delete(key);
    } catch {
      // "No players found" exits non-zero. An empty room is a normal state.
      this.rows.clear();
    }
    this.recompute(false);
  }

  private async pollPosition(): Promise<void> {
    // Nothing is moving, so nothing can drift.
    if (this.state.anchor.status !== 'playing') {
      await this.pollOnce();
      return;
    }
    await this.pollOnce();
  }

  /** Choose the player to display: anything playing wins, then configured priority. */
  private pickActive(): Row | null {
    const rows = [...this.rows.values()].filter((r) => r.title || r.artist);
    if (rows.length === 0) return null;
    rows.sort((a, b) => {
      const ap = a.status === 'playing' ? 0 : 1;
      const bp = b.status === 'playing' ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return priorityOf(a.player) - priorityOf(b.player);
    });
    return rows[0] ?? null;
  }

  private recompute(fromFollow: boolean): void {
    const row = this.pickActive();
    if (!row) {
      if (this.state.track !== null || this.state.anchor.status !== 'stopped') {
        this.state = { track: null, anchor: makeAnchor(0, 'stopped') };
        this.emit();
      }
      this.activePlayer = null;
      return;
    }
    this.activePlayer = row.player;
    const track = rowToTrack(row);
    const prev = this.state;
    const trackChanged = prev.track?.trackKey !== track?.trackKey;
    const statusChanged = prev.anchor.status !== row.status;

    // Re-anchor on track change, on transport change, when --follow spoke,
    // or when the observed position has drifted away from our projection (a seek).
    const drifted = needsReanchor(prev.anchor, row.positionMs);
    if (trackChanged || statusChanged || fromFollow || drifted) {
      this.state = {
        track,
        anchor: makeAnchor(row.positionMs, row.status, 1),
      };
      this.emit();
    } else if (track && prev.track && trackChanged === false) {
      // Keep metadata fresh (art can arrive late) without disturbing the anchor.
      this.state = { track, anchor: prev.anchor };
    }
  }

  private emit(): void {
    for (const l of this.listeners) l(this.state);
  }
}

export const __test = { parseRow, spotifyIdFromTrackId, priorityOf };
