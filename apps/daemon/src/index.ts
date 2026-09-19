import type { LyricDoc, NowPlaying, SceneMode, ServerMsg } from '@lyricroom/shared';
import { PORT } from './config.js';
import { makeAnchor } from './clock.js';
import { MprisAdapter } from './players/mpris.js';
import type { PlayerAdapter, PlayerState } from './players/types.js';
import { resolveLyrics, PROVIDERS } from './lyrics/resolver.js';
import { getOffset, nudgeOffset, flush as flushOffsets } from './lyrics/offsets.js';
import { mapGlyphs } from './glyphs/mapper.js';
import { cacheArt } from './art.js';
import { createHttpServer } from './server.js';
import { Hub, lyricsMsg, nowPlayingMsg } from './hub.js';
import { remoteHtml } from './remote.js';
import { startSpectrum, type SpectrumHandle } from './audio/spectrum.js';

interface TrackContext {
  track: NowPlaying;
  doc: LyricDoc | null;
  offsetMs: number;
  glyphs: Record<number, string>;
  /** Providers the user has skipped past for this track, via "next source". */
  skipped: Set<string>;
  artPath?: string;
}

class Daemon {
  private player: PlayerAdapter = new MprisAdapter();
  private hub!: Hub;
  private ctx: TrackContext | null = null;
  private state: PlayerState = { track: null, anchor: makeAnchor(0, 'stopped') };
  private mode: SceneMode | 'auto' = 'auto';
  private resolveSeq = 0;
  private spectrum: SpectrumHandle | null = null;

  async start(): Promise<void> {
    const server = createHttpServer({
      state: () => ({
        track: this.state.track,
        anchor: this.state.anchor,
        mode: this.mode,
        lyrics: this.ctx?.doc
          ? {
              level: this.ctx.doc.level,
              provider: this.ctx.doc.provider,
              lines: this.ctx.doc.lines.length,
              interpolated: this.ctx.doc.wordsInterpolated,
            }
          : null,
        offsetMs: this.ctx?.offsetMs ?? 0,
        clients: this.hub?.size ?? 0,
      }),
      remoteHtml: async () => remoteHtml(),
    });

    this.hub = new Hub(server, {
      onNudge: (trackKey, delta) => void this.nudge(trackKey, delta),
      onControl: (action) => void this.control(action),
      onSetMode: (mode) => {
        this.mode = mode;
        this.hub.broadcast({ type: 'mode', mode });
      },
      snapshot: () => this.snapshot(),
    });

    this.player.onState((s) => void this.onPlayerState(s));
    await this.player.start();

    this.spectrum = startSpectrum((bands, bass, atServerMs) => {
      if (this.hub.size > 0) this.hub.broadcast({ type: 'spectrum', bands, bass, atServerMs });
    });

    await new Promise<void>((resolve) => server.listen(PORT, resolve));
    console.log(`[lyricroom] http://localhost:${PORT}  (remote: /remote)`);
  }

  private snapshot(): ServerMsg[] {
    const out: ServerMsg[] = [
      nowPlayingMsg(this.state.track, this.state.anchor),
      { type: 'mode', mode: this.mode },
    ];
    if (this.ctx) {
      out.push(lyricsMsg(this.ctx.track.trackKey, this.ctx.doc, this.ctx.offsetMs));
      out.push({ type: 'glyphs', trackKey: this.ctx.track.trackKey, glyphs: this.ctx.glyphs });
    }
    return out;
  }

  private async onPlayerState(s: PlayerState): Promise<void> {
    const prevKey = this.state.track?.trackKey;
    this.state = s;

    if (s.track && s.track.artUrl && this.ctx?.track.trackKey === s.track.trackKey && !this.ctx.artPath) {
      void this.attachArt(s.track);
    }

    // Transport-only change: re-anchor the clients, keep the lyric document.
    if (s.track?.trackKey === prevKey) {
      this.hub.broadcast({ type: 'anchor', anchor: s.anchor });
      return;
    }

    this.hub.broadcast(nowPlayingMsg(s.track, s.anchor));
    if (!s.track) {
      this.ctx = null;
      return;
    }
    await this.loadTrack(s.track);
  }

  private async attachArt(track: NowPlaying): Promise<void> {
    if (!track.artUrl) return;
    const name = await cacheArt(track.artUrl);
    if (!name || this.ctx?.track.trackKey !== track.trackKey) return;
    this.ctx.artPath = `/art/${name}`;
    const withArt: NowPlaying = { ...track, artUrl: `/art/${name}` };
    this.ctx.track = withArt;
    this.hub.broadcast(nowPlayingMsg(withArt, this.state.anchor));
  }

  private async loadTrack(track: NowPlaying, opts: { force?: boolean; skip?: Set<string> } = {}): Promise<void> {
    const seq = ++this.resolveSeq;
    const skipped = opts.skip ?? new Set<string>();
    const offsetMs = await getOffset(track.trackKey);
    this.ctx = { track, doc: null, offsetMs, glyphs: {}, skipped };

    void this.attachArt(track);

    const resolveOpts: Parameters<typeof resolveLyrics>[1] = {};
    if (opts.force) resolveOpts.force = true;
    if (skipped.size) resolveOpts.skip = skipped;

    const doc = await resolveLyrics(track, resolveOpts);
    // A newer track started while we were fetching; drop this result.
    if (seq !== this.resolveSeq || this.ctx?.track.trackKey !== track.trackKey) return;

    this.ctx.doc = doc;
    this.ctx.glyphs = doc ? mapGlyphs(doc) : {};
    this.hub.broadcast(lyricsMsg(track.trackKey, doc, offsetMs));
    this.hub.broadcast({ type: 'glyphs', trackKey: track.trackKey, glyphs: this.ctx.glyphs });

    const label = doc ? `${doc.level} via ${doc.provider} (${doc.lines.length} lines)` : 'no lyrics';
    console.log(`[lyricroom] ${track.artist} - ${track.title}: ${label}`);
  }

  private async nudge(trackKey: string, deltaMs: number): Promise<void> {
    const next = await nudgeOffset(trackKey, deltaMs);
    if (this.ctx?.track.trackKey === trackKey) {
      this.ctx.offsetMs = next;
      this.hub.broadcast(lyricsMsg(trackKey, this.ctx.doc, next));
    }
  }

  private async control(action: 'playpause' | 'next' | 'previous' | 'reloadLyrics' | 'nextProvider'): Promise<void> {
    if (action === 'playpause' || action === 'next' || action === 'previous') {
      await this.player.control(action);
      return;
    }
    const track = this.ctx?.track;
    if (!track) return;
    if (action === 'reloadLyrics') {
      await this.loadTrack(track, { force: true });
      return;
    }
    // nextProvider: skip whichever provider is currently winning and re-run.
    const skip = new Set(this.ctx?.skipped ?? []);
    const current = this.ctx?.doc?.provider.split(':')[0];
    if (current) skip.add(current);
    if (skip.size >= PROVIDERS.length) skip.clear();
    await this.loadTrack(track, { force: true, skip });
  }

  async stop(): Promise<void> {
    await this.player.stop();
    this.spectrum?.stop();
    await flushOffsets();
  }
}

const daemon = new Daemon();
await daemon.start();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void daemon.stop().finally(() => process.exit(0));
  });
}
