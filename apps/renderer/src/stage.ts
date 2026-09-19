import { applyPalette, DEFAULT_PALETTE, paletteFromImage, type StagePalette } from './palette.js';

/** Tiled film grain, generated once so nothing has to ship a noise texture. */
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

/**
 * The background: blurred album art, grain, vignette, and a slow drift.
 *
 * The art lives in a 64px canvas that the compositor scales to fill the screen,
 * so the blur is paid for at 64x64 instead of at panel resolution.
 */
export class Stage {
  private canvas = document.getElementById('art') as HTMLCanvasElement;
  private ctx = this.canvas.getContext('2d');
  private grainEl = document.getElementById('grain') as HTMLElement;
  private phase = 0;
  private lastFrame = 0;
  private currentArt = '';
  palette: StagePalette = DEFAULT_PALETTE;

  constructor() {
    document.documentElement.style.setProperty('--grain-src', grainDataUrl());
    applyPalette(DEFAULT_PALETTE);
  }

  /** Load new art, derive the palette from it, and cross-fade it in. */
  async setArt(url: string | undefined): Promise<void> {
    if (url === this.currentArt) return;
    this.currentArt = url ?? '';

    if (!url) {
      this.canvas.classList.remove('on');
      this.palette = DEFAULT_PALETTE;
      applyPalette(DEFAULT_PALETTE);
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

    this.palette = paletteFromImage(img);
    applyPalette(this.palette);

    if (this.ctx) {
      // Cover-crop the square-ish art into the 64px buffer.
      const { width: cw, height: ch } = this.canvas;
      const scale = Math.max(cw / img.width, ch / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      this.ctx.clearRect(0, 0, cw, ch);
      this.ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
    }
    this.canvas.classList.add('on');
  }

  /**
   * Drift the background.
   *
   * Phase is integrated rather than derived from absolute time, so when the
   * rate changes with the music the motion bends instead of jumping. Audio
   * reactivity turns the drift; it never accelerates it, because acceleration
   * reads as fast-forward.
   */
  frame(now: number, bass = 0): void {
    const dt = this.lastFrame ? Math.min(0.05, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    this.phase += dt * 0.055;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 64px canvas -> full bleed, with headroom for the drift.
    const fill = (Math.max(vw, vh) / 64) * 1.35;
    const breathe = 1 + Math.sin(this.phase * 0.9) * 0.035 + bass * 0.02;
    const dx = Math.sin(this.phase * 0.7) * 3.2;
    const dy = Math.cos(this.phase * 0.53) * 2.6;

    this.canvas.style.transform =
      `translate(-50%, -50%) translate3d(${dx.toFixed(2)}%, ${dy.toFixed(2)}%, 0) ` +
      `scale(${(fill * breathe).toFixed(3)})`;

    this.grainEl.style.transform =
      `translate3d(${(Math.sin(this.phase * 11) * 1.2).toFixed(2)}%, ${(Math.cos(this.phase * 9) * 1.2).toFixed(2)}%, 0)`;
  }
}
