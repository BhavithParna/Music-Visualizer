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
// Render tiers, looks and song theming
// ---------------------------------------------------------------------------

/**
 * How hard the renderer may push the GPU. `cinema` is the full look for a
 * strong GPU; `smooth` holds 60 fps on integrated graphics. `auto` lets each
 * display pick for itself from a short startup probe.
 */
export type RenderTier = 'cinema' | 'smooth';
export type TierSetting = RenderTier | 'auto';

/** The shader background. Chosen per song from its profile unless overridden. */
export type LookName = 'aureole' | 'smoke' | 'liquid-ink' | 'night-city' | 'sunlit';
export const LOOKS: readonly LookName[] = ['aureole', 'smoke', 'liquid-ink', 'night-city', 'sunlit'];

/** Motion temperament: pacing, fonts, cut style. Chosen per song unless overridden. */
export type MotionPreset = 'calm' | 'kinetic' | 'slam';
export const PRESETS: readonly MotionPreset[] = ['calm', 'kinetic', 'slam'];

/** Display settings shared by every surface and persisted by the daemon. */
export interface DisplaySettings {
  tier: TierSetting;
  look: LookName | 'auto';
  preset: MotionPreset | 'auto';
}

export const DEFAULT_SETTINGS: DisplaySettings = { tier: 'auto', look: 'auto', preset: 'auto' };

export type SectionKind = 'intro' | 'verse' | 'chorus' | 'bridge' | 'outro';

export interface Section {
  kind: SectionKind;
  startMs: number;
  endMs: number;
  /** Index of the first and one past the last lyric line in the section. */
  fromLine: number;
  toLine: number;
  /** 0..1, relative to the loudest section of the song, from density and mood. */
  energy: number;
  /** 0 for the first chorus, 1 for the second, and so on. */
  occurrence: number;
}

/** What a song is about and how it moves, derived offline from its lyrics. */
export interface SongProfile {
  /** -1..1, sad to happy. */
  valence: number;
  /** 0..1, calm to intense. */
  arousal: number;
  /** Top theme clusters, most prominent first, e.g. ['night', 'love']. */
  themes: string[];
  /** Mean sung words per second. */
  density: number;
  sections: Section[];
  /** Section index for every lyric line. */
  lineSection: number[];
  lineMood: { valence: number; arousal: number }[];
}

/** Live beat tracking, riding on the spectrum message. */
export interface BeatInfo {
  /** 0 until the tracker locks. */
  bpm: number;
  /** 0..1 position inside the current beat; 0 is the beat. */
  phase: number;
  /** Decaying onset envelopes 0..1: 1 on the hit, falling over ~180 ms. */
  kick: number;
  snare: number;
  hat: number;
  /** 0..1 slow loudness relative to what this song has done so far. */
  energy: number;
}

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
  beat?: BeatInfo;
}

export interface ProfileMsg {
  type: 'profile';
  trackKey: string;
  profile: SongProfile | null;
}

export interface SettingsMsg {
  type: 'settings';
  settings: DisplaySettings;
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
  | ProfileMsg
  | SettingsMsg
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

export interface SetSettingsMsg {
  type: 'setsettings';
  settings: Partial<DisplaySettings>;
}

export type ClientMsg = PingMsg | NudgeMsg | ControlMsg | SetModeMsg | SetSettingsMsg;

export const WS_PATH = '/ws';
export const DEFAULT_PORT = 8321;
