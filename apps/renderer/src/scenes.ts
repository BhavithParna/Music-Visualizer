import type { LyricDoc, NowPlaying, SceneMode } from '@lyricroom/shared';
import { layoutLine } from './layout/engine.js';
import { buildPhrases, type Phrase } from './layout/phrases.js';
import { LineView } from './type/word.js';

/** How long the stage stays dark after playback stops before it becomes idle. */
const IDLE_AFTER_MS = 20_000;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

interface LineMeta {
  /** Words per second, used to size the hero: dense rap vs. held ballad. */
  intensity: number;
  invert: boolean;
  glyph?: string;
}

export class SceneDirector {
  private typeEl = document.getElementById('type') as HTMLElement;
  private cardEl = document.getElementById('card') as HTMLElement;

  private doc: LyricDoc | null = null;
  private phrases: Phrase[] = [];
  private meta: LineMeta[] = [];
  private offsetMs = 0;
  private track: NowPlaying | null = null;
  private glyphs: Record<number, string> = {};

  private views = new Map<string, LineView>();
  private lastExit = { x: 0, y: 1 };
  private mode: SceneMode | 'auto' = 'auto';
  private pausedSince: number | null = null;
  private portrait = window.innerHeight > window.innerWidth;
  /** Rebuild the composition when the viewport changes shape. */
  private layoutEpoch = 0;

  constructor() {
    window.addEventListener('resize', () => {
      this.portrait = window.innerHeight > window.innerWidth;
      this.layoutEpoch += 1;
      this.clearViews();
    });
  }

  setTrack(track: NowPlaying | null): void {
    if (track?.trackKey !== this.track?.trackKey) {
      this.clearViews();
      this.doc = null;
      this.phrases = [];
      this.meta = [];
      this.glyphs = {};
    }
    this.track = track;
    this.renderCard();
  }

  setLyrics(doc: LyricDoc | null, offsetMs: number): void {
    this.doc = doc;
    this.offsetMs = offsetMs;
    this.clearViews();
    this.meta = doc ? this.buildMeta(doc) : [];
    this.phrases = doc ? buildPhrases(doc.lines) : [];
  }

  setGlyphs(glyphs: Record<number, string>): void {
    this.glyphs = glyphs;
    if (this.doc) this.meta = this.buildMeta(this.doc);
    this.clearViews();
  }

  setMode(mode: SceneMode | 'auto'): void {
    this.mode = mode;
    this.clearViews();
  }

  setOffset(offsetMs: number): void {
    this.offsetMs = offsetMs;
  }

  get currentOffset(): number {
    return this.offsetMs;
  }

  private buildMeta(doc: LyricDoc): LineMeta[] {
    // Invert one line in roughly eight, chosen deterministically so the same
    // song always emphasises the same hooks.
    return doc.lines.map((line, i) => {
      const span = Math.max(250, line.endMs - line.startMs) / 1000;
      const density = line.words.length / span;
      const meta: LineMeta = {
        intensity: Math.max(0, Math.min(1, (density - 1.1) / 3.2)),
        invert: !line.background && hash(line.text) % 8 === 0 && line.text.length > 3,
      };
      const glyph = this.glyphs[i];
      if (glyph) meta.glyph = glyph;
      return meta;
    });
  }

  /** Which scene should be on screen right now. */
  resolveMode(playing: boolean, now: number): SceneMode {
    if (this.mode !== 'auto') return this.mode;

    if (!playing) {
      this.pausedSince ??= now;
      if (now - this.pausedSince > IDLE_AFTER_MS) return 'idle';
    } else {
      this.pausedSince = null;
    }

    if (!this.track) return 'idle';
    if (!this.doc || this.doc.level === 'unsynced' || this.doc.level === 'none') return 'art';
    return this.doc.wordsInterpolated ? 'line' : 'word';
  }

  frame(posMs: number, playing: boolean, now: number): SceneMode {
    const mode = this.resolveMode(playing, now);

    if (mode === 'word' || mode === 'line') {
      this.cardEl.classList.remove('on');
      this.cardEl.hidden = true;
      this.typeEl.style.display = '';
      this.updateLines(posMs - this.offsetMs, mode);
    } else {
      this.clearViews();
      this.typeEl.style.display = 'none';
      if (mode === 'art') {
        this.cardEl.hidden = false;
        // Next frame so the transition actually runs.
        requestAnimationFrame(() => this.cardEl.classList.add('on'));
      } else {
        this.cardEl.classList.remove('on');
      }
    }
    return mode;
  }

  private updateLines(posMs: number, mode: SceneMode): void {
    if (!this.phrases.length) return;

    for (const phrase of this.phrases) {
      const key = `${phrase.lineIndex}:${phrase.phraseIndex}`;
      if (this.views.has(key)) continue;
      if (posMs < phrase.startMs - 400) continue;
      if (posMs > phrase.endMs + 250) continue;

      const meta = this.meta[phrase.lineIndex] ?? { intensity: 0.5, invert: false };
      const laid = layoutLine(phrase, {
        portrait: this.portrait,
        intensity: meta.intensity,
        // The hook treatment and the glyph belong to the line, so only the
        // phrase that carries them gets them -- never every phrase in the bar.
        ...(meta.invert && phrase.carriesGlyph ? { invert: true } : {}),
        ...(meta.glyph && phrase.carriesGlyph ? { glyph: meta.glyph } : {}),
      });
      const view = new LineView(phrase, laid, {
        enterFrom: this.lastExit,
        // Interpolated timings are a guess, so the motion stays calmer and the
        // trails come off -- aggressive per-word motion would advertise the error.
        quality: mode === 'line' ? 'lite' : 'high',
      });
      this.lastExit = view.exitVector;
      this.typeEl.appendChild(view.el);
      // Measure now that it is in the document; estimated widths are never
      // exact and a bar that overflows the frame is the worst failure there is.
      view.fitToFrame(this.typeEl);
      this.views.set(key, view);
    }

    for (const [key, view] of this.views) {
      if (!view.update(posMs)) {
        view.destroy();
        this.views.delete(key);
      }
    }
  }

  private renderCard(): void {
    const track = this.track;
    if (!track) {
      this.cardEl.innerHTML = '';
      return;
    }
    const cover = track.artUrl
      ? `<img class="cover" src="${escapeAttr(track.artUrl)}" alt="" />`
      : '<div class="cover"></div>';
    this.cardEl.innerHTML =
      `${cover}<div class="ct">${escapeHtml(track.title)}</div>` +
      `<div class="ca">${escapeHtml(track.artist)}</div>` +
      `<div class="cn">${escapeHtml(track.album ?? '')}</div>`;
  }

  private clearViews(): void {
    for (const view of this.views.values()) view.destroy();
    this.views.clear();
  }

  get activeLineCount(): number {
    return this.views.size;
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
const escapeAttr = escapeHtml;
