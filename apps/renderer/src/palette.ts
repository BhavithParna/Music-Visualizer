export interface StagePalette {
  stage: string;
  ink: string;
  accent: string;
  dim: string;
  luminance: number;
  scrim: number;
}

/** The look when there is no art to sample: near-black stage, cream ink, gold accent. */
export const DEFAULT_PALETTE: StagePalette = {
  stage: '#0b0b0c',
  ink: '#f1efe8',
  accent: '#e8b86d',
  dim: 'rgba(241,239,232,0.5)',
  luminance: 0,
  scrim: 0.55,
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

  return {
    stage,
    ink,
    accent,
    // The unsung half of the karaoke sweep: the same colour as the ink, just
    // held back, so a word doesn't change hue as it is sung -- only strength.
    dim: hslToCss(ah, clamp(0.14 + as * 0.4, 0.18, 0.5), 0.87, 0.5),
    luminance,
    // Bright covers need a heavier scrim to keep the type legible over them.
    scrim: clamp(0.3 + luminance * 0.4, 0.3, 0.72),
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
