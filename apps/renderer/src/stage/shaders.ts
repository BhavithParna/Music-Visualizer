/**
 * GLSL for the shader stage. Every look writes into a small offscreen target
 * (960x540 in Cinema, 480x270 in Smooth); the post pass upscales it with
 * vignette and the rest. The looks are soft by design, so the low
 * internal resolution costs nothing you can see and is the whole reason this
 * stays cheap at 4K.
 */

export const QUAD_VS = /* glsl */ `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const HEADER = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uPal[5];
uniform sampler2D uArt0;
uniform sampler2D uArt1;
uniform float uArtMix;
uniform float uBass, uKick, uSnare, uHat, uEnergy, uSection, uImpact;
uniform vec2 uMood;
uniform float uHi;
uniform vec2 uCam;
uniform sampler2D uDye;
uniform float uHasDye;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x),
             mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p, int oct) {
  float a = 0.5, s = 0.0;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    s += a * vnoise(p);
    p = m * p;
    a *= 0.5;
  }
  return s;
}
vec2 rot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
vec3 art(vec2 uv) { return mix(texture(uArt0, uv).rgb, texture(uArt1, uv).rgb, uArtMix); }
/** Centred, aspect-corrected coordinates: y in -0.5..0.5. */
vec2 frameP() { vec2 p = vUv - 0.5; p.x *= uRes.x / uRes.y; return p; }
vec3 screenBlend(vec3 a, vec3 b) { return 1.0 - (1.0 - a) * (1.0 - b); }
`;

/**
 * Aureole: the album art as a soft, layered field. Copies of the processed
 * cover at different sizes, each turned a little and drifting very slowly,
 * blended so the record's colours pool together. Nothing spins or twists: the
 * stage is close to still, and only breathes with the music.
 */
const AUREOLE = HEADER + /* glsl */ `
vec4 layer(vec2 p, vec2 c, float size, float ang) {
  vec2 q = rot((p - c) / size, ang);
  float d = length(q);
  vec3 col = art(clamp(q + 0.5, 0.0, 1.0));
  return vec4(col, smoothstep(0.72, 0.2, d));
}
void main() {
  vec2 p = frameP() + uCam * 0.4;
  float asp = uRes.x / uRes.y;
  // Very slow: a full drift cycle takes minutes, not seconds.
  float t = uTime * 0.02;
  float big = max(asp, 1.0) * 1.414;
  float breathe = 1.0 + 0.012 * uBass;
  vec3 col = layer(p, vec2(sin(t * 0.7), cos(t * 0.5)) * 0.03, big * 1.1 * breathe, 0.0).rgb;
  vec4 l2 = layer(p, vec2(cos(t * 0.6), sin(t * 0.8)) * vec2(0.08 * asp, 0.05), big * 0.72 * breathe, 0.9 + sin(t * 0.3) * 0.05);
  col = mix(col, l2.rgb, l2.a * 0.6);
  if (uHi > 0.5) {
    vec4 l3 = layer(p, vec2(sin(t * 0.5 + 1.0), cos(t * 0.4 + 2.0)) * vec2(0.18 * asp, 0.12), 0.55 * asp * breathe, -1.7);
    col = mix(col, l3.rgb, l3.a * 0.45);
  }
  float g = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(g), col, 1.15 + 0.15 * uSection);
  col *= 0.86 + 0.14 * uEnergy + 0.08 * uImpact;
  outColor = vec4(col, 1.0);
}`;

