# How LyricRoom works

A walk through the tech behind the visualizer: what each piece does, and why it
is built the way it is. Written to be read start to finish; every claim points
at the file it comes from.

---

## 1. The shape of it

Two processes and one wire contract.

```
apps/daemon        Node. Knows the OS, the network, the player. Draws nothing.
apps/renderer      A Chrome page. Owns every pixel. Has no idea what OS it is on.
packages/shared    types.ts — the only module both sides import.
```

They talk over a single WebSocket on `:8321`.

| Direction | Messages |
|---|---|
| daemon → client | `hello`, `nowplaying`, `anchor`, `lyrics`, `glyphs`, `profile`, `spectrum` (with `beat`), `mode`, `settings`, `pong` |
| client → daemon | `ping`, `nudge`, `control`, `setmode`, `setsettings` |

That is the entire API surface (`packages/shared/src/types.ts:109-200`). The
phone remote at `/remote` is not special — it is a third client on the same
socket, and `Hub` fans every message out to all of them
(`apps/daemon/src/hub.ts`). A late joiner gets a full snapshot on connect, so a
browser refresh never shows an empty screen (`hub.ts:33`).

---

## 2. Where "what's playing" comes from

`apps/daemon/src/index.ts:29` is the whole platform port:

```ts
private player: PlayerAdapter =
  process.platform === 'darwin' ? new MacAdapter() : new MprisAdapter();
```

- **Linux** — `players/mpris.ts` runs `playerctl --follow` with a
  tab-separated `--format` template and parses rows as they stream in. The
  separator is a literal tab character, not `\t`, because playerctl does not
  expand escape sequences in format templates (`players/mpris.ts:25`).
  playerctl reports position and length in **microseconds**, so both are
  divided by 1000 on the way in.
- **macOS** — `players/macos.ts` polls Spotify and Music through `osascript`,
  because AppleScript offers no event stream to follow.

Both adapters produce the same `PlayerState`, so nothing downstream branches on
platform. Spotify still yields a `spotify:track:` id on macOS, which means the
lyric cache keys match across both machines and a cache directory can be copied
between them.

---

## 3. The hard part: knowing where the playhead is

This is the most interesting engineering in the project, and it exists because
of a real protocol gap. **MPRIS forbids a `PropertiesChanged` signal on
`Position`**, and Spotify never emits `Seeked`. Nothing tells you the playhead
moved.

### Dead reckoning from an anchor

An *anchor* is one trusted position sample. Between anchors, the only honest
estimate is the anchor plus elapsed monotonic time (`apps/daemon/src/clock.ts`):

```ts
position = anchor.positionMs + (now - anchor.atServerMs) * anchor.rate
```

`monoNow()` is `performance.now()` — monotonic, so it never jumps when the
wall clock is corrected by NTP or a timezone change.

### Re-anchoring

Every property change, plus a 1 Hz re-read, produces a fresh reading. If it
disagrees with the projection by more than 350 ms, the user seeked (or the
player drifted) and we re-anchor:

```ts
// clock.ts:31
needsReanchor(anchor, observedMs, at, toleranceMs = 350)
```

The tolerance is what stops ordinary jitter from causing a re-anchor storm
while still catching a genuine silent seek within a second.

### Two clocks with no shared epoch

The browser's `performance.now()` and the daemon's start from different
moments, so the renderer cannot use `atServerMs` directly. It runs a miniature
NTP exchange (`apps/renderer/src/clock.ts`):

```ts
rtt    = now - clientSent
offset = serverMs - (clientSent + rtt / 2)   // assume a symmetric path
```

The sample with the **smallest round trip wins outright** rather than being
averaged in. A fast round trip is the one least distorted by scheduling;
averaging slow samples into it only adds noise. To stop one lucky early packet
pinning the estimate forever, the best-RTT bar decays and the offset drifts 2%
toward each later sample (`clock.ts:22-31`).

Pings are dense at first — every 400 ms for six — to lock the clock quickly,
then drop to a 15 s keep-alive (`apps/renderer/src/net.ts:35-42`).

