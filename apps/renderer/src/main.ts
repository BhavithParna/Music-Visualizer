import './styles.css';
import type {
  BeatInfo, DisplaySettings, LookName, LyricDoc, MotionPreset, NowPlaying, PlaybackAnchor, SceneMode,
  SongProfile, TierSetting,
} from '@lyricroom/shared';
import { DEFAULT_SETTINGS, LOOKS, PRESETS, WS_PATH } from '@lyricroom/shared';
import { Connection } from './net.js';
import { positionFrom } from './clock.js';
import { Stage } from './stage.js';
import { SceneDirector } from './scenes.js';
import { Overlay } from './dev/overlay.js';
import { Quality } from './quality.js';
import { applyThemeFonts, buildTheme, loadThemeFonts, type Theme } from './theme.js';
import { audio } from './type/word.js';
import {
  FIXTURE_DOC, FIXTURE_GLYPHS, FIXTURE_LOOP_MS, FIXTURE_PROFILE, FIXTURE_TRACK,
} from './dev/fixture.js';

const params = new URLSearchParams(location.search);
const FIXTURE = params.get('fixture') === '1';
/** `?t=6200` pins the fixture playhead, so a composition can be inspected frame-exactly. */
const PINNED_T = params.has('t') ? Number(params.get('t')) : null;
/** `?look=smoke&preset=slam&tier=smooth` pin the look for iterating. */
const URL_LOOK = LOOKS.includes(params.get('look') as LookName) ? (params.get('look') as LookName) : null;
const URL_PRESET = PRESETS.includes(params.get('preset') as MotionPreset) ? (params.get('preset') as MotionPreset) : null;

const quality = new Quality(params.get('tier'));
const stage = new Stage();
quality.setDevice(stage.renderer);
const scenes = new SceneDirector();
const overlay = new Overlay();
scenes.onMask = (c) => stage.setMask(c);
scenes.setTier(quality.tier);
quality.onChange((tier) => scenes.setTier(tier));

let track: NowPlaying | null = null;
let doc: LyricDoc | null = null;
let profile: SongProfile | null = null;
let settings: DisplaySettings = { ...DEFAULT_SETTINGS };
let theme: Theme = buildTheme(null, settings, '');
let anchor: PlaybackAnchor = { positionMs: 0, atServerMs: 0, rate: 1, status: 'stopped' };
let bass = 0;
let beat: BeatInfo | null = null;
let lastMode: SceneMode = 'idle';

/** Re-derive the look whenever the song, its profile or the settings change. */
function retheme(): void {
  theme = buildTheme(
    profile,
    { look: URL_LOOK ?? settings.look, preset: URL_PRESET ?? settings.preset },
    track?.trackKey ?? '',
  );
  applyThemeFonts(theme);
  stage.setGrade(theme.temperature, theme.saturation);
  scenes.setTheme(theme);
  void loadThemeFonts(theme);
}

function applySettings(next: DisplaySettings): void {
  settings = next;
  quality.setSetting(settings.tier);
  retheme();
}

retheme();

if (params.get('dev') === '1') overlay.toggle();
if (params.get('orient') === 'portrait') document.body.dataset['orient'] = 'portrait';

// ---------------------------------------------------------------- fixture ---

if (FIXTURE) {
  track = FIXTURE_TRACK;
  doc = FIXTURE_DOC;
  profile = FIXTURE_PROFILE;
  scenes.setTrack(track);
  scenes.setGlyphs(FIXTURE_GLYPHS);
  scenes.setLyrics(doc, 0);
  scenes.setProfile(profile);
  retheme();
  if (params.get('dev') !== '0') overlay.toggle();
}

// ------------------------------------------------------------------- live ---

const conn = new Connection(
  `${location.protocol === 'https:' ? 'wss://' : 'ws://'}${location.host}${WS_PATH}`,
);

