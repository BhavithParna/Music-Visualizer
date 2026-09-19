import { homedir } from 'node:os';
import { join } from 'node:path';

const XDG_DATA = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');

export const DATA_DIR = join(XDG_DATA, 'lyricroom');
export const CACHE_DIR = join(DATA_DIR, 'cache');
export const ART_DIR = join(DATA_DIR, 'art');
/** Hand-authored overrides: drop `<trackKey>.ttml` or `.lrc` here and it wins over every provider. */
export const SIDECAR_DIR = join(DATA_DIR, 'lyrics');
export const OFFSETS_FILE = join(DATA_DIR, 'offsets.json');

export const PORT = Number(process.env.LYRICROOM_PORT ?? 8321);
export const USER_AGENT = 'LyricRoom/0.1 (personal room display; +https://github.com/local/lyricroom)';

/** MPRIS bus-name fragments we care about, in priority order when several are playing. */
export const PLAYER_PRIORITY = ['spotify', 'chrome', 'chromium', 'brave', 'firefox', 'vlc', 'mpv'];

/**
 * KPoe / LyricsPlus public instances. These churn (429 / 402 / gone), so we rotate.
 * Add a self-hosted instance at the front via LYRICROOM_LYRICSPLUS.
 */
export const LYRICSPLUS_BASES = (
  process.env.LYRICROOM_LYRICSPLUS ??
  'https://lyricsplus.binimum.org,https://lyricsplus.prjktla.workers.dev'
).split(',').map((s) => s.trim()).filter(Boolean);

export const LRCMUX_BASE = process.env.LYRICROOM_LRCMUX ?? 'https://api.lrcmux.dev';
export const LRCLIB_BASE = 'https://lrclib.net';
export const AMLL_BASE =
  'https://raw.githubusercontent.com/amll-dev/amll-ttml-db/refs/heads/main';

/**
 * KuGou word timings are machine-transcribed and frequently contain confidently-timed
 * *wrong words*. Off by default; line-level truth beats word-level fiction.
 */
export const ALLOW_KUGOU = process.env.LYRICROOM_ALLOW_KUGOU === '1';

/** Position re-read cadence while playing, to catch seeks Spotify performs without a signal. */
export const POSITION_POLL_MS = 1000;

/** Word-level results are effectively immutable; line-level may improve when a server comes back. */
export const TTL_WORD_MS = Number.POSITIVE_INFINITY;
export const TTL_LINE_MS = 24 * 60 * 60 * 1000;
export const TTL_MISS_MS = 60 * 60 * 1000;

export const NET_TIMEOUT_MS = 8000;
