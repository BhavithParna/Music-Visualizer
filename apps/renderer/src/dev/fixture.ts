import type { LyricDoc, LyricLine, NowPlaying } from '@lyricroom/shared';

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
];

function buildLines(): LyricLine[] {
  return VERSE.map(([text, start, stamps]) => {
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
    };
  });
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
  durationMs: 29_000,
  source: 'local',
  playerName: 'fixture',
};

export const FIXTURE_GLYPHS: Record<number, string> = {
  3: '\u{1F441}\u{FE0F}',
  5: '\u{1F525}',
  7: '\u{1F3C6}',
};

export const FIXTURE_LOOP_MS = 29_000;
