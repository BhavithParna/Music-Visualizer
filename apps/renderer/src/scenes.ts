import type {
  BeatInfo, LyricDoc, NowPlaying, RenderTier, SceneMode, Section, SongProfile,
} from '@lyricroom/shared';
import { sectionAt } from '@lyricroom/shared';
import { layoutLine } from './layout/engine.js';
import { buildPhrases, type Phrase } from './layout/phrases.js';
import { LineView, SEAM_UP, type Seam } from './type/word.js';
import { clamp01, smoothstep } from './type/ease.js';
import type { Theme } from './theme.js';

/** How long the stage stays dark after playback stops before it becomes idle. */
const IDLE_AFTER_MS = 20_000;
/** A rack-focus cut is a spice: never more often than this. */
const RACK_EVERY_MS = 8000;
/** Hold before a climax: shortest gap worth staging, longest worth holding a phrase through. */
const STILL_MIN_MS = 400;
const STILL_MAX_MS = 3000;
/** A gap this long is an instrumental: the breathing dots come out. */
const DOTS_MIN_GAP_MS = 4000;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

interface LineMeta {
  /** Words per second and mood, used to size the hero: dense rap vs. held ballad. */
  intensity: number;
  invert: boolean;
  glyph?: string;
  /** How many times this exact line has been sung before, for layout variety. */
  occurrence: number;
}

/** Everything decided about a phrase before it is ever drawn. */
interface PhrasePlan {
  phrase: Phrase;
  entry: Seam;
  exit: Seam;
  section: Section | null;
  /** 0..1 chorus-ness, for size, glow and the stage. */
  lift: number;
  voice: 0 | 1;
  /** Stillness before a climax: dim the stage over [from, to]. */
  still: { from: number; to: number } | null;
  endsLine: boolean;
}

export interface SceneOutputs {
  /** Hero landing impulse, 0..1. */
  impact: number;
  /** Hero light-spill strength, 0..1. */
  mask: number;
  /** Stage darkening for stillness before a climax. */
  dim: number;
  /** 0 verse .. 1 chorus, blended with live energy. */
  section: number;
  cam: [number, number];
  sectionLabel: string;
}

const lateral = (current: Theme['motion']['current']): Seam =>
  current === 'left' ? { kind: 'left', x: -1, y: 0 } : current === 'up' ? SEAM_UP : { kind: current, x: 0, y: 0 };

export class SceneDirector {
  private typeEl = document.getElementById('type') as HTMLElement;
  private cardEl = document.getElementById('card') as HTMLElement;
  private dotsEl = document.getElementById('dots') as HTMLElement;

  private doc: LyricDoc | null = null;
  private phrases: Phrase[] = [];
  private plans: PhrasePlan[] = [];
  private meta: LineMeta[] = [];
  private offsetMs = 0;
  private track: NowPlaying | null = null;
  private glyphs: Record<number, string> = {};
  private profile: SongProfile | null = null;
  private theme: Theme | null = null;
  private tier: RenderTier = 'cinema';
  private beat: BeatInfo | null = null;

  private views = new Map<string, { view: LineView; plan: PhrasePlan }>();
  private mode: SceneMode | 'auto' = 'auto';
  private pausedSince: number | null = null;
  private portrait = window.innerHeight > window.innerWidth;
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private maskCanvas = document.createElement('canvas');
  private maskKey = '';
  onMask: ((c: HTMLCanvasElement) => void) | null = null;
  out: SceneOutputs = { impact: 0, mask: 0, dim: 0, section: 0, cam: [0, 0], sectionLabel: '' };

  constructor() {
    window.addEventListener('resize', () => {
      this.portrait = window.innerHeight > window.innerWidth;
      this.clearViews();
    });
    // Late-loading faces change every measurement fit-to-frame made.
    document.fonts.addEventListener('loadingdone', () => this.clearViews());
  }

