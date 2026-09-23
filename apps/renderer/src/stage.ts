import {
  applyPalette, DEFAULT_PALETTE, gradePalette, paletteFromImage, type StagePalette,
} from './palette.js';
import { GLStage, type StageInputs } from './stage/gl.js';

export type { StageInputs } from './stage/gl.js';

/** Tiled film grain for the canvas fallback, generated once. */
function grainDataUrl(size = 180): string {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 110 + Math.random() * 90;
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return `url("${c.toDataURL('image/png')}")`;
}

const ART_PX = 64;

/**
 * The cover as the aureole wants it: tiny, oversaturated, contrasty and soft
 * (AMLL's recipe for the Apple Music background). At 64 px this is free, and
 * bilinear sampling of a pre-blurred image upscales without any blocking.
 */
function processArt(img: HTMLImageElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = ART_PX;
  c.height = ART_PX;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  const scale = Math.max(ART_PX / img.width, ART_PX / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.filter = 'saturate(2.4) contrast(1.35) brightness(0.8) blur(1.6px)';
  // Overdraw the edges so the blur does not pull in transparent black.
  ctx.drawImage(img, (ART_PX - w) / 2 - 4, (ART_PX - h) / 2 - 4, w + 8, h + 8);
  return c;
}

/** With no cover, a soft arrangement of the palette stands in for it. */
function paletteArt(p: StagePalette): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = ART_PX;
  c.height = ART_PX;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  const css = (rgb: number[], a = 1): string =>
    `rgba(${Math.round(rgb[0]! * 255)},${Math.round(rgb[1]! * 255)},${Math.round(rgb[2]! * 255)},${a})`;
  ctx.fillStyle = css(p.swatches[2]!);
  ctx.fillRect(0, 0, ART_PX, ART_PX);
  const blobs: [number, number, number, number][] = [[0.3, 0.35, 0.5, 0], [0.72, 0.6, 0.42, 1], [0.45, 0.8, 0.35, 4], [0.8, 0.2, 0.3, 3]];
  for (const [x, y, r, i] of blobs) {
    const g = ctx.createRadialGradient(x * ART_PX, y * ART_PX, 0, x * ART_PX, y * ART_PX, r * ART_PX);
    g.addColorStop(0, css(p.swatches[i]!, i === 3 ? 0.35 : 0.85));
    g.addColorStop(1, css(p.swatches[i]!, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, ART_PX, ART_PX);
  }
  return c;
}

/**
 * The background. A WebGL2 shader stage when the GPU offers one; otherwise the
 * original treatment -- a 64 px blurred cover the compositor scales up, with
 * DOM grain and vignette -- which still looks right, just without the looks.
 */
export class Stage {
  private canvas = document.getElementById('art') as HTMLCanvasElement;
  private ctx = this.canvas.getContext('2d');
  private grainEl = document.getElementById('grain') as HTMLElement;
  private stageEl = document.getElementById('stage') as HTMLElement;
  private gl: GLStage | null;
  private phase = 0;
  private lastFrame = 0;
  private currentArt = '';
  private hasArt = false;
  /** The cover's own palette, before the song's mood grade. */
  private raw: StagePalette = DEFAULT_PALETTE;
  private grade = { temperature: 0, saturation: 1 };
  palette: StagePalette = DEFAULT_PALETTE;

  constructor() {
    const glCanvas = document.getElementById('gl') as HTMLCanvasElement;
    this.gl = GLStage.create(glCanvas);
    if (this.gl) {
      this.stageEl.classList.add('gl');
    } else {
      glCanvas.remove();
      document.documentElement.style.setProperty('--grain-src', grainDataUrl());
    }
    this.applyAll();
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>)['__lrStage'] = this;
  }

  /** Dev aid, see GLStage.debugRead. */
  debugRead(i: StageInputs): unknown {
    return this.gl?.debugRead({ ...i, scrim: this.palette.scrim * 0.75 }) ?? null;
  }

  get webgl(): boolean {
    return this.gl !== null;
  }

  get renderer(): string {
    return this.gl?.renderer ?? 'canvas';
  }

  get gpuMs(): number | null {
    return this.gl?.gpuMs ?? null;
  }

  /** The song's mood grade: warm or cool, more or less saturated. */
  setGrade(temperature: number, saturation: number): void {
    if (Math.abs(temperature - this.grade.temperature) < 1e-3 && Math.abs(saturation - this.grade.saturation) < 1e-3) return;
    this.grade = { temperature, saturation };
    this.applyAll();
  }

  private applyAll(): void {
    this.palette = gradePalette(this.raw, this.grade.temperature, this.grade.saturation);
    applyPalette(this.palette);
    if (this.gl) {
      this.gl.setPalette(this.palette.swatches);
      if (!this.hasArt) this.gl.setArt(paletteArt(this.palette));
    }
  }

  /** Load new art, derive the palette from it, and cross-fade it in. */
  async setArt(url: string | undefined): Promise<void> {
    if (url === this.currentArt) return;
    this.currentArt = url ?? '';

    if (!url) {
      this.canvas.classList.remove('on');
      this.hasArt = false;
      this.raw = DEFAULT_PALETTE;
      this.applyAll();
      return;
    }

    const img = new Image();
    // Daemon-proxied art is same-origin, which is what lets us read the pixels.
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    try {
      img.src = url;
      await img.decode();
    } catch {
      return;
    }
    if (this.currentArt !== url) return;

    this.raw = paletteFromImage(img);
    this.hasArt = true;
    this.applyAll();

    if (this.gl) {
      this.gl.setArt(processArt(img));
    } else if (this.ctx) {
      const { width: cw, height: ch } = this.canvas;
      const scale = Math.max(cw / img.width, ch / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      this.ctx.clearRect(0, 0, cw, ch);
      this.ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
      this.canvas.classList.add('on');
    }
  }

  /** Hero light spill (Cinema): the hero word's blurred shape, in frame space. */
  setMask(src: HTMLCanvasElement): void {
    this.gl?.setMask(src);
  }

  frame(i: StageInputs): void {
    if (this.gl) {
      this.gl.frame({ ...i, scrim: this.palette.scrim * 0.75 });
      return;
    }

    // Canvas fallback. Phase is integrated rather than derived from absolute
    // time, so when the rate changes with the music the motion bends instead
    // of jumping.
    const dt = this.lastFrame ? Math.min(0.05, (i.now - this.lastFrame) / 1000) : 0;
    this.lastFrame = i.now;
    this.phase += dt * 0.055 * (0.7 + i.energy * 0.6);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const fill = (Math.max(vw, vh) / 64) * 1.35;
    const breathe = 1 + i.bass * 0.02 + i.impact * 0.015;
    const dx = Math.sin(this.phase * 0.7) * 3.2 + i.cam[0] * 20;
    const dy = Math.cos(this.phase * 0.53) * 2.6 + i.cam[1] * 20;
    this.canvas.style.transform =
      `translate(-50%, -50%) translate3d(${dx.toFixed(2)}%, ${dy.toFixed(2)}%, 0) ` +
      `scale(${(fill * breathe).toFixed(3)})`;
    this.grainEl.style.transform =
      `translate3d(${(Math.sin(this.phase * 11) * 1.2).toFixed(2)}%, ${(Math.cos(this.phase * 9) * 1.2).toFixed(2)}%, 0)`;
    this.stageEl.style.setProperty('--stage-dim', i.dim.toFixed(3));
  }
}
