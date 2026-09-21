import './styles.css';
import type { LyricDoc, NowPlaying, PlaybackAnchor, SceneMode } from '@lyricroom/shared';
import { WS_PATH } from '@lyricroom/shared';
import { Connection } from './net.js';
import { positionFrom } from './clock.js';
import { Stage } from './stage.js';
import { SceneDirector } from './scenes.js';
import { Overlay } from './dev/overlay.js';
import { FIXTURE_DOC, FIXTURE_GLYPHS, FIXTURE_LOOP_MS, FIXTURE_TRACK } from './dev/fixture.js';

const params = new URLSearchParams(location.search);
const FIXTURE = params.get('fixture') === '1';
/** `?t=6200` pins the fixture playhead, so a composition can be inspected frame-exactly. */
const PINNED_T = params.has('t') ? Number(params.get('t')) : null;

const stage = new Stage();
const scenes = new SceneDirector();
const overlay = new Overlay();

let track: NowPlaying | null = null;
let doc: LyricDoc | null = null;
let anchor: PlaybackAnchor = { positionMs: 0, atServerMs: 0, rate: 1, status: 'stopped' };
let bass = 0;
let lastMode: SceneMode = 'idle';

if (params.get('dev') === '1') overlay.toggle();
if (params.get('orient') === 'portrait') document.body.dataset['orient'] = 'portrait';

// ---------------------------------------------------------------- fixture ---

if (FIXTURE) {
  track = FIXTURE_TRACK;
  doc = FIXTURE_DOC;
  scenes.setTrack(track);
  scenes.setGlyphs(FIXTURE_GLYPHS);
  scenes.setLyrics(doc, 0);
  overlay.toggle();
}

// ------------------------------------------------------------------- live ---

const conn = new Connection(
  `${location.protocol === 'https:' ? 'wss://' : 'ws://'}${location.host}${WS_PATH}`,
);

if (!FIXTURE) {
  conn.on((msg) => {
    switch (msg.type) {
      case 'nowplaying':
        track = msg.track;
        anchor = msg.anchor;
        scenes.setTrack(track);
        void stage.setArt(track?.artUrl);
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
      case 'spectrum':
        bass = msg.bass;
        break;
    }
  });
  conn.connect();
}

// ------------------------------------------------------------------ frame ---

function frame(now: number): void {
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

  stage.frame(now, bass);
  lastMode = scenes.frame(posMs, playing, now);

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
  });

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// -------------------------------------------------------------- keyboard ---

const MODES: (SceneMode | 'auto')[] = ['auto', 'word', 'line', 'art', 'idle'];
let modeIdx = 0;

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