  setTrack(track: NowPlaying | null): void {
    if (track?.trackKey !== this.track?.trackKey) {
      this.clearViews();
      this.doc = null;
      this.phrases = [];
      this.plans = [];
      this.meta = [];
      this.glyphs = {};
      this.profile = null;
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
    this.rebuildPlan();
  }

  setGlyphs(glyphs: Record<number, string>): void {
    this.glyphs = glyphs;
    if (this.doc) this.meta = this.buildMeta(this.doc);
    this.clearViews();
  }

  setProfile(profile: SongProfile | null): void {
    this.profile = profile;
    if (this.doc) this.meta = this.buildMeta(this.doc);
    this.rebuildPlan();
    this.clearViews();
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.rebuildPlan();
    this.clearViews();
  }

  setTier(tier: RenderTier): void {
    if (tier === this.tier) return;
    this.tier = tier;
    this.clearViews();
  }

  setBeat(beat: BeatInfo | undefined): void {
    this.beat = beat ?? null;
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
    const seen = new Map<string, number>();
    return doc.lines.map((line, i) => {
      const span = Math.max(250, line.endMs - line.startMs) / 1000;
      const density = line.words.length / span;
      const mood = this.profile?.lineMood[i];
      const key = line.text.toLowerCase().trim();
      const occurrence = seen.get(key) ?? 0;
      seen.set(key, occurrence + 1);
      const densityI = Math.max(0, Math.min(1, (density - 1.1) / 3.2));
      const meta: LineMeta = {
        intensity: mood ? densityI * 0.6 + mood.arousal * 0.4 : densityI,
        // Invert one line in roughly eight, chosen deterministically so the
        // same song always emphasises the same hooks.
        invert: !line.background && hash(line.text) % 8 === 0 && line.text.length > 3,
        occurrence,
      };
      const glyph = this.glyphs[i];
      // A repeated line keeps its glyph the first time only: the idea lands once.
      if (glyph && occurrence === 0) meta.glyph = glyph;
      return meta;
    });
  }

  /**
   * Decide every seam and every section treatment up front, from the phrase
   * list alone. Because this is planned rather than chained at spawn time,
   * seeking into the middle of a song produces exactly the frame playing
   * through to it would have.
   */
  private rebuildPlan(): void {
    const theme = this.theme;
    const sections = this.profile?.sections ?? [];
    const lineSection = this.profile?.lineSection ?? [];
    const current = lateral(theme?.motion.current ?? 'up');
    const agents = new Map<string, 0 | 1>();

    // Restore the planned-away holds first: phrases are rebuilt from lines only
    // on setLyrics, so plan edits must not accumulate across theme changes.
    const phrases = this.doc ? buildPhrases(this.doc.lines) : [];
    this.phrases = phrases;

    const plans: PhrasePlan[] = phrases.map((phrase) => {
      const si = lineSection[phrase.lineIndex];
      const section = si !== undefined ? sections[si] ?? null : null;
      const kind = section?.kind;
      const lift = kind === 'chorus' ? 1 : kind === 'bridge' ? 0.35 : 0;
      let voice: 0 | 1 = 0;
      if (phrase.agent) {
        if (!agents.has(phrase.agent)) agents.set(phrase.agent, agents.size === 0 ? 0 : 1);
        voice = agents.get(phrase.agent)!;
      }
      const line = this.doc?.lines[phrase.lineIndex];
      const endsLine = !line || phrase.words[phrase.words.length - 1]?.endMs === line.words[line.words.length - 1]?.endMs;
      return { phrase, entry: current, exit: current, section, lift, voice, still: null, endsLine };
    });

    let lastRack = -Infinity;
    const main = plans.filter((p) => !p.phrase.background);
    for (let i = 0; i < main.length; i += 1) {
      const p = main[i]!;
      const prev = main[i - 1];
      let seam: Seam = current;
      const startsSection = prev && p.section && prev.section !== p.section;
      if (startsSection && p.section!.kind === 'chorus') {
        seam = { kind: 'pull', x: 0, y: 0 };
      } else if (p.section?.kind === 'chorus' && theme?.preset !== 'calm') {
        seam = { kind: 'push', x: 0, y: 0 };
      } else if (theme?.motion.rack && p.phrase.phraseIndex === 0 && p.phrase.startMs - lastRack >= RACK_EVERY_MS && i > 0) {
        seam = { kind: 'rack', x: 0, y: 0 };
        lastRack = p.phrase.startMs;
      }
      // The second voice of a duet enters from the other side of the current.
      if (p.voice === 1 && seam.kind === 'left') seam = { kind: 'left', x: 1, y: 0 };
      p.entry = seam;
      if (prev) prev.exit = seam;

      // Stillness before the climax: hold the last phrase before a chorus,
      // dim the room, then land the chorus on the downbeat.
      if (prev && startsSection && p.section!.kind === 'chorus') {
        const gap = p.phrase.startMs - prev.phrase.endMs;
        if (gap >= STILL_MIN_MS && gap <= STILL_MAX_MS) {
          prev.still = { from: prev.phrase.endMs, to: p.phrase.startMs };
          // Hold through the gap, but be half gone by the time the chorus
          // starts arriving: the climax lands on a clear frame.
          const m = theme?.motion;
          prev.phrase.endMs = Math.max(prev.phrase.endMs, p.phrase.startMs - (m?.leadMs ?? 160) - (m?.outMs ?? 230) * 0.5);
        }
      }
    }
    const lastMain = main[main.length - 1];
    if (lastMain) lastMain.exit = current;
    this.plans = plans;
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
      this.dotsEl.style.opacity = '0';
      this.out = { impact: 0, mask: 0, dim: 0, section: 0, cam: [0, 0], sectionLabel: mode };
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

  private spawn(plan: PhrasePlan, mode: SceneMode): LineView | null {
    const theme = this.theme;
    if (!theme) return null;
    const phrase = plan.phrase;
    const meta = this.meta[phrase.lineIndex] ?? { intensity: 0.5, invert: false, occurrence: 0 };
    const bg = Boolean(phrase.background);
    const laid = layoutLine(phrase, {
      portrait: this.portrait,
      intensity: meta.intensity,
      charEm: { hero: theme.hero.charEm, support: theme.support.charEm, connective: theme.connective.charEm },
      sizeBoost: bg ? 0.42 : plan.lift >= 1 ? 1.12 : plan.lift > 0 ? 1 : 0.94,
      seedSalt: meta.occurrence ? `#${meta.occurrence}` : '',
      // The hook treatment and the glyph belong to the line, so only the
      // phrase that carries them gets them -- never every phrase in the bar.
      ...(meta.invert && phrase.carriesGlyph ? { invert: true } : {}),
      ...(meta.glyph && phrase.carriesGlyph ? { glyph: meta.glyph } : {}),
    });

    const r = hash(`${phrase.text}|${phrase.lineIndex}|${phrase.phraseIndex}`);
    const tilt = this.reducedMotion ? 0 : theme.motion.tiltDeg;
    const tiltX = (((r & 0xff) / 255) - 0.5) * 2 * tilt * 0.6;
    const tiltY = ((((r >> 8) & 0xff) / 255) - 0.5) * 2 * tilt;
    const motion = this.reducedMotion ? { ...theme.motion, smear: 0, slam: 1 } : theme.motion;

    const view = new LineView(phrase, laid, {
      entry: plan.entry,
      exit: plan.exit,
      tier: this.tier,
      // Interpolated timings are a guess, so the motion stays calmer and the
      // trails come off -- aggressive per-word motion would advertise the error.
      quality: mode === 'line' ? 'lite' : 'high',
      motion,
      tiltX,
      tiltY,
      section: plan.lift,
      endsLine: plan.endsLine,
      heroVariable: Boolean(theme.hero.variable),
      echoLayout: this.tier === 'cinema' && plan.lift >= 1 && theme.preset !== 'calm' && phrase.carriesGlyph && !bg
        ? { mirror: meta.occurrence % 2 === 1 }
        : null,
      background: bg,
    });
    if (plan.voice === 1) view.el.dataset['voice'] = '1';
    return view;
  }

  private updateLines(posMs: number, mode: SceneMode): void {
    if (!this.plans.length) {
      this.out = { impact: 0, mask: 0, dim: 0, section: 0, cam: [0, 0], sectionLabel: '' };
      return;
    }

    for (const plan of this.plans) {
      const phrase = plan.phrase;
      // Ad-libs are an extra layer; Smooth spends its budget on the lead voice.
      if (phrase.background && this.tier === 'smooth') continue;
      const key = `${phrase.lineIndex}:${phrase.phraseIndex}`;
      if (this.views.has(key)) continue;
      if (posMs < phrase.startMs - 700) continue;
      if (posMs > phrase.endMs + 250) continue;
      const view = this.spawn(plan, mode);
      if (!view) continue;
      this.typeEl.appendChild(view.el);
      // Measure now that it is in the document; estimated widths are never
      // exact and a bar that overflows the frame is the worst failure there is.
      view.fitToFrame(this.typeEl);
      this.views.set(key, { view, plan });
    }

    let impact = 0;
    let mask = 0;
    let dim = 0;
    let lead: { key: string; view: LineView; p: number } | null = null;
    for (const [key, { view, plan }] of this.views) {
      if (!view.update(posMs)) {
        view.destroy();
        this.views.delete(key);
        continue;
      }
      if (plan.phrase.background) continue;
      impact = Math.max(impact, view.impact(posMs));
      const presence = view.heroPresence(posMs);
      mask = Math.max(mask, presence);
      // Only a landed hero: mid-entry it is still a rise away from its place.
      if (presence > 0.95 && (!lead || presence > lead.p)) lead = { key, view, p: presence };
      if (plan.still && posMs >= plan.still.from && posMs < plan.still.to) {
        dim = Math.max(dim, 0.2 * smoothstep(plan.still.from, plan.still.to, posMs));
      }
    }

    // The light spill follows whichever hero is actually on screen, not the
    // phrase that was spawned most recently (that one is still arriving).
    if (lead && this.tier === 'cinema') this.drawMask(lead.view, lead.key);

    // Section camera: one slow move per section, never per beat.
    const sections = this.profile?.sections ?? [];
    const si = sectionAt(sections, posMs);
    const sec = si >= 0 ? sections[si]! : null;
    let tx = 0;
    let scale = 1;
    let label = '';
    if (sec && !this.reducedMotion) {
      const p = clamp01((posMs - sec.startMs) / Math.max(1, sec.endMs - sec.startMs));
      label = `${sec.kind}${sec.occurrence ? ` ${sec.occurrence + 1}` : ''}`;
      if (sec.kind === 'verse' || sec.kind === 'intro' || sec.kind === 'outro') {
        const dir = sec.occurrence % 2 === 0 ? 1 : -1;
        tx = dir * (-1 + 2 * p);
      } else if (sec.kind === 'chorus') {
        scale = 1 + 0.025 * p;
      } else if (sec.kind === 'bridge') {
        scale = 1.03 - 0.03 * p;
      }
    }
    this.typeEl.style.transform = tx || scale !== 1
      ? `translate3d(${tx.toFixed(3)}%, 0, 0) scale(${scale.toFixed(4)})`
      : '';

    // Chorus-ness for the stage: the lyric structure says where the chorus is,
    // the live energy says how hard it is hitting right now.
    const energy = this.beat?.energy ?? null;
    let section = sec?.kind === 'chorus' ? 1 : sec?.kind === 'bridge' ? 0.3 : 0;
    if (energy !== null) section = sec ? section * (0.55 + 0.45 * energy) : Math.max(0, energy - 0.75) * 2;

    this.out = { impact, mask, dim, section, cam: [tx * 0.004, (scale - 1) * 0.3], sectionLabel: label };
    this.updateDots(posMs);
  }

  /**
   * Breathing dots for an instrumental gap, the way Apple Music fills one:
   * three dots at the anchor that breathe with the beat, in before the gap
   * is noticed and out just before the voice comes back.
   */
  private updateDots(posMs: number): void {
    let prevEnd = -Infinity;
    let nextStart = Infinity;
    for (const plan of this.plans) {
      if (plan.phrase.background) continue;
      const end = plan.phrase.endMs + (this.theme?.motion.outMs ?? 230);
      if (end <= posMs) prevEnd = Math.max(prevEnd, end);
      if (plan.phrase.startMs > posMs) {
        nextStart = Math.min(nextStart, plan.phrase.startMs);
        break;
      }
      if (plan.phrase.startMs <= posMs && end > posMs) {
        prevEnd = Infinity; // a phrase is on screen
        break;
      }
    }
    let o = 0;
    if (Number.isFinite(prevEnd) && Number.isFinite(nextStart) && nextStart - prevEnd >= DOTS_MIN_GAP_MS) {
      o = clamp01((posMs - prevEnd - 300) / 400) * (1 - clamp01((posMs - (nextStart - 900)) / 500));
    } else if (prevEnd === -Infinity && Number.isFinite(nextStart) && nextStart - posMs > 2500) {
      o = 1 - clamp01((posMs - (nextStart - 900)) / 500);
    }
    this.dotsEl.style.opacity = o.toFixed(3);
    if (o <= 0) return;
    const phase = this.beat && this.beat.bpm > 0 ? this.beat.phase : ((posMs / 1000) * 0.5) % 1;
    const dots = this.dotsEl.children;
    for (let i = 0; i < dots.length; i += 1) {
      const ph = (phase + i * 0.18) % 1;
      const b = 0.72 + 0.28 * Math.pow(Math.cos(ph * Math.PI), 2);
      (dots[i] as HTMLElement).style.transform = `scale(${b.toFixed(3)})`;
    }
  }

  /**
   * The hero's blurred silhouette in frame space, which the stage adds as
   * light: the word sits in a pool of its own glow at no DOM filter cost.
   */
  private drawMask(view: LineView, key: string): void {
    if (key === this.maskKey || !this.onMask) return;
    const info = view.heroRect();
    if (!info || info.rect.width <= 0) return;
    this.maskKey = key;
    const c = this.maskCanvas;
    const W = 320;
    const H = Math.max(90, Math.round((W * window.innerHeight) / Math.max(1, window.innerWidth)));
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const k = W / window.innerWidth;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.filter = 'blur(7px)';
    ctx.fillStyle = '#fff';
    const px = parseFloat(info.font.split(' ')[2] ?? '100') * k;
    ctx.font = info.font.replace(/(\d+(\.\d+)?)px/, `${px.toFixed(1)}px`);
    ctx.textBaseline = 'middle';
    ctx.fillText(info.text, info.rect.left * k, (info.rect.top + info.rect.height / 2) * k);
    ctx.filter = 'blur(16px)';
    ctx.globalAlpha = 0.8;
    ctx.fillText(info.text, info.rect.left * k, (info.rect.top + info.rect.height / 2) * k);
    this.onMask(c);
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
    for (const { view } of this.views.values()) view.destroy();
    this.views.clear();
    this.maskKey = '';
  }

  get activeLineCount(): number {
    return this.views.size;
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
const escapeAttr = escapeHtml;
