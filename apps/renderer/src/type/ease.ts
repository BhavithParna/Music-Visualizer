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