/** Smoke: Inigo Quilez domain-warped fbm, lit by a slowly travelling light. */
const SMOKE = HEADER + /* glsl */ `
void main() {
  vec2 p = frameP() * 2.2 + uCam * 0.6;
  int oct = uHi > 0.5 ? 5 : 3;
  float t = uTime * 0.12;
  vec2 q = vec2(fbm(p + vec2(0.0, t), oct), fbm(p + vec2(5.2, 1.3) - t, oct));
  float amp = 3.2 + 1.4 * uBass + 0.8 * uSection;
  vec2 r = vec2(fbm(p + amp * q + vec2(1.7, 9.2) + 0.15 * t, oct),
                fbm(p + amp * q + vec2(8.3, 2.8) + 0.126 * t, oct));
  float f = fbm(p + amp * r, oct);
  vec3 col = mix(uPal[2], uPal[0], clamp(f * f * 3.2, 0.0, 1.0));
  col = mix(col, uPal[4], clamp(length(q) * 0.7, 0.0, 1.0));
  col = mix(col, uPal[1], clamp(r.x * r.x * 0.9, 0.0, 1.0) * 0.55);
  col *= (f * f * f + 0.6 * f * f + 0.5 * f) * 1.55;
  vec2 lp = vec2(sin(uTime * 0.05) * 0.6, 0.25 + cos(uTime * 0.037) * 0.15);
  float light = exp(-length(frameP() - lp) * 2.4);
  col += uPal[3] * light * (0.1 + 0.12 * uEnergy + 0.1 * uImpact);
  outColor = vec4(col, 1.0);
}`;

/**
 * Ink. In Cinema the colour comes from the fluid simulation's dye; without it
 * (Smooth, or no float targets) a few palette blobs are advected through an
 * fbm flow field, which reads as ink for a fraction of the cost.
 */
const INK = HEADER + /* glsl */ `
void main() {
  vec2 fp = frameP();
  float asp = uRes.x / uRes.y;
  vec3 base = mix(uPal[2], uPal[0] * 0.45, smoothstep(0.6, -0.6, fp.y));
  vec3 col = base;
  if (uHasDye > 0.5) {
    vec3 dye = texture(uDye, vUv).rgb;
    col = base + dye * 1.7;
  } else {
    vec2 p = fp * 1.4 + uCam * 0.5;
    float t = uTime * 0.35;
    vec2 w = vec2(fbm(p * 1.3 + vec2(t * 0.2, 0.0), 3), fbm(p * 1.3 + vec2(0.0, t * 0.23) + 4.0, 3));
    p += (w - 0.5) * (1.2 + 0.9 * uBass);
    for (int i = 0; i < 5; i++) {
      float fi = float(i);
      vec2 c = vec2(sin(t * (0.3 + 0.1 * fi) + fi * 1.7), cos(t * (0.27 + 0.07 * fi) + fi * 2.3)) * vec2(0.62 * asp, 0.42);
      float d = length(p - c);
      vec3 ink = i == 0 ? uPal[1] : i == 1 ? uPal[4] : i == 2 ? uPal[0] * 1.6 : i == 3 ? uPal[3] * 0.6 : uPal[1] * 0.7;
      col += ink * smoothstep(0.62, 0.0, d) * 0.42;
    }
  }
  col *= 0.9 + 0.2 * uImpact + 0.1 * uKick;
  outColor = vec4(col, 1.0);
}`;

/** Night city: a dark plate, bokeh at three depths, a light streak on the kick. */
const NIGHT = HEADER + /* glsl */ `
void main() {
  vec2 p = frameP();
  float asp = uRes.x / uRes.y;
  vec3 col = mix(uPal[2] * 0.9, uPal[0] * 0.38, smoothstep(0.55, -0.55, p.y));
  col += uPal[1] * 0.1 * exp(-pow((p.y + 0.55) * 3.0, 2.0));
  int n = uHi > 0.5 ? 72 : 28;
  for (int i = 0; i < 72; i++) {
    if (i >= n) break;
    float fi = float(i);
    float depth = fract(fi * 0.618034);
    float dir = hash12(vec2(fi, 7.0)) > 0.5 ? 1.0 : -1.0;
    vec2 c = vec2(fract(hash12(vec2(fi, 1.0)) + uTime * (0.004 + 0.012 * depth) * dir), hash12(vec2(fi, 3.0)));
    c = (c - 0.5) * vec2(asp * 1.25, 1.15) + uCam * (0.2 + depth * 0.8);
    float r = mix(0.012, 0.075, depth * depth) * (1.0 + 0.22 * uBass);
    float d = length(p - c);
    float disc = smoothstep(r, r * 0.72, d) * 0.55 + exp(-d * d / (r * r * 2.2)) * 0.35;
    vec3 bc = mix(uPal[1], uPal[3], hash12(vec2(fi, 9.0))) * mix(0.3, 1.0, depth);
    col += bc * disc * (0.22 + 0.4 * depth);
  }
  float streak = exp(-abs(p.y - 0.04) * 38.0) * smoothstep(1.3, 0.0, abs(p.x));
  col += uPal[1] * streak * (uKick * 0.3 + uImpact * 0.18);
  col *= 0.92 + 0.16 * uEnergy;
  outColor = vec4(col, 1.0);
}`;