### Everything reconnects

A room display has to survive the daemon restarting, the network blinking and
the machine sleeping, with nobody at the keyboard. Every failure path in
`net.ts` ends in "try again shortly", with exponential backoff capped at 8 s.

---

## 4. Getting lyrics

`apps/daemon/src/lyrics/resolver.ts` walks five providers in tier order:

| Tier | Source | Level |
|---|---|---|
| 1 | local sidecar files in `~/.local/share/lyricroom/lyrics/` | whatever you author |
| 2 | AMLL TTML DB | syllable |
| 3 | LyricsPlus / KPoe | syllable |
| 4 | lrcmux | word |
| 5 | LRCLIB | line |

Two rules make the cascade work:

- **Stop at the first word-level hit.** Nothing later in the list can improve
  on per-syllable timing, so there is no reason to keep asking.
- **Keep the best line-level result as a running fallback.** A miss at the top
  of the cascade must never cost you the safety net at the bottom
  (`resolver.ts:70`).

Ranking, when it comes to choosing between line-level candidates, is
`levelScore * 10 + confidence - tier * 0.1` — level dominates, confidence
breaks ties, tier is the last word.

### Normalising untrustworthy input

Providers disagree about almost everything, so `finalizeDoc`
(`lyrics/normalize.ts:92`) is the layer that makes their output safe to render:

- sort lines, collapse whitespace, drop empties;
- a missing or absurd `endMs` becomes "until the next line starts";
- trim overlap only between **same-voice** lines — overlapping lines are normal
  for duets and must survive;
- guarantee every line carries monotonic, non-overlapping word timings
  (`repairWords`), folding untimed glue tokens into their neighbours.

When only line timings exist, `distributeWords` shares the line's duration
**by character count** rather than equally. Character count tracks how long a
word takes to sing far better than an even split does.

### Two filters worth stealing

```ts
// normalize.ts:140
plausibleForDuration(doc, durationMs, slackMs = 15_000)
```

If a document's last line starts more than 15 s past the end of the track, it
is timed against a different master — a remix, an extended edit — and is worse
than no sync at all. Reject it.

And: player metadata is not how lyric databases index tracks. Every provider
retries with progressively simplified queries — featured artists, remaster and
edit tags and edition suffixes stripped, artist list cut to its first name —
stopping at the first hit, which keeps the common case to a single request
(`lyrics/title.ts`).

### Glyphs

`glyphs/mapper.ts` picks at most one glyph per line, for a minority of lines.
Scoring is **inverse document frequency within the song**: `log(total / freq)`,
plus a small bonus for a word near the end of the line (the rhyme). A track
that says "fire" in every line therefore gets a flame on the first one only.
A crude stemmer matches `burning`/`burned`/`burns` to `burn`, a stopword list
filters the noise, a density cap (22% of lines) and a minimum gap (3 lines)
keep them scarce.

---

## 5. The renderer: there is no timeline

This is the decision the whole visual layer rests on. No GSAP timeline, no CSS
animation, no scrub state, no accumulated tween. Every frame:

```
posMs = anchor + elapsed   →   update(posMs)   →   the whole frame, from scratch
```

`LineView.update(posMs)` (`renderer/src/type/word.ts:217`) is a **pure function
of playback position**. Seeking, pausing, skipping and tab-throttling are all
exact, because there is no animation state that could have drifted. On a
display that runs for weeks, that is the difference between working and slowly
going wrong.

The frame loop itself is nine lines (`renderer/src/main.ts:80-110`): project
the position, drive the stage, drive the scenes, draw the diagnostic overlay,
ask for the next frame.

---

## 6. How a lyric becomes a composition

Three stages, three files.

### Split — the screen holds a phrase, not a line

`layout/phrases.ts`. A lyric line is *not* the unit of display. The screen
holds two to four words. A line breaks at:

