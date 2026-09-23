export type RGB = [number, number, number];

export interface StagePalette {
  stage: string;
  ink: string;
  accent: string;
  dim: string;
  luminance: number;
  scrim: number;
  /** Accent hue 0..1, kept so a mood grade can move it. */
  hue: number;
  /**
   * Five swatches for the shader stage, 0..1 RGB:
   * [dominant, accent, dark, light, muted].
   */
  swatches: RGB[];
}

/** The look when there is no art to sample: near-black stage, cream ink, gold accent. */
export const DEFAULT_PALETTE: StagePalette = {
  stage: '#0b0b0c',
  ink: '#f1efe8',
  accent: '#e8b86d',
  dim: 'rgba(241,239,232,0.5)',
  luminance: 0,
  scrim: 0.55,
  hue: 0.105,
  swatches: [
    [0.16, 0.11, 0.07], [0.91, 0.72, 0.43], [0.03, 0.025, 0.02], [0.95, 0.9, 0.8], [0.35, 0.28, 0.2],
  ],
};

const clamp = (v: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, v));

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6;
  else if (max === gg) h = ((bb - rr) / d + 2) / 6;
  else h = ((rr - gg) / d + 4) / 6;
  return [h, s, l];
}

export function hslToRgb(h: number, s: number, l: number): RGB {
  const H = ((h % 1) + 1) % 1;
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [f(H + 1 / 3), f(H), f(H - 1 / 3)];
}

function hslToCss(h: number, s: number, l: number, a = 1): string {
  const H = ((h % 1) + 1) % 1;
  return a >= 1
    ? `hsl(${(H * 360).toFixed(1)} ${(s * 100).toFixed(1)}% ${(l * 100).toFixed(1)}%)`
    : `hsl(${(H * 360).toFixed(1)} ${(s * 100).toFixed(1)}% ${(l * 100).toFixed(1)}% / ${a})`;
}

/**
 * Pull a palette out of album art.
 *
 * Runs on a 32x32 downsample, buckets pixels in HSL space by population, then
 * grades the result warm: the reference look is not "whatever colour the cover
 * is", it is a warm gold-and-cream treatment that the cover only tints.
 *
 * The art must be same-origin (the daemon proxies it at /art/) or the canvas
 * becomes tainted and getImageData throws.
 */