/** Sunlit: a warm field, big soft light leaks, god rays in Cinema. */
const SUNLIT = HEADER + /* glsl */ `
void main() {
  vec2 p = frameP() + uCam * 0.3;
  float asp = uRes.x / uRes.y;
  float t = uTime;
  vec3 col = mix(uPal[2] * 1.3, uPal[0] * 0.8, smoothstep(-0.6, 0.6, p.y));
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec2 c = vec2(sin(t * (0.04 + 0.013 * fi) + fi * 2.1) * 0.55 * asp, 0.35 - fi * 0.28 + cos(t * 0.03 + fi) * 0.12);
    float d = length(p - c);
    vec3 lc = i == 0 ? uPal[1] : i == 1 ? mix(uPal[1], vec3(1.0, 0.72, 0.4), 0.5) : uPal[3] * 0.6;
    float k = 2.6 + fi * 1.4;
    col = screenBlend(col, lc * exp(-d * d * k) * (0.32 + 0.18 * uSection + 0.12 * uEnergy));
  }
  if (uHi > 0.5) {
    vec2 L = vec2(-0.55 * asp + sin(t * 0.02) * 0.2, 0.62);
    float rays = 0.0;
    for (int s = 0; s < 16; s++) {
      float k = float(s) / 16.0;
      vec2 sp = mix(p, L, k);
      rays += smoothstep(0.45, 0.75, fbm(sp * 3.0 + vec2(t * 0.05, 0.0), 3));
    }
    rays /= 16.0;
    col += mix(uPal[1], vec3(1.0, 0.8, 0.55), 0.4) * rays * 0.28 * exp(-length(p - L) * 0.9);
  }
  col *= 0.86 + 0.18 * uImpact + 0.08 * uKick;
  outColor = vec4(col, 1.0);
}`;

export const LOOK_FS = {
  aureole: AUREOLE,
  smoke: SMOKE,
  'liquid-ink': INK,
  'night-city': NIGHT,
  sunlit: SUNLIT,
} as const;

/**
 * Post: upscale, lens and legibility. Replaces what used to be three DOM
 * layers (scrim, grain, vignette). There is no film grain: the frame is kept
 * clean, and only a one-step dither remains so soft gradients do not band.
 */