- a silence longer than 320 ms (a natural cut point),
- 4 words,
- roughly 22 characters of ink,
- a long word (7+ chars) arriving when two are already there.

Rendering a whole bar at once is exactly what makes a rap line overflow the
frame and read as a subtitle rather than as a composition.

Then `buildPhrases` does a pass the splitter cannot do alone: **each phrase is
told to leave 150 ms before the next one lands**, including across line
boundaries. A phrase is spawned ahead of its first word so it can rise into
place; without the handoff, the outgoing phrase is still at full strength when
the incoming one has finished arriving and the screen holds two whole
compositions at once. A cut has to read as a cut. The clamp never goes below a
160 ms hold — a flash is worse than an overlap.

### Lay out — one hero per phrase

`layout/engine.ts`. Every word is scored:

```ts
hold * 1.15 + length * 0.7 + rhymeBonus - weakPenalty
```

where `hold` is the word's duration **relative to the mean of its neighbours**.
That relative measure is what lets a dense rap bar and a held ballad line both
compose well — the hero is whichever word this line dwells on, not whichever
word is long in absolute terms.

There is a hard stopword blacklist (`engine.ts:34`) that runs *before* the
argmax, not as a penalty. Providers routinely stretch a trailing "a" or "the"
across a rest, and blowing that up to 25vmin breaks the look instantly. Below
the hero sit up to three supports at 0.56×, and everything else is connective
tissue at 0.34×.

Jitter — the small per-word offsets and the single tilted word — comes from an
xorshift RNG seeded with `hash(line.text)`. The same song therefore looks
identical every time it plays, which matters on an always-on display.

Rows are packed to a target width measured in hero-ems (narrower in portrait,
which is what makes a vertical display read as a deliberate lyric poster), then
alignment alternates down the stack so consecutive rows never twin.

### Fit — twice, because estimates lie

Layout sizes the type from an estimated advance width of 0.6 em per character.
Close, never exact. So `fitToFrame` (`type/word.ts:177`) measures the real
boxes once the element is in the document and shrinks if the estimate was
optimistic.

It measures the span from the first word's left edge to the last word's right
edge, not the row box — the rows are full-width flex containers and say nothing
about how much ink is actually in them.

It also reserves a 1.1× `GROWTH_BUDGET`, because the measurement is taken at
rest and the phrase never stays at rest: `update()` keeps pushing in (+3.2%
over its life) and each word overshoots on entry (+2.4%). Fitting to the
resting size and letting those run on top is precisely how a hero word sized at
the ceiling used to crawl off the frame *after* landing.

### Reveal as sung

`type/word.ts`. Each word arrives a moment before its own vocal, 110 to 210 ms
depending on the song's motion preset, and lands in the slot the layout
already gave it. The composition is computed for the whole phrase up front, so
nothing reflows as it fills in; the frame builds the way the reel does, one
word at a time. Words sung almost together still cascade at least 40 ms apart,
so a fast run reads as a gesture rather than a block.

Entry durations follow the element's weight: hero 180 ms, support 150 ms,
connective 120 ms, all `power4Out`, with near-binary opacity, so a word is
either arriving or there and never a ghost. The karaoke sweep inside a word is
the same ink at 72% brightening to 100% behind a soft 0.18 em feather. It
brightens as it is sung; it never greys.

In Cinema the hero is split into letters. They rise 16 ms apart and light
one by one as the sweep passes. A word held for a second or more gets the Apple
Music Sing "undulate", using AMLL's emphasis numbers: letters swell up to 10%,
fan out from the centre and lift, the ripple travels through the word, and the
last word of a line gets 1.6x. A variable hero face (Fraunces, Bricolage) also
swells in weight across the hold, with its box locked at the heaviest weight in
`fitToFrame` so the swell cannot shove its neighbours along the row.

Words land clean, with no trailing copies on the way in. Per-word echo
trails were tried and read as stamped duplicates, not motion.

### Seams: how one phrase hands to the next

