import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { NowPlaying, PlaybackStatus } from '@lyricroom/shared';
import { makeAnchor, needsReanchor } from '../clock.js';
import { POSITION_POLL_MS } from '../config.js';
import { trackKeyFor, type PlayerAdapter, type PlayerState } from './types.js';

const execFileP = promisify(execFile);

export interface MacRow {
  player: 'Spotify' | 'Music';
  status: PlaybackStatus;
  positionMs: number;
  trackId: string;
  durationMs: number;
  artist: string;
  title: string;
  album: string;
  artUrl: string;
}

/**
 * One AppleScript pass over both players.
 *
 * `application "X" is running` is the load-bearing guard: any other way of
 * addressing an app launches it, and a lyric display that opens iTunes on a
 * machine nobody is using is worse than one that shows nothing.
 *
 * Spotify reports `duration` in milliseconds and Music in seconds, which is
 * why the two branches normalise separately rather than sharing a tail.
 */
const SCRIPT = `
on clean(v)
  try
    set t to v as text
  on error
    return ""
  end try
  set AppleScript's text item delimiters to tab
  set parts to text items of t
  set AppleScript's text item delimiters to " "
  set t to parts as text
  set AppleScript's text item delimiters to ""
  return t
end clean

set out to {}

if application "Spotify" is running then
  try
    tell application "Spotify"
      set st to player state as text
      if st is not "stopped" then
        set pos to player position
        set tr to current track
        set dur to duration of tr
        set au to ""
        try
          set au to artwork url of tr
        end try
        set row to "Spotify" & tab & st & tab & (pos as text) & tab & (id of tr as text) ¬
          & tab & (dur as text) & tab & my clean(artist of tr) & tab & my clean(name of tr) ¬
          & tab & my clean(album of tr) & tab & my clean(au)
        set end of out to row
      end if
    end tell
  end try
end if

if application "Music" is running then
  try
    tell application "Music"
      set st to player state as text
      if st is not "stopped" then
        set pos to player position
        set tr to current track
        set dur to duration of tr
        set row to "Music" & tab & st & tab & (pos as text) & tab & (persistent ID of tr as text) ¬
          & tab & (dur as text) & tab & my clean(artist of tr) & tab & my clean(name of tr) ¬
          & tab & my clean(album of tr) & tab & ""
        set end of out to row
      end if
    end tell
  end try
end if

set AppleScript's text item delimiters to linefeed
set res to out as text
set AppleScript's text item delimiters to ""
return res
`;

function parseStatus(s: string): PlaybackStatus {
  const v = s.trim().toLowerCase();
  if (v === 'playing') return 'playing';
  if (v === 'paused') return 'paused';
  return 'stopped';
}

/** `spotify:track:<id>` -> `<id>`. Music.app has no Spotify id, hence undefined. */
export function spotifyIdFrom(trackId: string): string | undefined {
  const m = /spotify:track:([A-Za-z0-9]{22})/.exec(trackId.trim());
  return m?.[1];
}

export function parseRow(line: string): MacRow | null {
  const parts = line.split('\t');
  if (parts.length < 9) return null;
  const [player, status, position, trackId, duration, artist, title, album, artUrl] = parts as [
    string, string, string, string, string, string, string, string, string,
  ];
  const who = player.trim();
  if (who !== 'Spotify' && who !== 'Music') return null;

  // AppleScript reals come back locale-formatted in some setups ("3,5").
  const num = (v: string): number => Number(v.trim().replace(',', '.')) || 0;
  const durRaw = num(duration);

  return {
    player: who,
    status: parseStatus(status),
    // `player position` is seconds in both apps.
    positionMs: num(position) * 1000,
    trackId: trackId.trim(),
    // Spotify's `duration` is already milliseconds; Music's is seconds.
    durationMs: who === 'Spotify' ? durRaw : durRaw * 1000,
    artist: artist.trim(),
    title: title.trim(),
    album: album.trim(),
    artUrl: artUrl.trim(),
  };
}