export const POST_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uScene;
uniform sampler2D uMask;
uniform float uMaskAmt;
uniform vec3 uGlow;
uniform vec2 uRes;
uniform float uDim, uScrim, uAberr;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec2 uv = vUv;
  vec3 col;
  if (uAberr > 0.0) {
    vec2 d = (uv - 0.5) * uAberr;
    col = vec3(texture(uScene, uv + d).r, texture(uScene, uv).g, texture(uScene, uv - d).b);
  } else {
    col = texture(uScene, uv).rgb;
  }
  col *= 1.0 - uScrim;
  // Light spilling from behind the hero word: its own blurred shape, added
  // to the stage as light, so the type sits in a pool of its own glow.
  if (uMaskAmt > 0.0) col += uGlow * texture(uMask, uv).r * uMaskAmt;
  col *= 1.0 - uDim;
  vec2 q = uv - 0.5;
  q.x *= uRes.x / uRes.y * 0.8;
  col *= mix(1.0, 0.36, smoothstep(0.32, 1.0, length(q) * 1.25));
  col += (hash12(gl_FragCoord.xy * 1.37 + 3.1) - 0.5) / 255.0;
  outColor = vec4(max(col, 0.0), 1.0);
}`;

// ---------------------------------------------------------------------------
// Stable fluids (after Pavel Dobryakov's WebGL-Fluid-Simulation, MIT).
// ---------------------------------------------------------------------------

export const FLUID_VS = /* glsl */ `#version 300 es
in vec2 aPos;
out vec2 vUv, vL, vR, vT, vB;
uniform vec2 uTexel;
void main() {
  vUv = aPos * 0.5 + 0.5;
  vL = vUv - vec2(uTexel.x, 0.0);
  vR = vUv + vec2(uTexel.x, 0.0);
  vT = vUv + vec2(0.0, uTexel.y);
  vB = vUv - vec2(0.0, uTexel.y);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FLUID_HEAD = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv, vL, vR, vT, vB;
out vec4 outColor;
`;

export const FLUID_FS = {
  splat: FLUID_HEAD + `
uniform sampler2D uTarget;
uniform float uAspect, uRadius;
uniform vec3 uColor;
uniform vec2 uPoint;
void main() {
  vec2 p = vUv - uPoint;
  p.x *= uAspect;
  vec3 s = exp(-dot(p, p) / uRadius) * uColor;
  outColor = vec4(texture(uTarget, vUv).xyz + s, 1.0);
}`,
  advect: FLUID_HEAD + `
uniform sampler2D uVelocity, uSource;
uniform vec2 uTexel;
uniform float uDt, uDissipation;
void main() {
  vec2 coord = vUv - uDt * texture(uVelocity, vUv).xy * uTexel;
  outColor = texture(uSource, coord) / (1.0 + uDissipation * uDt);
}`,
  divergence: FLUID_HEAD + `
uniform sampler2D uVelocity;
void main() {
  float L = texture(uVelocity, vL).x, R = texture(uVelocity, vR).x;
  float T = texture(uVelocity, vT).y, B = texture(uVelocity, vB).y;
  vec2 C = texture(uVelocity, vUv).xy;
  if (vL.x < 0.0) L = -C.x;
  if (vR.x > 1.0) R = -C.x;
  if (vT.y > 1.0) T = -C.y;
  if (vB.y < 0.0) B = -C.y;
  outColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`,
  curl: FLUID_HEAD + `
uniform sampler2D uVelocity;
void main() {
  float L = texture(uVelocity, vL).y, R = texture(uVelocity, vR).y;
  float T = texture(uVelocity, vT).x, B = texture(uVelocity, vB).x;
  outColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
}`,
  vorticity: FLUID_HEAD + `
uniform sampler2D uVelocity, uCurl;
uniform float uCurlAmt, uDt;
void main() {
  float L = texture(uCurl, vL).x, R = texture(uCurl, vR).x;
  float T = texture(uCurl, vT).x, B = texture(uCurl, vB).x;
  float C = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= uCurlAmt * C;
  force.y *= -1.0;
  vec2 v = texture(uVelocity, vUv).xy + force * uDt;
  outColor = vec4(clamp(v, -1000.0, 1000.0), 0.0, 1.0);
}`,
  pressure: FLUID_HEAD + `
uniform sampler2D uPressure, uDivergence;
void main() {
  float L = texture(uPressure, vL).x, R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x, B = texture(uPressure, vB).x;
  float div = texture(uDivergence, vUv).x;
  outColor = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);
}`,
  gradient: FLUID_HEAD + `
uniform sampler2D uPressure, uVelocity;
void main() {
  float L = texture(uPressure, vL).x, R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x, B = texture(uPressure, vB).x;
  vec2 v = texture(uVelocity, vUv).xy - vec2(R - L, T - B);
  outColor = vec4(v, 0.0, 1.0);
}`,
  scale: FLUID_HEAD + `
uniform sampler2D uTexture;
uniform float uValue;
void main() { outColor = uValue * texture(uTexture, vUv); }`,
} as const;
