import type { LyricLine, RenderTier } from '@lyricroom/shared';
import type { LaidLine, LaidWord } from '../layout/engine.js';
import type { MotionParams } from '../theme.js';
import {
  backOut, bezier, clamp01, expoOut, power3In, power4In, power4Out, smoothstep,
} from './ease.js';

/**
 * How a phrase hands over to the next one. The exit of one phrase and the
 * entry of the next are the same seam, so they always agree on axis and
 * direction (the vector law): the film keeps travelling one way instead of
 * resetting on every cut.
 *
 *  - `up` / `left`: lateral travel along (x, y), the unit vector of motion.
 *  - `push`: Z forward, the outgoing phrase grows past the camera and the
 *    next grows in from small -- going deeper into the same thought.
 *  - `pull`: Z back, the outgoing phrase shrinks away and the next lands from
 *    larger than life -- something bigger arriving. Used on chorus entries.
 *  - `rack`: a rack-focus cut, blurred at the seam. Rare, line boundaries only.
 *
 * Push pairs with push and pull with pull (the Z scale-sign rule): a phrase
 * that recedes is never followed by one that grows in from small.
 */
export type SeamKind = 'up' | 'left' | 'push' | 'pull' | 'rack';

export interface Seam {
  kind: SeamKind;
  /** Travel direction for lateral seams, screen space (y down). */
  x: number;
  y: number;
}

export const SEAM_UP: Seam = { kind: 'up', x: 0, y: -1 };

/** Stagger between letters of the hero in Cinema: fluid, not dramatic. */
const LETTER_STAGGER_MS = 16;
/** Echo trail copies behind each word as it arrives. */
const ECHO_LAG_MS = 44;
const GLYPH_DELAY_MS = 90;
const GLYPH_MS = 320;
/** Words held this long get the Apple Music Sing "undulate". */
const EMPHASIS_MIN_MS = 1000;
/** Phrase-anchored cascade used when word timings are only a guess. */
const LITE_STAGGER_MS = 52;

const emphasisIn = bezier(0.2, 0.4, 0.58, 1);
const emphasisOut = bezier(0.3, 0, 0.58, 1);

/** Live audio decoration shared by every view; set once per frame. */
export const audio = { bass: 0 };

interface WordView {
  el: HTMLElement;
  face: HTMLElement;
  halo: HTMLElement | null;
  echoes: HTMLElement[];
  box: HTMLElement | null;
  glyph: HTMLElement | null;
  letters: HTMLElement[];
  laid: LaidWord;
  enterAt: number;
  inMs: number;
  rise: number;
  startMs: number;
  endMs: number;
  /** 0 when the word is not held long enough to be emphasised. */
  emph: number;
  last: Record<string, string>;
}

function setStyle(el: HTMLElement, prop: 'transform' | 'opacity' | 'filter', value: string, cache: Record<string, string>, key: string): void {
  if (cache[key] === value) return;
  cache[key] = value;
  el.style[prop] = value;
}

export interface LineViewOptions {
  /** How this phrase arrives: the previous phrase's exit seam. */
  entry: Seam;
  /** How it leaves: the next phrase's entry seam. */
  exit: Seam;
  tier: RenderTier;
  /** 'lite' when word timings were interpolated: calmer, phrase-anchored. */
  quality: 'high' | 'lite';
  motion: MotionParams;
  /** Tilt of the word wall, degrees. */
  tiltX: number;
  tiltY: number;
  /** 0..1, how much this phrase is a chorus/climax. */
  section: number;
  /** Last phrase of its lyric line: its last word gets the bigger emphasis. */
  endsLine: boolean;
  /** The hero face has a variable weight axis to swell on a held note. */
  heroVariable: boolean;
  /** Draw the hero again, huge and faint, behind the phrase. */
  echoLayout: { mirror: boolean } | null;
  background: boolean;
}

