/**
 * Shared contract between the daemon and the renderer.
 * All times are milliseconds unless the name says otherwise.
 */

/** Where the currently playing audio came from. */
export type PlayerSource = 'spotify' | 'browser' | 'appleMusic' | 'local' | 'none';

export type PlaybackStatus = 'playing' | 'paused' | 'stopped';

/** Sync granularity of a resolved lyric document. */
export type SyncLevel = 'word' | 'line' | 'unsynced' | 'none';

export interface NowPlaying {
  /** Stable cache key: `spotify:<id>` when known, else `meta:<artist>|<title>|<durationSec>`. */
  trackKey: string;
  /** Bare Spotify track id when the player exposes one. */
  spotifyId?: string;
  title: string;
  artist: string;
  album?: string;
  durationMs: number;
  artUrl?: string;
  source: PlayerSource;
  /** MPRIS bus name / AppleScript app name, for debugging. */
  playerName?: string;
}

/**
 * A playback position sample. The renderer dead-reckons from this:
 *   now = positionMs + (nowMonotonic - atMonotonic) * rate   (while playing)
 * `atServerMs` is the daemon's monotonic clock reading when the sample was taken.
 */
export interface PlaybackAnchor {
  positionMs: number;
  atServerMs: number;
  rate: number;
  status: PlaybackStatus;
}

export interface LyricWord {
  text: string;
  startMs: number;
  endMs: number;
  /** True when this token is only whitespace/punctuation glue, never highlighted alone. */
  glue?: boolean;
}

export interface LyricLine {
  text: string;
  startMs: number;
  endMs: number;
  words: LyricWord[];
  /** TTML agent id, used to distinguish duet voices. */
  agent?: string;
  /** TTML background-vocal role. */
  background?: boolean;
  /** Song part label from TTML metadata (verse/chorus/bridge). */
  part?: string;
}

export interface LyricDoc {
  trackKey: string;
  level: SyncLevel;
  /** Name of the provider tier that produced this, e.g. 'lyricsplus'. */
  provider: string;
  /** Lower is better; used when deciding whether a later tier should replace this. */
  tier: number;
  lines: LyricLine[];
  /** Provider-reported or derived confidence, 0..1. */
  confidence: number;
  fetchedAt: number;
  /** True when word timings were interpolated from line timings rather than supplied. */
  wordsInterpolated?: boolean;
}

export interface Swatch {
  hex: string;
  rgb: [number, number, number];
  population: number;
  titleTextColor: string;
  bodyTextColor: string;
}

export interface Palette {
  /** Source art URL this palette was derived from. */
  artUrl: string;
  vibrant?: Swatch;
  muted?: Swatch;
  darkVibrant?: Swatch;
  darkMuted?: Swatch;
  lightVibrant?: Swatch;
  lightMuted?: Swatch;
  /** Warm-graded picks the renderer actually uses. */
  stage: string;
  ink: string;
  accent: string;
  /** Mean luminance of the art, 0..1, used to pick scrim strength. */
  luminance: number;
}

/** Scene the renderer should be showing. */
export type SceneMode = 'word' | 'line' | 'art' | 'idle';

// ---------------------------------------------------------------------------
// WebSocket protocol
// ---------------------------------------------------------------------------

export interface ServerHello {
  type: 'hello';
  /** Daemon monotonic clock at send time, for offset estimation. */
  serverMs: number;
  version: string;
}

export interface NowPlayingMsg {
  type: 'nowplaying';
  track: NowPlaying | null;
  anchor: PlaybackAnchor;
}

export interface AnchorMsg {
  type: 'anchor';
  anchor: PlaybackAnchor;
}

export interface LyricsMsg {
  type: 'lyrics';
  trackKey: string;
  doc: LyricDoc | null;
  /** Per-track manual timing correction in ms, applied by the renderer. */
  offsetMs: number;
}

export interface PaletteMsg {
  type: 'palette';
  trackKey: string;
  palette: Palette | null;
}

export interface GlyphsMsg {
  type: 'glyphs';
  trackKey: string;
  /** Line index -> emoji/glyph character. Sparse by design. */
  glyphs: Record<number, string>;
}

export interface SpectrumMsg {
  type: 'spectrum';
  /** Normalised 0..1 band energies, low to high. */
  bands: number[];
  /** Smoothed bass envelope 0..1. */
  bass: number;
  atServerMs: number;
}

export interface ModeMsg {
  type: 'mode';
  mode: SceneMode | 'auto';
}

export interface PongMsg {
  type: 'pong';
  clientSent: number;
  serverMs: number;
}

export type ServerMsg =
  | ServerHello
  | NowPlayingMsg
  | AnchorMsg
  | LyricsMsg
  | PaletteMsg
  | GlyphsMsg
  | SpectrumMsg
  | ModeMsg
  | PongMsg;

export interface PingMsg {
  type: 'ping';
  clientSent: number;
}

export interface NudgeMsg {
  type: 'nudge';
  trackKey: string;
  deltaMs: number;
}

export interface ControlMsg {
  type: 'control';
  action: 'playpause' | 'next' | 'previous' | 'reloadLyrics' | 'nextProvider';
}

export interface SetModeMsg {
  type: 'setmode';
  mode: SceneMode | 'auto';
}

export type ClientMsg = PingMsg | NudgeMsg | ControlMsg | SetModeMsg;

export const WS_PATH = '/ws';
export const DEFAULT_PORT = 8321;