The exit of one phrase and the entry of the next are one object, a `Seam`, so
they always agree on axis and direction (the vector law from the motion
skills): `up` or `left` travel, `push` (Z forward: the old phrase grows past
the camera, the next grows in from 0.75), `pull` (Z back: the old shrinks away,
the next lands from 1.25), or a rare `rack` focus cut. Push pairs with push and
pull with pull, so a receding phrase is never followed by one growing in from
small.

`SceneDirector.rebuildPlan` (`scenes.ts`) decides every seam up front from the
phrase list and the song's sections: the song's current for ordinary cuts,
`pull` for the first phrase of a chorus ("something bigger lands"), `push`
through the rest of a chorus, and at most one `rack` every 8 s on line
boundaries for calm songs. Because it is planned rather than chained at spawn
time, seeking into the middle of a song produces exactly the frame playing
through to it would have.

**The smear.** A leaving phrase travels along its seam, and 2 (Smooth) to 4
(Cinema) ghost copies trail it, each 4.5% of the exit further behind, so they
overlap into one soft streak. A ghost is never brighter than the phrase was at
the point it trails, and it tops out at 30% of that. Spaced wider and brighter,
they read as a row of stamps, which looks like dropped frames. Ghosts are cloned once when the
exit starts, and in Cinema each ghost word carries a small static blur.
Blurring small word boxes once is cheap; animating a filter on a full-frame
layer is what would cost a 4K frame. The exit always renders from the phrase's
end-of-line state, so a seek straight into an exit is exact too.

**Stillness before the climax.** When a chorus follows a gap of 0.4 to 3 s, the
last phrase before it is held through the gap while the stage dims 20%, then
leaves just as the chorus lands on the `pull` seam. That is one planned edit to
phrase timing, still a pure function of position.

### Degrading honestly

When word timings were interpolated from line spans, `SceneDirector` drops the
view to `'lite'` quality: the phrase cascades in as one piece at its line start
instead of waiting on guessed word times, and trails, letter splits and
emphasis come off. Aggressive per-word animation on guessed timings just
advertises the error.

---

## 7. The background: a shader stage

`renderer/src/stage/gl.ts`, `stage/shaders.ts`, `stage.ts`.

A hand-rolled WebGL2 stage: one look rendered into a small target (960x540 in
Cinema, 480x270 in Smooth), then one post pass at panel size for
vignette, dithering, chromatic aberration on hits (Cinema), and the
scrim that keeps huge type legible. The looks are soft by design, so the low
internal resolution costs nothing you can see and is the whole reason this is
cheap at 4K. The post pass replaced three DOM layers (scrim, grain, vignette); there is no film grain now, so the frame stays clean.

| Look | What it is | Picked for |
|---|---|---|
| `aureole` | The album art as a soft layered field: copies of the processed cover at three sizes, each turned a little and drifting over minutes, no spin or twist | the default, "even" songs |
| `smoke` | Inigo Quilez domain-warped fbm in the palette, lit by a travelling light | dark, slow songs; heartbreak |
| `liquid-ink` | Stable fluids (after PavelDoGreat, MIT) at 128 px sim / 512 px dye, splatted on kicks and hero landings; Smooth fakes it with advected blobs | intense songs; water |
| `night-city` | A dark plate with bokeh at three depths and a light streak on the kick | night, city, money |
| `sunlit` | A warm field with big soft light leaks, god rays in Cinema | bright songs; fire, summer |

The cover is processed the way AMLL does it: shrunk to 64 px, oversaturated,
contrasted and pre-blurred on a 2D canvas, so bilinear sampling upscales it
cleanly. With no cover, a soft arrangement of the palette stands in.

**Light spill.** In Cinema the landed hero word is drawn once, blurred, into a
small mask, and the post pass adds it to the stage as light in the accent
colour, so the word sits in a pool of its own glow at no DOM filter cost.

The palette is still pulled from a 32x32 downsample (`palette.ts`), now as five
swatches for the shader plus the CSS custom properties the type uses. The
song's mood grades it: warmer and more saturated for bright, intense songs,
cooler and quieter for sad, calm ones. The cover stays the source; the grade
only leans on it. Palette and art changes cross-fade over about a second.