if (!FIXTURE) {
  conn.on((msg) => {
    switch (msg.type) {
      case 'nowplaying':
        if (msg.track?.trackKey !== track?.trackKey) profile = null;
        track = msg.track;
        anchor = msg.anchor;
        scenes.setTrack(track);
        void stage.setArt(track?.artUrl);
        retheme();
        break;
      case 'anchor':
        anchor = msg.anchor;
        break;
      case 'lyrics':
        if (msg.trackKey !== track?.trackKey) break;
        doc = msg.doc;
        scenes.setLyrics(msg.doc, msg.offsetMs);
        break;
      case 'glyphs':
        if (msg.trackKey !== track?.trackKey) break;
        scenes.setGlyphs(msg.glyphs);
        break;
      case 'mode':
        scenes.setMode(msg.mode);
        break;
      case 'profile':
        if (msg.trackKey !== track?.trackKey) break;
        profile = msg.profile;
        scenes.setProfile(profile);
        retheme();
        break;
      case 'settings':
        applySettings(msg.settings);
        break;
      case 'spectrum': {
        // Decoration only: anything non-finite (NaN arrives as null) reads as silence.
        const f = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
        bass = f(msg.bass);
        const b = msg.beat;
        beat = b
          ? { bpm: f(b.bpm), phase: f(b.phase), kick: f(b.kick), snare: f(b.snare), hat: f(b.hat), energy: f(b.energy) }
          : null;
        scenes.setBeat(beat ?? undefined);
        break;
      }
    }
  });
  conn.connect();
}

// ------------------------------------------------------------------ frame ---

function frame(now: number): void {
  // Always ask for the next frame first: on a display nobody watches, one
  // exception must cost a frame, never the whole loop.
  requestAnimationFrame(frame);
  try {
    drawFrame(now);
  } catch (err) {
    console.error('[lyricroom] frame failed:', err);
  }
}

function drawFrame(now: number): void {
  overlay.tick(now);

  let posMs: number;
  let playing: boolean;
  if (FIXTURE) {
    posMs = PINNED_T ?? now % FIXTURE_LOOP_MS;
    playing = true;
  } else {
    posMs = positionFrom(anchor, conn.clock.serverNow(now));
    playing = anchor.status === 'playing';
  }

  audio.bass = bass;
  lastMode = scenes.frame(posMs, playing, now);
  const out = scenes.out;
  stage.frame({
    now,
    tier: quality.tier,
    // The probe has to measure the worst case, not whichever look happens to
    // be up, or a cheap look would talk a weak GPU into Cinema.
    look: quality.isProbing ? 'night-city' : theme.look,
    bass,
    kick: beat?.kick ?? 0,
    snare: beat?.snare ?? 0,
    hat: beat?.hat ?? 0,
    energy: beat?.energy ?? 0.5,
    section: out.section,
    impact: out.impact,
    dim: out.dim,
    valence: profile?.valence ?? 0,
    arousal: profile?.arousal ?? 0.5,
    cam: out.cam,
    scrim: 0,
    mask: out.mask,
    flow: theme.preset === 'calm' ? 0.7 : theme.preset === 'slam' ? 1.3 : 1,
  });
  quality.sample(now, stage.gpuMs);

  overlay.render({
    mode: lastMode,
    level: doc?.level ?? 'none',
    provider: doc?.provider ?? '',
    lines: doc?.lines.length ?? 0,
    posMs,
    offsetMs: scenes.currentOffset,
    rtt: FIXTURE ? 0 : conn.clock.rtt,
    online: FIXTURE ? true : conn.online,
    active: scenes.activeLineCount,
    track: track ? `${track.artist} - ${track.title}` : '',
    tier: `${quality.tier} [${quality.settingLabel}]`,
    look: `${theme.look} / ${theme.preset} / ${theme.hero.family.replace(/'/g, '')}`,
    reason: theme.reason,
    section: out.sectionLabel || '--',
    beat: beat ? `${beat.bpm ? beat.bpm.toFixed(0) : '--'} bpm  e ${beat.energy.toFixed(2)}  k ${beat.kick.toFixed(2)}` : '--',
    gpu: stage.webgl ? (stage.gpuMs !== null ? `${stage.gpuMs.toFixed(2)}ms` : 'n/a') : 'canvas',
    mood: profile ? `v ${profile.valence.toFixed(2)} a ${profile.arousal.toFixed(2)} ${profile.themes.join(',')}` : '--',
  });
}
requestAnimationFrame(frame);

