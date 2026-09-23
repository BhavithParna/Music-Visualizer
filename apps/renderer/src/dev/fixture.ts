import type { LyricDoc, LyricLine, NowPlaying, SongProfile } from '@lyricroom/shared';
import { detectSections } from '@lyricroom/shared';

/**
 * Offline demo content, written for this project, so the whole look can be
 * iterated with no player, no network and no audio. `?fixture=1` runs a virtual
 * playhead over it on a loop.
 */
const VERSE: [string, number, number[]][] = [
  ['Neon on the ceiling', 800, [800, 1500, 2000, 2400, 4000]],
  ['Counting every hour', 4400, [4400, 5100, 5700, 7600]],
  ['Gold inside the tower', 8000, [8000, 8600, 9100, 9600, 11400]],
  ['Tell me what you see', 11800, [11800, 12200, 12700, 13100, 15000]],
  ['The city is a rumour', 15400, [15400, 15800, 16300, 16700, 18600]],
  ['Paradise on fire', 19000, [19000, 19700, 20100, 22000]],
  ['Run', 22400, [22400, 24200]],
  ['Winning in the dark', 24600, [24600, 25400, 25800, 27600]],
  // A deliberately long bar: the regression guard for phrase splitting and the
  // measured fit, which is where a real rap line used to run off the frame.
  [
    'They put a lock on the city so nobody ever gets to leave again',
    28000,
    [28000, 28300, 28600, 28900, 29200, 29500, 29800, 30200, 30600, 31000,
     31400, 31800, 32200, 33600],
  ],
  // The chorus comes back after an instrumental gap long enough for the
  // breathing dots, so structure detection, repeat variation and the dots can
  // all be iterated offline.
  ['Paradise on fire', 38600, [38600, 39300, 39700, 41600]],
  ['Run', 42000, [42000, 43800]],
];

/** An ad-lib under the second chorus, for the background-vocal layer. */
const BACKING: [string, number, number[]] = ['run run run', 42500, [42500, 42900, 43300, 43700]];

function buildLines(): LyricLine[] {
  const main = [...VERSE, BACKING].map(([text, start, stamps]) => {
    const tokens = text.split(' ');
    const words = tokens.map((t, i) => ({
      text: i === tokens.length - 1 ? t : `${t} `,
      startMs: stamps[i] ?? start,
      endMs: stamps[i + 1] ?? (stamps[stamps.length - 1] ?? start) + 400,
    }));
    return {
      text,
      startMs: start,
      endMs: stamps[stamps.length - 1] ?? start + 1500,
      words,
      ...(text === BACKING[0] ? { background: true } : {}),
    } as LyricLine;
  });
  return main.sort((a, b) => a.startMs - b.startMs);
}

export const FIXTURE_DOC: LyricDoc = {
  trackKey: 'fixture:demo',
  level: 'word',
  provider: 'fixture',
  tier: 0,
  lines: buildLines(),
  confidence: 1,
  fetchedAt: Date.now(),
  wordsInterpolated: false,
};

export const FIXTURE_TRACK: NowPlaying = {
  trackKey: 'fixture:demo',
  title: 'Demo Composition',
  artist: 'LyricRoom',
  album: 'Fixture',
  durationMs: 46_000,
  source: 'local',
  playerName: 'fixture',
};

export const FIXTURE_GLYPHS: Record<number, string> = {
  3: '\u{1F441}\u{FE0F}',
  5: '\u{1F525}',
  7: '\u{1F3C6}',
};

export const FIXTURE_LOOP_MS = 46_000;

/**
 * A hand-set profile standing in for the daemon's lyric analysis, which needs
 * Node-side lexicons. Structure is real: it comes from the same detector.
 */
export const FIXTURE_PROFILE: SongProfile = (() => {
  const lines = FIXTURE_DOC.lines;
  const lineMood = lines.map(() => ({ valence: 0.1, arousal: 0.55 }));
  const { sections, lineSection } = detectSections(lines, lineMood.map((m) => m.arousal));
  return {
    valence: 0.1, arousal: 0.55, themes: ['night', 'fire'], density: 1.9, sections, lineSection, lineMood,
  };
})();
