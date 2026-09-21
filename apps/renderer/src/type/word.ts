import type { LyricLine } from '@lyricroom/shared';
import type { LaidLine, LaidWord } from '../layout/engine.js';
import { backOut, clamp01, power2In, power4Out } from './ease.js';

/** How long before its phrase is sung the composition starts arriving. */
const LEAD_MS = 200;
const IN_MS = 260;
/** Cascade between words of the same phrase. Small enough to read as one gesture. */
const STAGGER_MS = 52;
/** Per-copy delay of the echo trail. This temporal lag is what reads as motion. */
const ECHO_LAG_MS = 48;
const ECHO_COUNT = 4;
const OUT_MS = 220;
const GLYPH_DELAY_MS = 110;
const GLYPH_MS = 320;

interface WordView {
  el: HTMLElement;
  face: HTMLElement;
  echoes: HTMLElement[];
  box: HTMLElement | null;
  glyph: HTMLElement | null;
  laid: LaidWord;
  /** When this word's entry begins: phrase-anchored, not word-anchored. */
  enterAt: number;
  /** Real sung timing, which drives the sweep only. */
  startMs: number;
  endMs: number;
  last: { t: string; o: string; b: string; p: string };
}

function setStyle(
  el: HTMLElement,
  prop: 'transform' | 'opacity' | 'filter',
  value: string,
  cache: Record<string, string>,
  key: string,
): void {
  if (cache[key] === value) return;
  cache[key] = value;
  if (prop === 'transform') el.style.transform = value;
  else if (prop === 'opacity') el.style.opacity = value;
  else el.style.filter = value;
}

export interface LineViewOptions {
  /** Direction the previous phrase exited, so this one enters along that vector. */
  enterFrom?: { x: number; y: number };
  quality?: 'high' | 'lite';
}

/**
 * One phrase -- two to four words -- rendered as DOM and driven entirely by the
 * playback clock.
 *
 * There is no timeline object: `update(posMs)` computes the whole frame from
 * the position alone, which is what makes seeking, pausing and skipping exact
 * on a display that runs for weeks.
 *
 * Entry is anchored to the PHRASE, not to each word: the whole composition
 * cascades in together, and the karaoke sweep then tracks each word's real sung
 * timing. Waiting for each word to be sung before drawing it would leave the
 * frame half-empty and read as a subtitle rather than a composition.
 */
export class LineView {
  readonly el: HTMLElement;
  private views: WordView[] = [];
  private phraseStart: number;
  private lineEnd: number;
  private exitVec = { x: 0, y: -1 };
  private enterVec: { x: number; y: number };
  private quality: 'high' | 'lite';
  private baseSize: number;