Everything uploaded to the GPU is kept CPU-side too, so `webglcontextrestored`
rebuilds the stage from scratch. On a display that runs for weeks the context
will be lost at some point. With no WebGL2 at all, the original 64 px canvas
treatment still runs.

The art is still proxied onto the daemon's origin at `/art/`, because a
cross-origin image taints the canvas and `getImageData` throws.

---

## 8. Audio reactivity and the beat

Chrome on Linux cannot capture a PipeWire monitor through `getUserMedia` or
`getDisplayMedia` at all, so the spectrum has to come from outside the browser
(`daemon/src/audio/spectrum.ts`):

```
pw-record (stream.capture.sink=true -> default sink's monitor) -> f32 mono @ 44.1k
  -> non-finite samples zeroed (a paused monitor can deliver NaN)
  -> 2048-point FFT (audio/fft.ts, hand-rolled radix-2 Cooley-Tukey, no deps)
  -> 24 log-spaced bands, 30 Hz .. 14 kHz
  -> dB-ish compression: (20*log10(mag) + 70) / 70
  -> beat tracker (raw frames)  +  fast attack / slow release (for the eye)
  -> 60 Hz over the socket
```

`audio/beat.ts` works on the raw per-hop frames, before the visual smoothing
blunts the edges:

- **Onsets** by SuperFlux (Böck & Widmer): positive spectral flux against the
  max of each band's neighbours in the previous frame, which stops vibrato
  reading as hits. Kick, snare and hat are separate band groups. Peaks are
  picked against an adaptive mean + 1.5 sigma threshold with a refractory
  period per group.
- **Tempo** by autocorrelating ~7 s of kick+snare onset strength over 60 to 180
  BPM, weighted towards 120 BPM so it does not lock onto half or double time,
  then a median over the last five estimates.
- **A beat clock** that free-runs at the tempo and is pulled towards each
  kick, so the renderer can predict the beat.
- **Envelopes**: hits are instant and release over ~180 ms; `energy` is a slow
  level relative to what this song has done so far, so a drop reads as a drop
  in a quiet song and a loud one alike.

Mapping stays tasteful: no equaliser bars, no strobes. Kicks splat ink and
flash the night-city streak, energy and chorus-ness speed the look's own
clock, bass lifts the hero glow. The whole feature is decorative and optional;
without `pw-record` the visuals run without reactivity, and the renderer reads
any non-finite value as silence.

---

## 9. What a song is about: the profile

`daemon/src/lyrics/mood.ts` and `packages/shared/src/structure.ts`. Offline and
lexicon-based on purpose, so no network call and no model:

- **Valence**, -1 to 1, from VADER (negation and intensifier aware) blended
  with AFINN-165, per line.
- **Arousal**, 0 to 1, from words per second, a small high/low arousal word
  list, exclamation and caps, and repetition. A 4 words/s rap verse is intense
  whatever it says.
- **Themes**: the top clusters (love, heartbreak, money, night, fire, water,
  party, faith, road, nature), counted by lines that mention them, using the
  glyph mapper's stemmer.
- **Sections**: TTML part labels when the provider has them, including
  LyricsPlus's `{ name, time }` objects. Otherwise repetition: a run of two or
  more repeated lines is a chorus, and new material between the second and
  last chorus is the bridge.

The renderer turns that into a `Theme` (`renderer/src/theme.ts`), the way the
Cotodama Lyric Speaker does: intense songs get the **Slam** preset (Anton or
League Gothic, oversized punch-in arrivals, leftward travel, 4-copy smear);
dark slow songs get **Calm** (Fraunces with its weight swell, Instrument Serif
italic supports, slow rise, rack-focus cuts); bright songs get **Kinetic**
(Archivo Black or Bricolage with italic serif supports). The themes pick the
look. Choruses get bigger type, more glow, the accent on the inverted box, a
faint oversized echo of the hero behind the phrase, and one slow camera push
per section. Instrumental gaps of 4 s or more get Apple Music's breathing
dots, timed to the beat clock. The phone remote and the `l` and `p` keys can
pin any part of it.