// -------------------------------------------------------------- keyboard ---

const MODES: (SceneMode | 'auto')[] = ['auto', 'word', 'line', 'art', 'idle'];
let modeIdx = 0;
const TIERS: TierSetting[] = ['auto', 'cinema', 'smooth'];

/** Change a display setting: through the daemon, so every surface agrees; locally in the fixture. */
function changeSetting(patch: Partial<DisplaySettings>): void {
  if (FIXTURE) applySettings({ ...settings, ...patch });
  else conn.send({ type: 'setsettings', settings: patch });
}

function cycle<T>(list: readonly T[], cur: T): T {
  return list[(list.indexOf(cur) + 1) % list.length]!;
}

window.addEventListener('keydown', (ev) => {
  const nudge = (ms: number): void => {
    if (!track) return;
    conn.send({ type: 'nudge', trackKey: track.trackKey, deltaMs: ms });
  };
  switch (ev.key) {
    case 'd': overlay.toggle(); break;
    case '[': nudge(-100); break;
    case ']': nudge(100); break;
    case ',': nudge(-1000); break;
    case '.': nudge(1000); break;
    case 'm':
      modeIdx = (modeIdx + 1) % MODES.length;
      scenes.setMode(MODES[modeIdx]!);
      break;
    case 'r': conn.send({ type: 'control', action: 'reloadLyrics' }); break;
    case 'n': conn.send({ type: 'control', action: 'nextProvider' }); break;
    case ' ':
      ev.preventDefault();
      conn.send({ type: 'control', action: 'playpause' });
      break;
    case 'f':
      toggleFullscreen();
      break;
    case 'q':
      changeSetting({ tier: cycle(TIERS, settings.tier) });
      break;
    case 'l':
      changeSetting({ look: cycle(['auto', ...LOOKS] as const, settings.look) });
      break;
    case 'p':
      changeSetting({ preset: cycle(['auto', ...PRESETS] as const, settings.preset) });
      break;
    case 'Q':
      quality.reprobe();
      break;
  }
});

// ------------------------------------------------------------ fullscreen ---

const ENTER_ICON =
  '<path d="M9 4H5a1 1 0 0 0-1 1v4M15 4h4a1 1 0 0 1 1 1v4M9 20H5a1 1 0 0 1-1-1v-4M15 20h4a1 1 0 0 0 1-1v-4" />';
const EXIT_ICON =
  '<path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" />';

function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen();
}

const fsToggle = document.getElementById('fsToggle') as HTMLButtonElement;
fsToggle.addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => {
  const on = Boolean(document.fullscreenElement);
  fsToggle.dataset['on'] = on ? '1' : '0';
  fsToggle.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Enter fullscreen');
  fsToggle.title = on ? 'Exit fullscreen (f)' : 'Fullscreen (f)';
  const svg = fsToggle.querySelector('svg');
  if (svg) svg.innerHTML = on ? EXIT_ICON : ENTER_ICON;
});

// Keep the pointer out of the way on a room display, but let it come back
// briefly if someone actually moves the mouse.
let cursorTimer = 0;
window.addEventListener('mousemove', () => {
  document.body.style.cursor = 'default';
  window.clearTimeout(cursorTimer);
  cursorTimer = window.setTimeout(() => {
    document.body.style.cursor = 'none';
  }, 2500);
});