  constructor(line: LyricLine, laid: LaidLine, opts: LineViewOptions = {}) {
    this.phraseStart = line.startMs;
    this.lineEnd = line.endMs;
    this.quality = opts.quality ?? 'high';
    this.baseSize = laid.baseSize;

    const root = document.createElement('div');
    root.className = 'line';
    root.style.fontSize = `${laid.baseSize.toFixed(3)}vmin`;
    if (line.background) root.style.opacity = '0.62';

    let wordOrdinal = 0;
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
          el, face, echoes, box, glyph, laid: laidWord,
          enterAt: line.startMs - LEAD_MS + wordOrdinal * STAGGER_MS,
          startMs, endMs,
          last: { t: '', o: '', b: '', p: '' },
        });
        wordOrdinal += 1;
      }
      root.appendChild(rowEl);
    }

    this.el = root;
    const from = opts.enterFrom ?? { x: 0, y: 1 };
    this.enterVec = from;
    // Leave the way we came in, so the film keeps travelling in one direction
    // instead of resetting between phrases.
    this.exitVec = { x: -from.x, y: -from.y };
  }

  get exitVector(): { x: number; y: number } {
    return this.exitVec;
  }

  get startsAt(): number {
    return this.phraseStart - LEAD_MS;
  }

  get endsAt(): number {
    return this.lineEnd + OUT_MS;
  }

  /**
   * Shrink to fit once the element is in the document.
   *
   * Layout picks a size from estimated character widths, which is close but
   * never exact. Measuring the real box and scaling down is what guarantees a
   * long bar can never run off the edge of the frame.
   */
  fitToFrame(container: HTMLElement): void {
    // The margin absorbs the per-word jitter offsets, so a phrase that just
    // fits at rest still cannot touch the frame edge at its largest.
    //
    // This measurement is taken at rest, but the phrase never actually stays
    // at rest: `update()` keeps zooming it slowly for its whole life (up to
    // +3.2%) and each word overshoots slightly on entry (up to +2.4%). Fitting
    // to the resting size and letting those run on top is what let a hero
    // word sized right at the ceiling grow past the frame edge after landing.
    // GROWTH_BUDGET reserves that headroom up front instead.
    const GROWTH_BUDGET = 1.1;
    const avail = (container.clientWidth * 0.86) / GROWTH_BUDGET;
    const availH = (container.clientHeight * 0.82) / GROWTH_BUDGET;
    if (avail <= 0) return;

    // The rows are full-width flex containers and the phrase fills the frame,
    // so neither box says anything about how much ink is actually in it. Only
    // the word elements do: span the first to the last, gaps included.
    let widest = 0;
    let tall = 0;
    for (const row of Array.from(this.el.children) as HTMLElement[]) {
      const words = Array.from(row.children) as HTMLElement[];
      if (!words.length) continue;
      const first = words[0]!.getBoundingClientRect();
      const last = words[words.length - 1]!.getBoundingClientRect();
      widest = Math.max(widest, last.right - first.left);
      tall += Math.max(...words.map((w) => w.getBoundingClientRect().height));
    }
    if (widest <= 0) return;

    const scale = Math.min(widest > avail ? avail / widest : 1, tall > availH ? availH / tall : 1);
    if (scale < 0.999) {
      this.el.style.fontSize = `${(this.baseSize * scale).toFixed(3)}vmin`;
    }
  }

  /**
   * Render the frame at `posMs`. Returns false once the phrase is fully gone,
   * which is the caller's cue to drop it.
   */
  update(posMs: number): boolean {
    const exitT = clamp01((posMs - this.lineEnd) / OUT_MS);
    if (exitT >= 1) return false;

    // A slow push-in across the phrase's whole life, so the frame is never
    // static even while a word is being held.
    const span = Math.max(1, this.endsAt - this.startsAt);
    const life = clamp01((posMs - this.startsAt) / span);
    const push = 1 + life * 0.032;
    const driftY = -life * 1.1;

    const e = exitT > 0 ? power2In(exitT) : 0;
    const tx = this.exitVec.x * e * 7;
    const ty = this.exitVec.y * e * 7 + driftY;
    const scale = push * (1 - e * 0.035);

    this.el.style.transform =
      `translate3d(${tx.toFixed(2)}%, ${ty.toFixed(2)}%, 0) scale(${scale.toFixed(4)})`;
    this.el.style.opacity = e > 0 ? Math.max(0, 1 - e * 1.5).toFixed(3) : '';
    // This is a whole-phrase transition effect, not a per-word timing tell,
    // so it applies in 'lite' quality too. Without it, an outgoing phrase
    // stays sharp and ~55% opaque for its first ~100ms while the incoming one
    // is already arriving -- two compositions sitting on top of each other
    // in full focus, which reads as broken rather than as a cut.
    const blur = Math.round(e * 16);
    this.el.style.filter = blur > 0 ? `blur(${blur}px)` : '';

    // Once the phrase is leaving, the words inside it stop moving on their own;
    // the whole block travels as one piece.
    if (exitT > 0) return true;

    for (const view of this.views) this.updateWord(view, posMs);
    return true;
  }

  private updateWord(view: WordView, posMs: number): void {
    const { laid, enterAt, startMs, endMs, last } = view;

    const inT = clamp01((posMs - enterAt) / IN_MS);
    const e = power4Out(inT);

    const riseX = this.enterVec.x * (1 - e) * 0.7 + laid.dx * e;
    const riseY = this.enterVec.y * (1 - e) * 0.8 + laid.dy * e;
    // A touch of overshoot past 1 before settling reads as weight landing.
    const overshoot = Math.sin(clamp01(inT) * Math.PI) * 0.035;
    const scale = 0.82 + 0.18 * e + overshoot;
    const rot = laid.rotate * e;

    const transform =
      `translate3d(${riseX.toFixed(3)}em, ${riseY.toFixed(3)}em, 0) ` +
      `scale(${scale.toFixed(4)})` +
      (rot ? ` rotate(${rot.toFixed(2)}deg)` : '');
    setStyle(view.el, 'transform', transform, last, 't');
    setStyle(view.el, 'opacity', e.toFixed(3), last, 'o');

    if (this.quality === 'high') {
      const size = laid.tier === 'hero' ? 20 : 11;
      const blur = Math.round((1 - e) * size);
      setStyle(view.face, 'filter', blur > 0 ? `blur(${blur}px)` : '', last, 'b');
    }

    // The sweep is the only thing tied to the real sung timing, which is what
    // keeps the highlight locked to the vocal even though entry is phrased.
    const sweep = clamp01((posMs - startMs) / Math.max(1, endMs - startMs));
    const pct = `${(sweep * 100).toFixed(1)}%`;
    if (last.p !== pct) {
      last.p = pct;
      view.face.style.setProperty('--p', pct);
    }

    for (let i = 0; i < view.echoes.length; i += 1) {
      const echo = view.echoes[i]!;
      const lagT = clamp01((posMs - enterAt - (i + 1) * ECHO_LAG_MS) / IN_MS);
      const le = power4Out(lagT);
      // Collapses to almost nothing at rest, so it reads as a trail in motion
      // rather than as a permanent drop shadow.
      const spread = (1 - le) * 1.05 + 0.022;
      const ox = this.enterVec.x * spread * (i + 1) * 0.34;
      const oy = this.enterVec.y * spread * (i + 1) * 0.38;
      const es = 1 + (i + 1) * 0.04 * (1 - le) + (i + 1) * 0.006;
      echo.style.transform =
        `translate3d(${ox.toFixed(3)}em, ${oy.toFixed(3)}em, 0) scale(${es.toFixed(4)})`;
      echo.style.opacity = lagT <= 0 ? '0' : ((0.3 - i * 0.062) * le * (1 - le * 0.45)).toFixed(3);
    }

    if (view.box) {
      const boxT = clamp01((posMs - enterAt) / 150);
      view.box.style.transform = `scaleX(${power4Out(boxT).toFixed(4)})`;
    }

    if (view.glyph) {
      const gT = clamp01((posMs - (enterAt + GLYPH_DELAY_MS)) / GLYPH_MS);
      const gb = backOut(gT);
      view.glyph.style.opacity = gT <= 0 ? '0' : Math.min(1, gT * 2.6).toFixed(3);
      view.glyph.style.transform = `scale(${gb.toFixed(3)}) rotate(${((1 - gb) * -10).toFixed(2)}deg)`;
    }
  }

  destroy(): void {
    this.el.remove();
  }
}