/**
 * One phrase -- two to four words -- rendered as DOM and driven entirely by the
 * playback clock.
 *
 * There is no timeline object: `update(posMs)` computes the whole frame from
 * the position alone, which is what makes seeking, pausing and skipping exact
 * on a display that runs for weeks.
 *
 * Words are revealed as they are sung. The whole phrase is laid out up front,
 * so the composition never reflows; each word simply arrives in its place a
 * moment before its vocal, and the phrase leaves as one smeared block.
 */
export class LineView {
  readonly el: HTMLElement;
  private views: WordView[] = [];
  private hero: WordView | null = null;
  private phraseStart: number;
  private lineEnd: number;
  private opts: LineViewOptions;
  private baseSize: number;
  private ghosts: HTMLElement[] = [];
  private ghostCount: number;
  private echoBig: HTMLElement | null = null;
  private lastLine: Record<string, string> = {};
  private outMs: number;
  private frozen = false;

  constructor(line: LyricLine, laid: LaidLine, opts: LineViewOptions) {
    this.opts = opts;
    this.phraseStart = line.startMs;
    this.lineEnd = line.endMs;
    this.baseSize = laid.baseSize;
    this.outMs = opts.motion.outMs;
    const cinema = opts.tier === 'cinema';
    const lite = opts.quality === 'lite';
    this.ghostCount = opts.background ? 0 : cinema ? Math.min(6, opts.motion.smear) : Math.min(3, opts.motion.smear);

    const root = document.createElement('div');
    root.className = 'line';
    root.style.fontSize = `${laid.baseSize.toFixed(3)}vmin`;
    if (opts.background) root.dataset['bg'] = '1';
    if (opts.section > 0.5) root.dataset['chorus'] = '1';
    root.style.opacity = '0';

    if (opts.echoLayout && laid.rows.length) {
      const heroWord = laid.rows.flatMap((r) => r.words).find((w) => w.tier === 'hero');
      if (heroWord) {
        const big = document.createElement('div');
        big.className = 'echo-layout';
        big.textContent = heroWord.text;
        big.style.fontSize = `${(heroWord.scale * 2.4).toFixed(3)}em`;
        if (opts.echoLayout.mirror) big.dataset['mirror'] = '1';
        root.appendChild(big);
        this.echoBig = big;
      }
    }

    const tierMs = { hero: 180, support: 150, connective: 120 } as const;
    const tierRise = { hero: 0.55, support: 0.4, connective: 0.3 } as const;
    let prevEnter = -Infinity;
    let ordinal = 0;
    const lastIndex = line.words.length - 1;

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
        el.style.opacity = '0';
        if (laidWord.invert) el.dataset['invert'] = '1';

        const echoes: HTMLElement[] = [];
        const echoN = lite || laidWord.tier === 'connective' ? 0 : cinema ? 4 : 2;
        for (let i = 0; i < echoN; i += 1) {
          const echo = document.createElement('span');
          echo.className = i % 2 === 1 ? 'echo outline' : 'echo';
          echo.textContent = laidWord.text;
          echo.style.opacity = '0';
          el.appendChild(echo);
          echoes.push(echo);
        }

        let halo: HTMLElement | null = null;
        if (laidWord.tier === 'hero' || (cinema && laidWord.tier === 'support')) {
          halo = document.createElement('span');
          halo.className = cinema ? 'halo' : 'halo flat';
          halo.textContent = laidWord.text;
          halo.style.opacity = '0';
          el.appendChild(halo);
        }

        let box: HTMLElement | null = null;
        if (laidWord.invert) {
          box = document.createElement('span');
          box.className = 'box';
          box.dataset['from'] = opts.entry.kind === 'left' ? 'right' : 'left';
          box.style.transform = 'scaleX(0)';
          el.appendChild(box);
        }

        const face = document.createElement('span');
        face.className = 'face';
        const letters: HTMLElement[] = [];
        const splitLetters = cinema && !lite && laidWord.tier === 'hero' && !laidWord.invert;
        if (splitLetters) {
          face.classList.add('letters');
          for (const ch of Array.from(laidWord.text)) {
            const s = document.createElement('span');
            s.className = 'ch';
            s.textContent = ch;
            face.appendChild(s);
            letters.push(s);
          }
        } else {
          face.classList.add('sweep');
          face.textContent = laidWord.text;
          face.style.setProperty('--s', '0');
        }
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

        // Reveal as sung: each word arrives just ahead of its own vocal. Words
        // sung almost together still cascade, so a fast run reads as a gesture
        // rather than a block. With guessed timings the phrase cascades in as
        // one piece instead, because pinning motion to a guess advertises it.
        const inMs = tierMs[laidWord.tier] * opts.motion.inScale;
        let enterAt = lite
          ? line.startMs - opts.motion.leadMs + ordinal * LITE_STAGGER_MS
          : startMs - opts.motion.leadMs;
        if (enterAt < prevEnter + 40) enterAt = prevEnter + 40;
        prevEnter = enterAt;

        const held = endMs - startMs;
        const isLineEnd = opts.endsLine && laidWord.index === lastIndex;
        const emph = lite || held < EMPHASIS_MIN_MS
          ? 0
          : Math.min(1.2, Math.max(0.5, held / 2000)) * (isLineEnd ? 1.6 : 1);

        const view: WordView = {
          el, face, halo, echoes, box, glyph, letters, laid: laidWord,
          enterAt, inMs, rise: tierRise[laidWord.tier], startMs, endMs, emph, last: {},
        };
        this.views.push(view);
        if (laidWord.tier === 'hero') this.hero = view;
        ordinal += 1;
      }
      root.appendChild(rowEl);
    }
    this.el = root;
  }

  get startsAt(): number {
    return (this.views[0]?.enterAt ?? this.phraseStart) - 10;
  }

  get endsAt(): number {
    return this.lineEnd + this.outMs;
  }

  /** When the hero lands: the moment the type "hits" the stage. */
  private get heroLandAt(): number {
    const h = this.hero ?? this.views[0];
    return h ? h.enterAt + h.inMs * 0.55 : this.phraseStart;
  }

  /** Decaying 0..1 impulse from the hero landing, for the stage to react to. */
  impact(posMs: number): number {
    const t = posMs - this.heroLandAt;
    if (t < 0 || posMs > this.lineEnd) return 0;
    return Math.exp(-t / 180);
  }

  /** 0..1 how present the hero is, for the light it spills onto the stage. */
  heroPresence(posMs: number): number {
    const h = this.hero;
    if (!h) return 0;
    const inT = clamp01((posMs - h.enterAt) / h.inMs);
    const out = clamp01((posMs - this.lineEnd) / (this.outMs * 0.5));
    return inT * (1 - out) * (this.opts.background ? 0 : 1);
  }

  /** The hero's box in viewport pixels, for the stage's light-spill mask. */
  heroRect(): { text: string; rect: DOMRect; font: string } | null {
    const h = this.hero;
    if (!h) return null;
    const cs = getComputedStyle(h.face);
    // The word box, not the face: the face's paint box is padded for descenders.
    const r = h.el.getBoundingClientRect();
    const f = h.face.getBoundingClientRect();
    return {
      text: h.laid.text,
      rect: new DOMRect(f.left, r.top, f.width, r.height),
      font: `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`,
    };
  }

  /**
   * Shrink to fit once the element is in the document.
   *
   * Layout picks a size from estimated character widths, which is close but
   * never exact. Measuring the real box and scaling down is what guarantees a
   * long bar can never run off the edge of the frame.
   */
  fitToFrame(container: HTMLElement): void {
    // The measurement is taken at rest, but a phrase is never quite at rest:
    // words overshoot on entry and a held hero swells by up to ~12%. Reserve
    // that headroom up front instead of letting the ink crawl off the edge.
    const GROWTH_BUDGET = 1.12;
    const avail = (container.clientWidth * 0.86) / GROWTH_BUDGET;
    const availH = (container.clientHeight * (this.opts.background ? 0.3 : 0.82)) / GROWTH_BUDGET;
    if (avail <= 0) return;

    let widest = 0;
    let tall = 0;
    for (const row of Array.from(this.el.querySelectorAll<HTMLElement>(':scope > .row'))) {
      const words = Array.from(row.children) as HTMLElement[];
      if (!words.length) continue;
      const first = words[0]!.getBoundingClientRect();
      const last = words[words.length - 1]!.getBoundingClientRect();
      widest = Math.max(widest, last.right - first.left);
      tall += Math.max(...words.map((w) => w.getBoundingClientRect().height));
    }
    if (widest > 0) {
      const scale = Math.min(widest > avail ? avail / widest : 1, tall > availH ? availH / tall : 1);
      if (scale < 0.999) this.el.style.fontSize = `${(this.baseSize * scale).toFixed(3)}vmin`;
    }

    // A variable hero swells in weight on a held note, and heavier glyphs are
    // wider. Lock its box at the heaviest weight now, so the swell can never
    // shove its neighbours along the row.
    const h = this.hero;
    if (h && this.opts.heroVariable && h.emph > 0) {
      h.face.style.fontVariationSettings = "'wght' 820";
      const w = h.el.offsetWidth;
      h.face.style.fontVariationSettings = '';
      h.el.style.width = `${w}px`;
      h.el.style.textAlign = 'center';
    }
  }

  /** The line's own transform at exit progress `x` (0 = at rest). */
  private lineTransform(x: number, stretch = 0): string {
    const { exit, motion, tiltX, tiltY } = this.opts;
    let tx = 0;
    let ty = 0;
    let s = 1;
    if (exit.kind === 'up' || exit.kind === 'left') {
      const e = x * x;
      tx = exit.x * e * motion.travel;
      ty = exit.y * e * motion.travel;
    } else if (exit.kind === 'push') {
      s = 1 + 0.2 * power3In(x);
    } else if (exit.kind === 'pull') {
      s = 1 - 0.2 * power3In(x);
    } else {
      s = 1 + 0.06 * x;
    }
    const sy = stretch && (exit.kind === 'up') ? ` scaleY(${(1 + stretch).toFixed(4)})` : '';
    const sx = stretch && (exit.kind === 'left') ? ` scaleX(${(1 + stretch).toFixed(4)})` : '';
    return `perspective(1400px) translate3d(${tx.toFixed(3)}%, ${ty.toFixed(3)}%, 0) ` +
      `rotateX(${tiltX.toFixed(2)}deg) rotateY(${tiltY.toFixed(2)}deg) scale(${s.toFixed(4)})${sy}${sx}`;
  }

  /**
   * The smear: copies of the whole phrase trailing it on its way out, each a
   * few frames further behind, stretched along the travel. Built once, when
   * the exit starts, from the phrase as it stands at that moment.
   */
  private buildGhosts(): void {
    if (this.ghosts.length || !this.ghostCount || !this.el.parentElement) return;
    const cinema = this.opts.tier === 'cinema';
    for (let k = 1; k <= this.ghostCount; k += 1) {
      const g = document.createElement('div');
      g.className = 'line ghost';
      g.style.fontSize = this.el.style.fontSize;
      g.setAttribute('aria-hidden', 'true');
      for (const row of Array.from(this.el.querySelectorAll(':scope > .row'))) {
        const clone = row.cloneNode(true) as HTMLElement;
        for (const junk of Array.from(clone.querySelectorAll('.echo, .halo, .glyph, .box'))) junk.remove();
        if (cinema) {
          // Static blur on each small word box, rasterised once; animating a
          // filter on a full-frame layer is what would cost a 4K frame.
          for (const w of Array.from(clone.querySelectorAll<HTMLElement>('.word'))) {
            w.style.filter = `blur(${(1 + k * 1.4).toFixed(1)}px)`;
          }
        }
        g.appendChild(clone);
      }
      g.style.opacity = '0';
      this.el.parentElement.insertBefore(g, this.el);
      this.ghosts.push(g);
    }
  }

  /**
   * Render the frame at `posMs`. Returns false once the phrase is fully gone,
   * which is the caller's cue to drop it.
   */
  update(posMs: number): boolean {
    const x = clamp01((posMs - this.lineEnd) / this.outMs);
    if (x >= 1) return false;
    const { exit } = this.opts;

    // Landing punch: the whole wall gives a little when the hero hits.
    const punch = x > 0 ? 0 : this.impact(posMs) * 0.02;
    let transform = this.lineTransform(x);
    if (punch > 0.0005) transform += ` scale(${(1 + punch).toFixed(4)})`;
    setStyle(this.el, 'transform', transform, this.lastLine, 't');

    let opacity: number;
    if (exit.kind === 'rack') opacity = 1 - smoothstep(0.65, 1, x);
    else opacity = 1 - smoothstep(0.12, 0.62, x);
    if (this.opts.background) opacity *= 0.6;
    setStyle(this.el, 'opacity', opacity.toFixed(3), this.lastLine, 'o');

    // A rack-focus cut blurs the outgoing phrase to its peak right at the seam.
    // Once per ~8 s at most, Cinema only, so the full-frame filter is affordable.
    const blur = exit.kind === 'rack' && this.opts.tier === 'cinema' ? Math.round(power4In(x) * 12) : 0;
    setStyle(this.el, 'filter', blur > 0 ? `blur(${blur}px)` : '', this.lastLine, 'f');

    if (this.echoBig) {
      const drift = clamp01((posMs - this.phraseStart) / Math.max(1, this.lineEnd - this.phraseStart));
      const e = clamp01((posMs - this.startsAt) / 400);
      this.echoBig.style.opacity = (0.07 * e).toFixed(3);
      this.echoBig.style.transform =
        `translate(-50%, -50%) translateX(${(-2 + drift * 4).toFixed(2)}%)${this.echoBig.dataset['mirror'] ? ' scaleX(-1)' : ''}`;
    }

    if (x > 0) {
      // The block leaves frozen at its end-of-line state. Rendering that state
      // here, rather than trusting whatever the last frame left behind, keeps
      // the exit exact when playback seeks straight into it.
      if (!this.frozen) {
        for (const view of this.views) this.updateWord(view, this.lineEnd);
        this.frozen = true;
      }
      this.buildGhosts();
      const lag = 0.09;
      for (let k = 0; k < this.ghosts.length; k += 1) {
        const g = this.ghosts[k]!;
        const xk = clamp01(x - (k + 1) * lag);
        const stretch = 0.12 * (k + 1) * Math.sin(Math.PI * clamp01(x));
        g.style.transform = this.lineTransform(xk, stretch);
        const life = Math.sin(Math.PI * clamp01(x / 0.9)) * (1 - smoothstep(0.6, 0.95, x) * 0.5);
        g.style.opacity = ((0.4 - k * 0.055) * life).toFixed(3);
      }
      // Once the phrase is leaving, the words inside it stop moving on their
      // own; the whole block travels as one piece.
      return true;
    }

    this.frozen = false;
    for (const view of this.views) this.updateWord(view, posMs);
    return true;
  }

  /** Entry transform for a word at eased progress `e` along this phrase's entry seam. */
  private entryTransform(view: WordView, e: number, inT: number): { t: string; s: number } {
    const { entry, motion } = this.opts;
    const { laid, rise } = view;
    let dx = laid.dx;
    let dy = laid.dy;
    let s = 1;
    if (entry.kind === 'up' || entry.kind === 'left') {
      // Partial travel: arrive from a short way back along the motion.
      dx -= entry.x * rise * (1 - e);
      dy -= entry.y * rise * (1 - e);
    } else if (entry.kind === 'push') {
      s = 0.75 + 0.25 * e;
    } else if (entry.kind === 'pull') {
      s = 1.25 - 0.25 * e;
    } else {
      s = 1.06 - 0.06 * e;
    }
    if (motion.slam > 1 && laid.tier !== 'connective') {
      // Slam: land from oversized with a hint of back-out, like a punch-in.
      s *= 1 + (motion.slam - 1) * (1 - backOut(inT, 1.7));
    } else if (laid.tier === 'hero') {
      s *= 1 + Math.sin(inT * Math.PI) * 0.022;
    }
    const rot = laid.rotate + (motion.slam > 1 ? (1 - e) * 1.4 : 0);
    const t = `translate3d(${dx.toFixed(3)}em, ${dy.toFixed(3)}em, 0) scale(${s.toFixed(4)})` +
      (Math.abs(rot) > 0.01 ? ` rotate(${rot.toFixed(2)}deg)` : '');
    return { t, s };
  }

  private updateWord(view: WordView, posMs: number): void {
    const { laid, enterAt, startMs, endMs, last, inMs } = view;
    if (posMs < enterAt) {
      setStyle(view.el, 'opacity', '0', last, 'o');
      return;
    }
    const cinema = this.opts.tier === 'cinema';
    const lite = this.opts.quality === 'lite';

    const inT = clamp01((posMs - enterAt) / inMs);
    const e = this.opts.entry.kind === 'up' || this.opts.entry.kind === 'left' ? power4Out(inT) : expoOut(inT);

    // Held-note emphasis envelope: rises through the hold, settles after it.
    const dur = Math.max(1, endMs - startMs);
    let env = 0;
    if (view.emph > 0 && posMs >= startMs) {
      env = emphasisIn(clamp01((posMs - startMs) / (dur * 0.55))) *
        (1 - emphasisOut(clamp01((posMs - endMs) / 280)));
    }

    const { t } = this.entryTransform(view, e, inT);
    let transform = t;
    if (env > 0 && !view.letters.length) {
      // Without letters, the whole word breathes up a touch instead.
      transform += ` translateY(${(-0.025 * view.emph * env).toFixed(4)}em) scale(${(1 + 0.05 * view.emph * env).toFixed(4)})`;
    }
    setStyle(view.el, 'transform', transform, last, 't');
    // Near-binary opacity: a word is either arriving or there, never a ghost.
    setStyle(view.el, 'opacity', Math.min(1, inT / 0.25).toFixed(3), last, 'o');

    let faceBlur = 0;
    if (cinema && !lite) faceBlur = (1 - e) * (this.opts.entry.kind === 'rack' ? 10 : 3);
    const fb = faceBlur > 0.3 ? `blur(${faceBlur.toFixed(1)}px)` : '';
    setStyle(view.face, 'filter', fb, last, 'fb');

    // The sweep is the only thing tied to the real sung timing.
    const sweep = clamp01((posMs - startMs) / dur);

    if (view.letters.length) {
      const n = view.letters.length;
      const amount = Math.min(1.2, view.emph);
      for (let i = 0; i < n; i += 1) {
        const ch = view.letters[i]!;
        const lt = clamp01((posMs - enterAt - i * LETTER_STAGGER_MS) / inMs);
        const le = power4Out(lt);
        const lit = clamp01(sweep * n - i);
        // Per-letter stagger of the emphasis too, so it ripples through the word.
        const envI = view.emph > 0 && posMs >= startMs
          ? emphasisIn(clamp01((posMs - startMs - (dur / 2.5 / n) * i) / (dur * 0.55))) *
            (1 - emphasisOut(clamp01((posMs - endMs) / 280)))
          : 0;
        const fan = -0.03 * amount * (n / 2 - i - 0.5) * envI;
        const y = 0.08 * (1 - le) - 0.012 * lit - 0.025 * amount * envI;
        const sc = 1 + 0.1 * amount * envI;
        const key = `c${i}`;
        const tr = `translate3d(${fan.toFixed(4)}em, ${y.toFixed(4)}em, 0) scale(${sc.toFixed(4)})`;
        if (view.last[key] !== tr) {
          view.last[key] = tr;
          ch.style.transform = tr;
        }
        const op = (lt <= 0 ? 0 : 0.72 + 0.28 * lit).toFixed(3);
        if (view.last[`o${i}`] !== op) {
          view.last[`o${i}`] = op;
          ch.style.opacity = op;
        }
      }
    } else {
      const s = sweep.toFixed(3);
      if (last['s'] !== s) {
        last['s'] = s;
        view.face.style.setProperty('--s', s);
      }
    }

    if (this.opts.heroVariable && view === this.hero && view.emph > 0) {
      const w = Math.round(600 + 220 * env);
      const fv = env > 0.01 ? `'wght' ${w}` : '';
      if (last['w'] !== fv) {
        last['w'] = fv;
        view.face.style.fontVariationSettings = fv;
      }
    }

    if (view.halo) {
      // Glow belongs to the word being sung, not to the container: it lifts
      // while the vocal is on the word and settles to a low ember after.
      const active = posMs >= startMs && posMs <= endMs + 120 ? 1 : 0;
      const after = posMs > endMs ? Math.exp(-(posMs - endMs) / 500) : 0;
      const g = this.opts.motion.glow * (laid.tier === 'hero' ? 1 : 0.55);
      const live = cinema ? 0.25 + 0.75 * Math.max(active, after) + 0.35 * env : 0.55;
      const bassLift = cinema ? 1 + audio.bass * 0.3 : 1;
      const o = Math.min(1, g * live * bassLift * Math.min(1, inT * 2) * (1 + this.opts.section * 0.4));
      setStyle(view.halo, 'opacity', o.toFixed(3), last, 'h');
    }

    for (let i = 0; i < view.echoes.length; i += 1) {
      const echo = view.echoes[i]!;
      const lagT = clamp01((posMs - enterAt - (i + 1) * ECHO_LAG_MS) / inMs);
      const le = power4Out(lagT);
      const { entry } = this.opts;
      let tr: string;
      if (entry.kind === 'up' || entry.kind === 'left') {
        // Relative to the word, the lagged copy sits behind it along the travel.
        const k = (le - e) * view.rise * 1.6;
        tr = `translate3d(${(entry.x * k).toFixed(3)}em, ${(entry.y * k).toFixed(3)}em, 0) scale(${(1 + (i + 1) * 0.02 * (1 - le)).toFixed(4)})`;
      } else {
        const sNow = entry.kind === 'push' ? 0.75 + 0.25 * e : 1.25 - 0.25 * e;
        const sLag = entry.kind === 'push' ? 0.75 + 0.25 * le : 1.25 - 0.25 * le;
        tr = `scale(${(sLag / sNow).toFixed(4)})`;
      }
      echo.style.transform = tr;
      // Zero at rest, so the trail is motion and never a permanent shadow.
      echo.style.opacity = lagT <= 0 ? '0' : ((0.34 - i * 0.07) * Math.sin(Math.PI * le)).toFixed(3);
    }

    if (view.box) {
      const boxT = clamp01((posMs - enterAt) / 150);
      setStyle(view.box, 'transform', `scaleX(${power4Out(boxT).toFixed(4)})`, last, 'bx');
    }

    if (view.glyph) {
      const gT = clamp01((posMs - (enterAt + GLYPH_DELAY_MS)) / GLYPH_MS);
      const gb = backOut(gT);
      // A slow float keeps the glyph part of the composition, not pasted on.
      const float = Math.sin((posMs / 1000) * Math.PI * 2 * 0.3) * 0.02;
      view.glyph.style.opacity = gT <= 0 ? '0' : Math.min(1, gT * 2.6).toFixed(3);
      view.glyph.style.transform =
        `translateY(${float.toFixed(4)}em) scale(${gb.toFixed(3)}) rotate(${((1 - gb) * -10).toFixed(2)}deg)`;
    }
  }

  destroy(): void {
    for (const g of this.ghosts) g.remove();
    this.ghosts = [];
    this.el.remove();
  }
}