export function paletteFromImage(img: HTMLImageElement): StagePalette {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return DEFAULT_PALETTE;
  ctx.drawImage(img, 0, 0, size, size);

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, size, size).data;
  } catch {
    // Cross-origin art: we can still show it, we just cannot read it.
    return DEFAULT_PALETTE;
  }

  const buckets = new Map<number, { n: number; h: number; s: number; l: number; sMax: number }>();
  let lumSum = 0;
  let count = 0;

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]!;
    if (a < 128) continue;
    const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
    const [h, s, l] = rgbToHsl(r, g, b);
    lumSum += l;
    count += 1;
    // 24 hue bins x 4 lightness bins is enough structure without over-splitting.
    const key = Math.floor(h * 24) * 4 + Math.min(3, Math.floor(l * 4));
    const cur = buckets.get(key) ?? { n: 0, h: 0, s: 0, l: 0, sMax: 0 };
    cur.n += 1;
    cur.h += h;
    cur.s += s;
    cur.l += l;
    if (s > cur.sMax) cur.sMax = s;
    buckets.set(key, cur);
  }
  if (count === 0) return DEFAULT_PALETTE;

  // A bucket's mean saturation understates it badly on a photographic cover:
  // one red car averaged against the night around it comes out grey. Lean the
  // representative saturation towards the most vivid pixel in the bucket, so
  // the colour the eye actually reads off the sleeve is the one we use.
  const entries = [...buckets.values()].map((b) => ({
    h: b.h / b.n, s: Math.max(b.s / b.n, b.sMax * 0.75), l: b.l / b.n, n: b.n,
  }));

  // Accent: colourful and mid-bright, weighted by how much of the cover it is.
  const accentPick = entries
    .map((e) => ({ e, score: e.s * 1.8 + (1 - Math.abs(e.l - 0.55) * 2) + Math.log1p(e.n) * 0.22 }))
    .sort((a, b) => b.score - a.score)[0]?.e;

  const luminance = lumSum / count;

  // The cover's own hue, kept. This used to be dragged 45% towards a house
  // gold, which is why every record -- blue, green, magenta -- came out the
  // same warm cream and no song looked like its sleeve.
  const ah = accentPick?.h ?? 0.105;
  const as = clamp((accentPick?.s ?? 0.5) * 1.25 + 0.16, 0.42, 0.92);
  const al = clamp((accentPick?.l ?? 0.6) * 0.55 + 0.34, 0.48, 0.72);

  // Stage: very dark, tinted by the cover so it never reads as pure black.
  const stage = hslToCss(ah, clamp(as * 0.45, 0.06, 0.32), 0.045);
  // Ink: still light enough to carry huge type over art, but tinted far enough
  // to read as *this* record's colour rather than as generic cream. A washed
  // or monochrome cover has a low `as` and lands back near white on its own.
  const ink = hslToCss(ah, clamp(0.16 + as * 0.45, 0.2, 0.56), 0.92);
  const accent = hslToCss(ah, as, al);

  // Shader swatches. The dominant colour is the cover's largest area; dark and
  // light are its extremes pulled into a usable range, so a stage built from
  // them keeps the cover's shape of colour, not just its accent.
  const byPop = [...entries].sort((a, b) => b.n - a.n);
  const dom = byPop[0] ?? { h: ah, s: 0.4, l: 0.3 };
  const darkest = [...entries].sort((a, b) => a.l - b.l)[0] ?? dom;
  const lightest = [...entries].sort((a, b) => b.l - a.l)[0] ?? dom;
  const muted = byPop.find((e) => Math.abs(e.h - ah) > 0.08 && e.s > 0.12) ?? byPop[1] ?? dom;
  const swatches: RGB[] = [
    hslToRgb(dom.h, clamp(dom.s * 1.2, 0.15, 0.85), clamp(dom.l, 0.14, 0.42)),
    hslToRgb(ah, as, al),
    hslToRgb(darkest.h, clamp(darkest.s, 0.1, 0.6), clamp(darkest.l * 0.6, 0.02, 0.08)),
    hslToRgb(lightest.h, clamp(lightest.s, 0.1, 0.7), clamp(lightest.l, 0.62, 0.86)),
    hslToRgb(muted.h, clamp(muted.s * 1.1, 0.12, 0.7), clamp(muted.l, 0.2, 0.5)),
  ];

  return {
    stage,
    ink,
    accent,
    hue: ah,
    swatches,
    // The unsung half of the karaoke sweep: the same colour as the ink, just
    // held back, so a word doesn't change hue as it is sung -- only strength.
    dim: hslToCss(ah, clamp(0.14 + as * 0.4, 0.18, 0.5), 0.87, 0.5),
    luminance,
    // Bright covers need a heavier scrim to keep the type legible over them.
    scrim: clamp(0.3 + luminance * 0.4, 0.3, 0.72),
  };
}

/**
 * Grade a palette by the song's mood: warm and saturated for bright, intense
 * songs, cool and quiet for sad, calm ones. The cover stays the source -- the
 * grade only leans on it -- so a blue record stays blue, just a colder blue.
 */
export function gradePalette(p: StagePalette, temperature: number, saturation: number): StagePalette {
  if (Math.abs(temperature) < 0.02 && Math.abs(saturation - 1) < 0.02) return p;
  const target = temperature >= 0 ? 0.075 : 0.6;
  const pull = Math.min(0.35, Math.abs(temperature) * 0.35);
  const move = (rgb: RGB): RGB => {
    const [h, s, l] = rgbToHsl(rgb[0] * 255, rgb[1] * 255, rgb[2] * 255);
    let d = target - h;
    if (d > 0.5) d -= 1;
    if (d < -0.5) d += 1;
    return hslToRgb(h + d * pull, clamp(s * saturation), l);
  };
  const swatches = p.swatches.map(move);
  let dh = target - p.hue;
  if (dh > 0.5) dh -= 1;
  if (dh < -0.5) dh += 1;
  const hue = p.hue + dh * pull;
  const acc = swatches[1]!;
  const [, as, al] = rgbToHsl(acc[0] * 255, acc[1] * 255, acc[2] * 255);
  return {
    ...p,
    hue,
    swatches,
    accent: hslToCss(hue, clamp(as), clamp(al, 0.48, 0.74)),
    ink: hslToCss(hue, clamp(0.16 + as * 0.4, 0.18, 0.52), 0.92),
    stage: hslToCss(hue, clamp(as * 0.4, 0.06, 0.3), 0.045),
  };
}

export function applyPalette(p: StagePalette): void {
  const root = document.documentElement.style;
  root.setProperty('--stage', p.stage);
  root.setProperty('--ink', p.ink);
  root.setProperty('--accent', p.accent);
  root.setProperty('--dim', p.dim);
  root.setProperty('--scrim', String(p.scrim));
}
