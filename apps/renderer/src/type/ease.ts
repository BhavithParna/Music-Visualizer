export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Fast start, long settle. The entry curve for every word. */
export const power4Out = (t: number): number => 1 - Math.pow(1 - clamp01(t), 4);
export const power2Out = (t: number): number => 1 - Math.pow(1 - clamp01(t), 2);
export const power2In = (t: number): number => clamp01(t) ** 2;
/** Slight overshoot, used only by the glyph pop. */
export const backOut = (t: number, s = 1.9): number => {
  const x = clamp01(t) - 1;
  return x * x * ((s + 1) * x + s) + 1;
};
export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
export const power3In = (t: number): number => clamp01(t) ** 3;
export const power4In = (t: number): number => clamp01(t) ** 4;
export const expoOut = (t: number): number => {
  const x = clamp01(t);
  return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x);
};
export const smoothstep = (a: number, b: number, v: number): number => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** Cubic bezier easing with P0=(0,0), P3=(1,1), solved by Newton iteration. */
export function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (u: number): number => ((ax * u + bx) * u + cx) * u;
  const sy = (u: number): number => ((ay * u + by) * u + cy) * u;
  const dx = (u: number): number => (3 * ax * u + 2 * bx) * u + cx;
  return (t: number): number => {
    const x = clamp01(t);
    let u = x;
    for (let i = 0; i < 6; i += 1) {
      const d = dx(u);
      if (Math.abs(d) < 1e-6) break;
      u -= (sx(u) - x) / d;
    }
    return sy(clamp01(u));
  };
}
