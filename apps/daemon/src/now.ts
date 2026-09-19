/**
 * Diagnostic CLI: `npm run daemon:now`
 *
 * Prints what the daemon believes is playing, which provider tier won, and the
 * word currently under the playhead. This is the fastest way to tell a sync
 * problem (wrong offset) from a data problem (wrong document).
 */
import type { LyricDoc } from '@lyricroom/shared';
import { MprisAdapter } from './players/mpris.js';
import { resolveLyrics } from './lyrics/resolver.js';
import { getOffset } from './lyrics/offsets.js';
import { projectPosition } from './clock.js';
import type { PlayerState } from './players/types.js';

const player = new MprisAdapter();
let doc: LyricDoc | null = null;
let offsetMs = 0;
let currentKey: string | null = null;
let state: PlayerState = player.current();

function findLine(posMs: number): { line: number; word: string } | null {
  if (!doc) return null;
  for (let i = doc.lines.length - 1; i >= 0; i -= 1) {
    const line = doc.lines[i]!;
    if (posMs >= line.startMs && posMs <= line.endMs) {
      const w = line.words.find((x) => posMs >= x.startMs && posMs < x.endMs);
      return { line: i, word: (w?.text ?? '').trim() };
    }
  }
  return null;
}

player.onState((s) => {
  state = s;
  const key = s.track?.trackKey ?? null;
  if (key === currentKey) return;
  currentKey = key;
  doc = null;
  if (!s.track) {
    console.log('\n-- nothing playing --');
    return;
  }
  const track = s.track;
  console.log(`\n${track.artist} - ${track.title}`);
  console.log(`  key=${track.trackKey} player=${track.playerName} duration=${Math.round(track.durationMs / 1000)}s`);
  void (async () => {
    offsetMs = await getOffset(track.trackKey);
    const t0 = Date.now();
    doc = await resolveLyrics(track, {
      onProgress: (p, o) => console.log(`  ${p}: ${o}`),
    });
    if (doc) {
      console.log(
        `  => ${doc.level} via ${doc.provider}, ${doc.lines.length} lines, ` +
          `interpolated=${doc.wordsInterpolated ? 'yes' : 'no'}, ${Date.now() - t0}ms`,
      );
    } else {
      console.log(`  => no lyrics (${Date.now() - t0}ms)`);
    }
  })();
});

await player.start();

setInterval(() => {
  if (!state.track) return;
  const pos = projectPosition(state.anchor) - offsetMs;
  const hit = findLine(pos);
  const mmss = `${String(Math.floor(pos / 60000)).padStart(2, '0')}:${String(Math.floor((pos % 60000) / 1000)).padStart(2, '0')}`;
  const status = state.anchor.status.padEnd(7);
  const label = hit ? `L${hit.line} "${hit.word}"` : doc ? '(gap)' : '(no doc)';
  process.stdout.write(`\r  ${status} ${mmss}  ${label}`.padEnd(78));
}, 250);

process.on('SIGINT', () => {
  void player.stop().finally(() => process.exit(0));
});
