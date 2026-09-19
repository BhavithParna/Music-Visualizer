import type { LyricLine } from '@lyricroom/shared';
import type { LaidLine, LaidWord } from '../layout/engine.js';
import { backOut, clamp01, power2In, power4Out } from './ease.js';

/** How long before a word is sung it starts arriving. */
const LEAD_MS = 150;
const IN_MS = 120;
/** Per-copy delay of the echo trail. This temporal lag is what reads as motion. */
const ECHO_LAG_MS = 55;
const ECHO_COUNT = 4;
const OUT_MS = 190;
const GLYPH_DELAY_MS = 80;
const GLYPH_MS = 260;

interface WordView {
  el: HTMLElement;
  face: HTMLElement;
  echoes: HTMLElement[];
  box: HTMLElement | null;
  glyph: HTMLElement | null;
  laid: LaidWord;
  startMs: number;
  endMs: number;
  /** Cached DOM values so a frame that changes nothing writes nothing. */
  last: { t: string; o: string; b: string; p: string };
}

/** Write only when the value actually changed; style writes are the expensive part. */
function setStyle(el: HTMLElement, prop: 'transform' | 'opacity' | 'filter', value: string, cache: Record<string, string>, key: string): void {
  if (cache[key] === value) return;
  cache[key] = value;
  if (prop === 'transform') el.style.transform = value;
  else if (prop === 'opacity') el.style.opacity = value;
  else el.style.filter = value;
}

export interface LineViewOptions {
  /** Direction the previous line exited, so this line enters along the same vector. */
  enterFrom?: { x: number; y: number };
  quality?: 'high' | 'lite';
}

/**
 * One lyric line, rendered as DOM and driven entirely by the playback clock.
 *
 * There is no timeline object: `update(posMs)` computes the whole frame from
 * the position alone. That is what makes seeking, pausing and skipping exact --
 * a timeline would have to be scrubbed and could drift; this cannot.
 */
export class LineView {
  readonly el: HTMLElement;
  private views: WordView[] = [];
  private lineStart: number;
  private lineEnd: number;
  private exitVec = { x: 0, y: -1 };
  private quality: 'high' | 'lite';

  constructor(line: LyricLine, laid: LaidLine, opts: LineViewOptions = {}) {
    this.lineStart = line.startMs;
    this.lineEnd = line.endMs;
    this.quality = opts.quality ?? 'high';

    const root = document.createElement('div');
    root.className = 'line';
    root.style.fontSize = `${laid.baseSize.toFixed(3)}vmin`;
    root.style.display = 'flex';
    root.style.flexDirection = 'column';
    root.style.gap = '0.02em';
    if (line.background) root.style.opacity = '0.62';

    for (const row of laid.rows) {
      const rowEl = document.createElement('div');
      rowEl.className = 'row';
      rowEl.dataset['align'] = row.align;

      for (const laidWord of row.words) {
        const src = line.words[laidWord.index];
        const startMs = src?.startMs ?? line.startMs;
        const endMs = Math.max(src?.endMs ?? line.endMs, startMs + 60);

        const el = document.createElement('span');
        el.className = 'word';
        el.dataset['tier'] = laidWord.tier;
        el.style.fontSize = `${laidWord.scale}em`;
        if (laidWord.invert) el.dataset['invert'] = '1';

        const echoes: HTMLElement[] = [];
        // Echoes only on the words that carry the frame; on every word it is mud.
        if (laidWord.tier !== 'connective' && this.quality === 'high') {
          for (let i = 0; i < ECHO_COUNT; i += 1) {
            const echo = document.createElement('span');
            echo.className = i % 2 === 1 ? 'echo outline' : 'echo';
            echo.textContent = laidWord.text;
            echo.style.opacity = '0';
            el.appendChild(echo);
            echoes.push(echo);
          }
        }

        let box: HTMLElement | null = null;
        if (laidWord.invert) {
          box = document.createElement('span');
          box.className = 'box';
          box.style.transform = 'scaleX(0)';
          el.appendChild(box);
        }

        const face = document.createElement('span');
        face.className = 'face sweep';
        face.textContent = laidWord.text;
        face.style.setProperty('--p', '0%');
        el.appendChild(face);

        let glyph: HTMLElement | null = null;
        if (laidWord.glyph) {
          glyph = document.createElement('span');
          glyph.className = 'glyph';
          glyph.textContent = laidWord.glyph;
          glyph.style.opacity = '0';
          el.appendChild(glyph);
        }

        rowEl.appendChild(el);
        this.views.push({
          el, face, echoes, box, glyph, laid: laidWord, startMs, endMs,
          last: { t: '', o: '', b: '', p: '' },
        });
      }
      root.appendChild(rowEl);
    }

    this.el = root;

    // Enter along the vector the previous line left on, so the film keeps moving
    // in one direction instead of resetting between lines.
    const from = opts.enterFrom ?? { x: 0, y: 1 };
    this.exitVec = { x: -from.x, y: -from.y };
    root.dataset['ex'] = `${this.exitVec.x},${this.exitVec.y}`;
    this.enterVec = from;
  }

