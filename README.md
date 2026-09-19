# LyricRoom

An always-on kinetic-typography lyric visualizer for a room display. Whatever you
play, the lyrics appear word by word in huge grotesque type over blurred album
art, with echo trails, a karaoke sweep, and the occasional glyph or inverted hook
word.

Runs on Linux today and ports to macOS by swapping a single module.

---

## Quick start

```bash
npm install
npm run build
node apps/daemon/dist/index.js      # terminal 1: the daemon
deploy/linux/launch-kiosk.sh        # terminal 2: the display
```

Add `--windowed` to the launcher to get an ordinary window instead of a kiosk,
which is what you want when the display is also the machine you work on.

Then play something. Open `http://localhost:8321/remote` on your phone for
transport, sync nudging and display mode.

### Iterating on the look, with no player and no network

```bash
npm run dev            # Vite on :5173
```

- `http://localhost:5173/?fixture=1` — demo content on a loop.
- `http://localhost:5173/?fixture=1&t=7200` — pin the playhead to 7.2 s and hold
  it there, so a single composition can be inspected frame-exactly.

### Diagnosing sync

```bash
npm run daemon:now
```

Prints the track, which provider tier won, and the word currently under the
playhead. If the word is right but early or late, it is an offset problem: nudge
it. If the word is wrong, it is a data problem: press `n` to try the next source.

---

## How it fits together

```
playerctl --follow ─┐
                    ├─► daemon ──► lyric cascade ──► cache (~/.local/share/lyricroom)
pw-record monitor ──┘      │
                           └── WebSocket :8321 ──► renderer (Chrome --kiosk)
```

The **daemon** watches MPRIS, resolves lyrics, proxies album art onto its own
origin, picks glyphs, and streams a spectrum. The **renderer** owns everything
visual and is entirely platform-agnostic.

### Why there is no timeline object

`update(posMs)` computes the whole frame from the playback position alone. There
is no animation timeline to scrub or drift, which is what makes seeking, pausing
and track-skipping exact on a display that runs for weeks at a time.

### How the playhead stays honest

MPRIS forbids a change signal on `Position`, and Spotify never emits `Seeked`. So
the daemon reads the position, then dead-reckons from a monotonic clock, and
re-anchors on every property change plus a 1 Hz re-read to catch silent seeks.
The renderer estimates the daemon's clock with an NTP-style exchange where the
lowest-round-trip sample wins.

### Lyric sources, in order

| Tier | Source | Level | Notes |
|---|---|---|---|
| 1 | `~/.local/share/lyricroom/lyrics/<key>.ttml\|.lrc` | whatever you author | Beats everything. How you fix a song permanently. |
| 2 | AMLL TTML DB | syllable | CC0, keyed directly by Spotify track id. Small catalogue. |
| 3 | LyricsPlus / KPoe | syllable | Apple Music TTML. The workhorse. Instances churn, so the list rotates. |
| 4 | lrcmux | word | KuGou excluded by default (machine-transcribed, often confidently wrong). |
| 5 | LRCLIB | line | Open and near-universal. Word timings are interpolated from line spans. |

Player metadata is not how lyric databases index a track, so every provider
retries with simplified queries -- featured artists, remaster and edit tags and
edition suffixes stripped, and the artist list cut to its first name -- stopping
at the first hit, which keeps the common case to a single request.

The cascade stops at the first word-level hit and keeps the best line-level
result as a running fallback, so a miss at the top never costs the safety net at
the bottom. A document whose last line starts more than 15 s past the end of the
track is rejected: it is timed against a different edit and is worse than none.

When only line timings exist, words are distributed by character count and the
motion deliberately calms down — aggressive per-word animation on guessed
timings just advertises the error.

---

## The look

- The screen holds a **phrase** -- two to four words -- never a whole lyric line.
  A line is cut at its natural silences and at a fixed ink budget, and the
  pieces play in turn. Rendering a whole bar at once is what makes a rap line
  overflow the frame and read as a subtitle rather than as a composition.
- One **hero** word per phrase, sized by how long it is *held* relative to its
  neighbours, so a dense rap line and a held ballad line both compose well. A
  stopword can never become the hero, however long a provider stretches it.
- Rows are packed to a target width and scaled to fit from estimated character
  widths, then **measured in the document** and shrunk if the estimate was
  optimistic, so a phrase can never run off the edge of the frame.
- Entry is anchored to the phrase and the karaoke sweep to the word: the whole
  composition cascades in together, then the highlight tracks the actual vocal.
  Waiting for each word to be sung before drawing it leaves the frame half empty.
- A phrase is told to leave before the next one lands, so a cut reads as a cut
  rather than as two compositions dissolving through each other.
- **Echo trails** replay the entry a few frames late. That temporal lag is what
  reads as motion rather than as a drop shadow.
- **Glyphs** are scarce on purpose: at most one per line, on a minority of lines,
  scored by how rare the word is within that song.
- Album art is blurred in a 64px canvas and scaled up by the compositor. Blurring
  at panel resolution would cost millions of samples per frame; this costs none.
- Composition jitter is seeded from the line text, so a song looks identical
  every time it plays.

### Keyboard

| Key | Action |
|---|---|
| `d` | diagnostic overlay |
| `[` `]` | nudge sync 100 ms |
| `,` `.` | nudge sync 1 s |
| `m` | cycle display mode |
| `r` / `n` | reload lyrics / try next source |
| `space` | play-pause |
| `f` | fullscreen |

Offsets are saved per track.

---

## Install as a service

```bash
npm run build
deploy/linux/install.sh
systemctl --user enable --now lyricroom-kiosk.service
```

The kiosk launcher holds `gnome-session-inhibit` for as long as it runs, so the
screen never blanks.

On macOS, use `deploy/macos/`. Only the player adapter changes: Spotify and
Music.app are scripted through `osascript`, and Spotify still yields a
`spotify:track:` id, so the same cache keys work.

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `LYRICROOM_PORT` | `8321` | HTTP + WebSocket port |
| `LYRICROOM_LYRICSPLUS` | two public instances | Comma-separated bases; put a self-hosted one first |
| `LYRICROOM_LRCMUX` | `https://api.lrcmux.dev` | lrcmux base |
| `LYRICROOM_ALLOW_KUGOU` | off | Opt back into KuGou word timings |

State lives in `~/.local/share/lyricroom/` (`cache/`, `art/`, `lyrics/`,
`offsets.json`). Nothing is written into the repository.

---

## Layout

```
apps/daemon      now-playing, lyric cascade, art proxy, glyphs, spectrum, WS
apps/renderer    all the visuals; knows nothing about the OS
packages/shared  the wire contract
deploy/          systemd units and kiosk launchers
fixtures/        original demo content for offline iteration
reference/       the reel this was modelled on
```

## Tests

```bash
npm test         # parsers, timing normalisation, phrase splitting, title queries
npm run typecheck
```
