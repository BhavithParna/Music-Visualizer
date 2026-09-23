# LyricRoom

An always-on kinetic-typography lyric visualizer for a room display. Whatever you
play, the lyrics appear word by word in huge grotesque type over blurred album
art, with a karaoke sweep, and the occasional glyph or inverted hook
word.

Runs on Linux and macOS. Only the player adapter differs between them; the
renderer knows nothing about either.

---

## Install it as an app

The one-step route on both platforms. You get a real launcher with its own
icon that starts the daemon on demand and opens the display in a window.

### Linux

```bash
npm install && npm run build
deploy/linux/install.sh
```

LyricRoom appears in the app grid — right-click it there to pin it to the dock.
Requires `playerctl` (`dnf install playerctl` / `apt install playerctl`) and a
Chromium-family browser.

### macOS

```bash
npm install && npm run build
deploy/macos/install.sh
```

`LyricRoom.app` lands in `~/Applications`, so it shows up in Spotlight and
Launchpad and can be dragged to the Dock. Requires Node and Google Chrome (or
Chromium/Brave/Edge) in `/Applications`.

The first time it runs, macOS asks whether it may control Spotify or Music.
That prompt is how the now-playing data gets read at all — decline it and the
screen stays empty. If you miss it: System Settings → Privacy & Security →
Automation.

---

## Quick start, without installing

### Linux

```bash
npm install && npm run build
node apps/daemon/dist/index.js       # terminal 1: the daemon
deploy/linux/launch-kiosk.sh         # terminal 2: the display
```

### macOS

```bash
npm install && npm run build
node apps/daemon/dist/index.js       # terminal 1: the daemon
deploy/macos/launch-kiosk.command    # terminal 2: the display
```

Add `--windowed` to either launcher to get an ordinary window instead of a
kiosk, which is what you want when the display is also the machine you work on.
In the window, the button in the corner (or `f`) goes fullscreen.

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
playerctl --follow  (Linux) ─┐
osascript poll      (macOS) ─┼─► daemon ──► lyric cascade ──► cache
pw-record monitor            ┘      │
                                    └── WebSocket :8321 ──► renderer (Chrome)
```

The **daemon** watches whatever is playing, resolves lyrics, proxies album art
onto its own origin, picks glyphs, and streams a spectrum. The **renderer** owns
everything visual and is entirely platform-agnostic.

### The only platform-specific part

`players/mpris.ts` follows MPRIS over `playerctl`; `players/macos.ts` polls
Spotify and Music through `osascript`. Both hand the daemon the same
`PlayerState`, and `index.ts` picks one by `process.platform` — that line is
the whole port. Spotify still yields a `spotify:track:` id on macOS, so the
lyric cache keys match across both machines.

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
- Words are **revealed as they are sung**: the whole phrase is laid out up
  front, and each word lands in its slot just ahead of its vocal. The sweep
  inside a word brightens the ink; unsung words are never grey.
- A held word **undulates** (Apple Music Sing style): letters swell, fan out
  and lift, and a variable face swells in weight across the hold.
- Phrases hand over through a shared **seam**, so the exit and the next entry
  always agree on direction. Choruses arrive on a pull, travel on a push, and
  the phrase before a chorus is held in a dimmed room first. A leaving phrase
  **smears**: a few faint copies close behind it blend into one soft streak.
- **Glyphs** are scarce on purpose: at most one per line, on a minority of lines,
  scored by how rare the word is within that song.
- The background is a **WebGL2 shader stage** with five looks (aureole, smoke,
  liquid ink, night city, sunlit), rendered small and upscaled with
  a vignette. It reacts to kicks and to each hero word landing.

### Songs get their own look

The daemon reads each song's lyrics offline for mood (valence and arousal),
themes (love, night, fire...) and structure (verse, chorus, bridge). The
renderer turns that into a look: a rap record gets heavy condensed type that
slams in over ink or city lights, a sad ballad gets a delicate serif drifting
up through smoke, a bright song gets warm light leaks. Choruses escalate. Pin
any of it from the phone remote or the keyboard.

### Render tiers

| Tier | For | What changes |
|---|---|---|
| Cinema | a strong GPU | full-res post, fluid ink, god rays, letter-by-letter heroes, blurred 4-copy smear, light spill |
| Smooth | most GPUs at 60 fps | half-res background at 30 Hz, 2-copy smear, no DOM blur, static glow |
| Auto | default | each display probes itself once and remembers the answer |

URL pins for iterating: `?fixture=1&look=smoke&preset=slam&tier=smooth`.
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
| `q` | cycle render tier: auto / cinema / smooth |
| `l` | cycle look |
| `p` | cycle motion preset: auto / calm / kinetic / slam |
| `Q` | forget the auto-tier probe and measure again |

Offsets are saved per track.

---

## Run it as a service

For the always-on room display, where nobody should have to launch anything.
Neither installer enables this for you.

### Linux

```bash
deploy/linux/install.sh
systemctl --user enable --now lyricroom-daemon.service
systemctl --user enable --now lyricroom-kiosk.service
```

The daemon and the kiosk both restart on their own. The kiosk launcher holds
`gnome-session-inhibit` for as long as it runs, so the screen never blanks.

### macOS

```bash
deploy/macos/install.sh
mkdir -p ~/Library/LaunchAgents
sed "s#REPLACE_WITH_REPO_PATH#$PWD#g" deploy/macos/com.lyricroom.daemon.plist \
  > ~/Library/LaunchAgents/com.lyricroom.daemon.plist
launchctl load ~/Library/LaunchAgents/com.lyricroom.daemon.plist
```

That keeps the daemon resolving lyrics from login onwards; open LyricRoom.app
whenever you want the display. `caffeinate -d` in the kiosk launcher is the
equivalent of the GNOME idle inhibit.

Note that a launchd agent still needs the Automation permission granted to it
before it can read Spotify or Music, and that prompt only appears in a logged-in
GUI session — so open the app by hand once first.

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `LYRICROOM_PORT` | `8321` | HTTP + WebSocket port |
| `LYRICROOM_LYRICSPLUS` | two public instances | Comma-separated bases; put a self-hosted one first |
| `LYRICROOM_LRCMUX` | `https://api.lrcmux.dev` | lrcmux base |
| `LYRICROOM_ALLOW_KUGOU` | off | Opt back into KuGou word timings |

State lives in `~/.local/share/lyricroom/` (`cache/`, `art/`, `lyrics/`,
`offsets.json`, `settings.json`) on both platforms — the same path on macOS, deliberately, so a
cache can be copied between machines. Nothing is written into the repository.

---

## Layout

```
apps/daemon      now-playing, lyric cascade, art proxy, glyphs, spectrum, WS
  players/mpris.ts   Linux, via playerctl
  players/macos.ts   macOS, via osascript
apps/renderer    all the visuals; knows nothing about the OS
packages/shared  the wire contract
deploy/linux     systemd units, kiosk launcher, .desktop entry
deploy/macos     launchd agent, kiosk launcher, LyricRoom.app
fixtures/        original demo content for offline iteration
reference/       the reel this was modelled on
```

## Tests

```bash
npm test         # parsers, timing normalisation, phrase splitting, title queries,
                 # macOS player rows
npm run typecheck
```