export function rowToTrack(row: MacRow): NowPlaying | null {
  if (!row.title && !row.artist) return null;
  const spotifyId = spotifyIdFrom(row.trackId);
  const track: NowPlaying = {
    trackKey: trackKeyFor(spotifyId, row.artist, row.title, row.durationMs),
    title: row.title,
    artist: row.artist,
    durationMs: row.durationMs,
    source: row.player === 'Spotify' ? 'spotify' : 'appleMusic',
    playerName: row.player.toLowerCase(),
  };
  if (spotifyId) track.spotifyId = spotifyId;
  if (row.album) track.album = row.album;
  if (row.artUrl) track.artUrl = row.artUrl;
  return track;
}

/** Anything actually playing wins; otherwise Spotify, which is the id-bearing one. */
export function pickActive(rows: MacRow[]): MacRow | null {
  const usable = rows.filter((r) => r.title || r.artist);
  if (!usable.length) return null;
  usable.sort((a, b) => {
    const ap = a.status === 'playing' ? 0 : 1;
    const bp = b.status === 'playing' ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return (a.player === 'Spotify' ? 0 : 1) - (b.player === 'Spotify' ? 0 : 1);
  });
  return usable[0] ?? null;
}

/**
 * macOS now-playing via `osascript`.
 *
 * There is no MPRIS here and no signal to subscribe to, so unlike the Linux
 * adapter this is a pure poll. That costs one short-lived osascript per second
 * while something is playing, and the same dead-reckoning between polls keeps
 * the playhead honest, so the renderer cannot tell the two platforms apart.
 */
export class MacAdapter implements PlayerAdapter {
  readonly name = 'macos';

  private poll: NodeJS.Timeout | null = null;
  private stopped = false;
  private listeners: ((s: PlayerState) => void)[] = [];
  private state: PlayerState = { track: null, anchor: makeAnchor(0, 'stopped') };
  private activePlayer: MacRow['player'] | null = null;

  onState(listener: (s: PlayerState) => void): void {
    this.listeners.push(listener);
  }

  current(): PlayerState {
    return this.state;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.pollOnce();
    this.poll = setInterval(() => {
      void this.pollOnce();
    }, POSITION_POLL_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  async control(action: 'playpause' | 'next' | 'previous'): Promise<void> {
    const app = this.activePlayer;
    if (!app) return;
    const verb =
      action === 'playpause' ? 'playpause' : action === 'next' ? 'next track' : 'previous track';
    try {
      await execFileP(
        'osascript',
        ['-e', `if application "${app}" is running then tell application "${app}" to ${verb}`],
        { timeout: 5000 },
      );
    } catch {
      /* the app went away mid-command; not fatal for a display */
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.stopped) return;
    let rows: MacRow[] = [];
    try {
      const { stdout } = await execFileP('osascript', ['-e', SCRIPT], { timeout: 5000 });
      rows = stdout
        .split('\n')
        .map((l) => parseRow(l))
        .filter((r): r is MacRow => r !== null);
    } catch {
      // Neither app running, or the automation permission was declined.
      rows = [];
    }
    this.recompute(rows);
  }

  private recompute(rows: MacRow[]): void {
    const row = pickActive(rows);
    if (!row) {
      this.activePlayer = null;
      if (this.state.track !== null || this.state.anchor.status !== 'stopped') {
        this.state = { track: null, anchor: makeAnchor(0, 'stopped') };
        this.emit();
      }
      return;
    }
    this.activePlayer = row.player;
    const track = rowToTrack(row);
    const prev = this.state;
    const trackChanged = prev.track?.trackKey !== track?.trackKey;
    const statusChanged = prev.anchor.status !== row.status;
    const drifted = needsReanchor(prev.anchor, row.positionMs);

    if (trackChanged || statusChanged || drifted) {
      this.state = { track, anchor: makeAnchor(row.positionMs, row.status, 1) };
      this.emit();
    } else if (track) {
      // Keep metadata fresh (art can arrive late) without disturbing the anchor.
      this.state = { track, anchor: prev.anchor };
    }
  }

  private emit(): void {
    for (const l of this.listeners) l(this.state);
  }
}