---

## 10. Render tiers

`renderer/src/quality.ts`. **Cinema** is the full look: full-res post pass,
fluid ink, god rays, letter-split heroes, 4-copy blurred smear, light spill,
chromatic aberration, echo layout and background-vocal layer. **Smooth** holds
60 fps on integrated graphics: half-res post, a 30 Hz background, 2 unblurred
ghosts, no letter split, no DOM blur anywhere, a static glow.

The daemon stores the choice (`settings.json`) and every surface follows it.
`auto` is resolved per display, because only the machine drawing knows how
fast it is: the first run renders the heaviest look for about four seconds,
measures frame intervals and GPU time, and caches the verdict per screen and
GPU in `localStorage`.

---

## 11. Scenes and control

`SceneDirector.resolveMode` (`scenes.ts:108`) picks what should be on screen:

| Condition | Scene |
|---|---|
| word-level timings | `word` |
| interpolated timings | `line` (calmer motion) |
| no usable lyrics | `art` (the now-playing card) |
| no track, or paused > 20 s | `idle` |

A manual mode from the keyboard or the phone overrides the lot.

Sync corrections are per track and persist: `[` `]` nudge 100 ms, `,` `.` nudge
1 s, and the daemon writes the result to `offsets.json`
(`lyrics/offsets.ts`). The renderer applies the offset by subtracting it from
the position it feeds `updateLines` — one number, one place.

`r` re-resolves lyrics ignoring the cache; `n` adds the currently winning
provider to a skip set and re-runs the cascade, wrapping around when everything
has been skipped (`index.ts:167-172`).

---

## 12. Iterating on it

```bash
npm run dev
```

- `http://localhost:5173/?fixture=1` — demo content on a loop, no daemon, no
  music, no network.
- `http://localhost:5173/?fixture=1&t=7200` — pins the playhead at 7.2 s and
  holds it there.
- `&look=smoke&preset=slam&tier=smooth` pins the look, the motion and the tier.
  The fixture carries a repeated chorus, a pre-chorus gap (stillness), an
  instrumental gap (breathing dots) and an ad-lib (background vocals).

The pinned mode is only possible *because* rendering is a pure function of
position, and it is the fastest way to see what the layout engine decided for a
given phrase.

```bash
npm run daemon:now   # track, winning provider tier, word under the playhead
npm test             # parsers, timing, phrases, structure, mood, beat tracking
npm run typecheck
```

The diagnostic rule of thumb: if the word under the playhead is **right but
early or late**, it is an offset problem — nudge it. If the word is **wrong**,
it is a data problem — press `n` for the next source.

---

## The ideas worth taking elsewhere

1. **Dead reckon, then re-anchor on disagreement.** The right answer whenever a
   source of truth cannot push you updates.
2. **Lowest-RTT wins, don't average.** For clock sync, the least-delayed sample
   is the most accurate one; averaging dilutes it.
3. **Make rendering a pure function of position.** It costs you nothing and
   deletes an entire category of drift and scrub bugs.
4. **Reject implausible data outright.** A lyric document timed against the
   wrong edit is worse than no lyrics.
5. **Let the output admit its own confidence.** Interpolated timings get calmer
   motion, because confident animation on a guess advertises the error.
6. **Do expensive visual work at the smallest resolution that still looks
   right.** A 64px blur scaled up is indistinguishable from a 4K one.
7. **Seed randomness from content.** Deterministic jitter means the same input
   always looks the same, which is what separates "designed" from "random".
8. **Plan transitions as shared seams, not chained state.** When the exit of one
   thing and the entry of the next are one object decided up front, they can
   never disagree, and seeking stays exact.
9. **Never let one frame kill the loop.** The renderer requests its next frame
   before drawing this one and catches anything that throws.