  private enterVec: { x: number; y: number };

  /** Where this line will push the next one. */
  get exitVector(): { x: number; y: number } {
    return this.exitVec;
  }

  get startsAt(): number {
    return this.lineStart - LEAD_MS;
  }

  get endsAt(): number {
    return this.lineEnd + OUT_MS;
  }

  /**
   * Render the frame at `posMs`. Returns false once the line is fully gone,
   * which is the caller's cue to drop it.
   */
  update(posMs: number): boolean {
    const exitT = clamp01((posMs - this.lineEnd) / OUT_MS);
    if (exitT >= 1) return false;

    // Whole-line exit: scale up and blur out along the exit vector.
    if (exitT > 0) {
      const e = power2In(exitT);
      const tx = this.exitVec.x * e * 5;
      const ty = this.exitVec.y * e * 5;
      this.el.style.transform = `translate3d(${tx.toFixed(2)}%, ${ty.toFixed(2)}%, 0) scale(${(1 + e * 0.06).toFixed(4)})`;
      this.el.style.opacity = (1 - e).toFixed(3);
      if (this.quality === 'high') {
        const blur = Math.round(e * 14);
        this.el.style.filter = blur > 0 ? `blur(${blur}px)` : '';
      }
      return true;
    }
    if (this.el.style.transform) {
      this.el.style.transform = '';
      this.el.style.opacity = '';
      this.el.style.filter = '';
    }

    for (const view of this.views) {
      this.updateWord(view, posMs);
    }
    return true;
  }

  private updateWord(view: WordView, posMs: number): void {
    const { laid, startMs, endMs, last } = view;

    const inT = clamp01((posMs - (startMs - LEAD_MS)) / IN_MS);
    const e = power4Out(inT);

    // Entry: rise along the shared vector, settle to the laid-out offset.
    const riseX = this.enterVec.x * (1 - e) * 0.55 + laid.dx * e;
    const riseY = this.enterVec.y * (1 - e) * 0.62 + laid.dy * e;
    const scale = 0.86 + 0.14 * e;
    const rot = laid.rotate * e;

    const transform =
      `translate3d(${riseX.toFixed(3)}em, ${riseY.toFixed(3)}em, 0) ` +
      `scale(${scale.toFixed(4)})` +
      (rot ? ` rotate(${rot.toFixed(2)}deg)` : '');
    setStyle(view.el, 'transform', transform, last, 't');
    setStyle(view.el, 'opacity', e.toFixed(3), last, 'o');

    // Entry blur, quantised so the filter string rarely changes.
    if (this.quality === 'high') {
      const size = laid.tier === 'hero' ? 18 : 10;
      const blur = Math.round((1 - e) * size);
      setStyle(view.face, 'filter', blur > 0 ? `blur(${blur}px)` : '', last, 'b');
    }

    // Karaoke sweep across the glyphs while the word is being sung.
    const sweep = clamp01((posMs - startMs) / Math.max(1, endMs - startMs));
    const pct = `${(sweep * 100).toFixed(1)}%`;
    if (last.p !== pct) {
      last.p = pct;
      view.face.style.setProperty('--p', pct);
    }

    // Echo trail: each copy replays the entry a few frames late and collapses in.
    for (let i = 0; i < view.echoes.length; i += 1) {
      const echo = view.echoes[i]!;
      const lagT = clamp01((posMs - (startMs - LEAD_MS) - (i + 1) * ECHO_LAG_MS) / IN_MS);
      const le = power4Out(lagT);
      const spread = (1 - le) * 0.9 + 0.055;
      const ox = this.enterVec.x * spread * (i + 1) * 0.3;
      const oy = this.enterVec.y * spread * (i + 1) * 0.34;
      const es = 1 + (i + 1) * 0.035 * (1 - le) + (i + 1) * 0.012;
      echo.style.transform =
        `translate3d(${ox.toFixed(3)}em, ${oy.toFixed(3)}em, 0) scale(${es.toFixed(4)})`;
      echo.style.opacity = (lagT <= 0 ? 0 : (0.34 - i * 0.07) * le).toFixed(3);
    }

    // Inverted hook: the box wipes open before the dark type arrives.
    if (view.box) {
      const boxT = clamp01((posMs - (startMs - LEAD_MS)) / 90);
      view.box.style.transform = `scaleX(${power4Out(boxT).toFixed(4)})`;
    }

    // Glyph pops after its word has landed, never with it.
    if (view.glyph) {
      const gT = clamp01((posMs - (startMs + GLYPH_DELAY_MS)) / GLYPH_MS);
      const gb = backOut(gT);
      view.glyph.style.opacity = gT <= 0 ? '0' : Math.min(1, gT * 2.6).toFixed(3);
      view.glyph.style.transform = `scale(${gb.toFixed(3)}) rotate(${((1 - gb) * -8).toFixed(2)}deg)`;
    }
  }

  destroy(): void {
    this.el.remove();
  }
}
