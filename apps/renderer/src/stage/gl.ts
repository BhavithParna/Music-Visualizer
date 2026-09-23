import type { LookName, RenderTier } from '@lyricroom/shared';
import type { RGB } from '../palette.js';
import { FLUID_FS, FLUID_VS, LOOK_FS, POST_FS, QUAD_VS } from './shaders.js';

/**
 * The WebGL2 stage: one look rendered small, one post pass rendered at panel
 * size. Hand-rolled on purpose -- a fullscreen quad needs no scene graph --
 * and built so every GPU object can be recreated from CPU-side state, because
 * on a display that runs for weeks the context *will* be lost at some point
 * (driver reset, suspend, GPU process crash) and the page must come back on
 * its own.
 */

type Uniforms = Record<string, WebGLUniformLocation | null>;

interface Program {
  prog: WebGLProgram;
  u: Uniforms;
}

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
}

interface Double {
  read: Target;
  write: Target;
  swap(): void;
}

export interface StageInputs {
  now: number;
  tier: RenderTier;
  look: LookName;
  /** 0..1 inputs; all optional signals default to 0. */
  bass: number;
  kick: number;
  snare: number;
  hat: number;
  energy: number;
  /** 0 verse .. 1 chorus/climax. */
  section: number;
  /** Hero-landing impulse from the type, 0..1. */
  impact: number;
  /** 0..1 darkening, used for stillness before a climax. */
  dim: number;
  valence: number;
  arousal: number;
  cam: [number, number];
  scrim: number;
  /** Hero light-spill strength 0..1. */
  mask: number;
  /** Speed multiplier for the look's own time. */
  flow: number;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader: ${log}`);
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): Program {
  const prog = gl.createProgram()!;
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(prog, v);
  gl.attachShader(prog, f);
  gl.bindAttribLocation(prog, 0, 'aPos');
  gl.linkProgram(prog);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`link: ${gl.getProgramInfoLog(prog)}`);
  }
  const u: Uniforms = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i += 1) {
    const info = gl.getActiveUniform(prog, i);
    if (!info) continue;
    const name = info.name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(prog, info.name);
  }
  return { prog, u };
}

function target(gl: WebGL2RenderingContext, w: number, h: number, internal: number, format: number, type: number): Target {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  return { tex, fbo, w, h };
}

function double(make: () => Target): Double {
  const d: Double = {
    read: make(),
    write: make(),
    swap() {
      const t = d.read;
      d.read = d.write;
      d.write = t;
    },
  };
  return d;
}

function freeTarget(gl: WebGL2RenderingContext, t: Target | null | undefined): void {
  if (!t) return;
  gl.deleteTexture(t.tex);
  gl.deleteFramebuffer(t.fbo);
}

/**
 * Stable fluids, after Pavel Dobryakov's WebGL-Fluid-Simulation (MIT):
 * advect, curl, vorticity confinement, divergence, Jacobi pressure, subtract.
 * Simulated at 128 px, dye at 512 px -- the look is soft, so the resolution
 * is all headroom. Driven only by discrete events (kicks, words landing), never
 * by a continuous signal, so it swirls when the music does something.
 */
class Fluid {
  private p: Record<keyof typeof FLUID_FS, Program>;
  private vel: Double;
  private dye: Double;
  private div: Target;
  private curl: Target;
  private press: Double;
  private simTexel: [number, number];
  private dyeTexel: [number, number];

  constructor(private gl: WebGL2RenderingContext, private blit: (t: Target | null) => void, aspect: number) {
    const p = {} as Record<keyof typeof FLUID_FS, Program>;
    for (const k of Object.keys(FLUID_FS) as (keyof typeof FLUID_FS)[]) p[k] = link(gl, FLUID_VS, FLUID_FS[k]);
    this.p = p;
    const simH = 128;
    const simW = Math.round(simH * aspect);
    const dyeH = 512;
    const dyeW = Math.round(dyeH * aspect);
    const H = gl.HALF_FLOAT;
    this.vel = double(() => target(gl, simW, simH, gl.RG16F, gl.RG, H));
    this.dye = double(() => target(gl, dyeW, dyeH, gl.RGBA16F, gl.RGBA, H));
    this.press = double(() => target(gl, simW, simH, gl.R16F, gl.RED, H));
    this.div = target(gl, simW, simH, gl.R16F, gl.RED, H);
    this.curl = target(gl, simW, simH, gl.R16F, gl.RED, H);
    this.simTexel = [1 / simW, 1 / simH];
    this.dyeTexel = [1 / dyeW, 1 / dyeH];
  }

  get dyeTexture(): WebGLTexture {
    return this.dye.read.tex;
  }

  private use(prog: Program, texel: [number, number]): Uniforms {
    const gl = this.gl;
    gl.useProgram(prog.prog);
    gl.uniform2f(prog.u['uTexel'] ?? null, texel[0], texel[1]);
    return prog.u;
  }

  private bind(unit: number, tex: WebGLTexture): number {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    return unit;
  }

  splat(x: number, y: number, dx: number, dy: number, color: RGB, radius = 0.018): void {
    const gl = this.gl;
    const aspect = this.vel.read.w / this.vel.read.h;
    let u = this.use(this.p.splat, this.simTexel);
    gl.uniform1i(u['uTarget'] ?? null, this.bind(0, this.vel.read.tex));
    gl.uniform1f(u['uAspect'] ?? null, aspect);
    gl.uniform2f(u['uPoint'] ?? null, x, y);
    gl.uniform3f(u['uColor'] ?? null, dx, dy, 0);
    gl.uniform1f(u['uRadius'] ?? null, radius);
    this.blit(this.vel.write);
    this.vel.swap();
    u = this.use(this.p.splat, this.dyeTexel);
    gl.uniform1i(u['uTarget'] ?? null, this.bind(0, this.dye.read.tex));
    gl.uniform1f(u['uAspect'] ?? null, aspect);
    gl.uniform2f(u['uPoint'] ?? null, x, y);
    gl.uniform3f(u['uColor'] ?? null, color[0], color[1], color[2]);
    gl.uniform1f(u['uRadius'] ?? null, radius * 1.4);
    this.blit(this.dye.write);
    this.dye.swap();
  }

  step(dt: number, dissipation: number): void {
    const gl = this.gl;
    const t = this.simTexel;
    let u = this.use(this.p.curl, t);
    gl.uniform1i(u['uVelocity'] ?? null, this.bind(0, this.vel.read.tex));
    this.blit(this.curl);

    u = this.use(this.p.vorticity, t);
    gl.uniform1i(u['uVelocity'] ?? null, this.bind(0, this.vel.read.tex));
    gl.uniform1i(u['uCurl'] ?? null, this.bind(1, this.curl.tex));
    gl.uniform1f(u['uCurlAmt'] ?? null, 22);
    gl.uniform1f(u['uDt'] ?? null, dt);
    this.blit(this.vel.write);
    this.vel.swap();

    u = this.use(this.p.divergence, t);
    gl.uniform1i(u['uVelocity'] ?? null, this.bind(0, this.vel.read.tex));
    this.blit(this.div);

    u = this.use(this.p.scale, t);
    gl.uniform1i(u['uTexture'] ?? null, this.bind(0, this.press.read.tex));
    gl.uniform1f(u['uValue'] ?? null, 0.8);
    this.blit(this.press.write);
    this.press.swap();

    u = this.use(this.p.pressure, t);
    gl.uniform1i(u['uDivergence'] ?? null, this.bind(1, this.div.tex));
    for (let i = 0; i < 12; i += 1) {
      gl.uniform1i(u['uPressure'] ?? null, this.bind(0, this.press.read.tex));
      this.blit(this.press.write);
      this.press.swap();
    }

    u = this.use(this.p.gradient, t);
    gl.uniform1i(u['uPressure'] ?? null, this.bind(0, this.press.read.tex));
    gl.uniform1i(u['uVelocity'] ?? null, this.bind(1, this.vel.read.tex));
    this.blit(this.vel.write);
    this.vel.swap();

    u = this.use(this.p.advect, t);
    gl.uniform1i(u['uVelocity'] ?? null, this.bind(0, this.vel.read.tex));
    gl.uniform1i(u['uSource'] ?? null, this.bind(0, this.vel.read.tex));
    gl.uniform1f(u['uDt'] ?? null, dt);
    gl.uniform1f(u['uDissipation'] ?? null, 0.25);
    this.blit(this.vel.write);
    this.vel.swap();

    u = this.use(this.p.advect, this.dyeTexel);
    gl.uniform2f(u['uTexel'] ?? null, t[0], t[1]);
    gl.uniform1i(u['uVelocity'] ?? null, this.bind(0, this.vel.read.tex));
    gl.uniform1i(u['uSource'] ?? null, this.bind(1, this.dye.read.tex));
    gl.uniform1f(u['uDissipation'] ?? null, dissipation);
    this.blit(this.dye.write);
    this.dye.swap();
  }

  dispose(): void {
    const gl = this.gl;
    for (const d of [this.vel, this.dye, this.press]) {
      freeTarget(gl, d.read);
      freeTarget(gl, d.write);
    }
    freeTarget(gl, this.div);
    freeTarget(gl, this.curl);
    for (const p of Object.values(this.p)) gl.deleteProgram(p.prog);
  }
}

export class GLStage {
  private gl: WebGL2RenderingContext;
  private looks = new Map<LookName, Program>();
  private post!: Program;
  private quad!: WebGLVertexArrayObject;
  private scene: Target | null = null;
  private artTex: [WebGLTexture, WebGLTexture] | null = null;
  private maskTex: WebGLTexture | null = null;
  private fluid: Fluid | null = null;
  private fluidFailed = false;
  private floatOk = false;
  private lost = false;
  private timer: { ext: any; queries: WebGLQuery[] } | null = null;
  private pending: WebGLQuery[] = [];
  gpuMs: number | null = null;

  /** CPU-side copies of everything uploaded, so a lost context can be rebuilt. */
  private artSources: [HTMLCanvasElement | null, HTMLCanvasElement | null] = [null, null];
  private maskSource: HTMLCanvasElement | null = null;
  private artMix = 1;
  private pal: RGB[] = [];
  private palTarget: RGB[] = [];
  private time = 0;
  private lastNow = 0;
  private frameNo = 0;
  private lastKick = 0;
  private lastImpact = 0;
  private sinceSplat = 0;
  private rng = 12345;
  readonly renderer: string;

  static create(canvas: HTMLCanvasElement): GLStage | null {
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false,
      powerPreference: 'high-performance', preserveDrawingBuffer: false,
    });
    if (!gl) return null;
    try {
      return new GLStage(canvas, gl);
    } catch (err) {
      console.warn('[lyricroom] WebGL stage unavailable, falling back:', err);
      return null;
    }
  }

  private constructor(private canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.gl = gl;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.renderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    this.init();
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      this.looks.clear();
      this.fluid = null;
      this.scene = null;
      this.pending = [];
      this.init();
    });
  }

  private init(): void {
    const gl = this.gl;
    this.floatOk = Boolean(gl.getExtension('EXT_color_buffer_float'));
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.timer = ext ? { ext, queries: [] } : null;

    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.post = link(gl, QUAD_VS, POST_FS);
    const mk = (): WebGLTexture => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([10, 9, 8, 255]));
      return t;
    };
    this.artTex = [mk(), mk()];
    this.maskTex = mk();
    for (const i of [0, 1] as const) {
      const src = this.artSources[i];
      if (src) this.upload(this.artTex[i], src);
    }
    if (this.maskSource) this.upload(this.maskTex, this.maskSource);
  }

  private upload(tex: WebGLTexture, src: HTMLCanvasElement): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  /** New cover (already processed into a small canvas). Cross-fades over ~1 s. */
  setArt(src: HTMLCanvasElement): void {
    if (!this.artTex) return;
    // Slot 0 keeps what is on screen now; the new art goes into slot 1.
    if (this.artMix >= 0.5) {
      this.artTex = [this.artTex[1], this.artTex[0]];
      this.artSources = [this.artSources[1], this.artSources[0]];
    }
    this.artSources[1] = src;
    if (!this.lost) this.upload(this.artTex[1], src);
    this.artMix = 0;
  }

  setPalette(swatches: RGB[]): void {
    this.palTarget = swatches.map((c) => [...c] as RGB);
    if (!this.pal.length) this.pal = this.palTarget.map((c) => [...c] as RGB);
  }

  /** Hero light-spill source: the hero word, blurred, in frame coordinates. */
  setMask(src: HTMLCanvasElement): void {
    this.maskSource = src;
    if (this.maskTex && !this.lost) this.upload(this.maskTex, src);
  }

  private blit = (t: Target | null): void => {
    const gl = this.gl;
    if (t) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.viewport(0, 0, t.w, t.h);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  private lookProgram(look: LookName): Program {
    let p = this.looks.get(look);
    if (!p) {
      p = link(this.gl, QUAD_VS, LOOK_FS[look]);
      this.looks.set(look, p);
    }
    return p;
  }

  private rand(): number {
    this.rng ^= this.rng << 13;
    this.rng ^= this.rng >>> 17;
    this.rng ^= this.rng << 5;
    return ((this.rng >>> 0) % 100000) / 100000;
  }

  private resize(tier: RenderTier): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Cinema draws the post pass at panel size (capped at 4K); Smooth at half.
    const scale = tier === 'cinema' ? Math.min(1, window.devicePixelRatio || 1) : 0.5;
    const w = Math.max(64, Math.min(3840, Math.round(vw * scale)));
    const h = Math.max(64, Math.min(2160, Math.round(vh * scale)));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const sh = tier === 'cinema' ? 540 : 270;
    const sw = Math.round(sh * (vw / Math.max(1, vh)));
    if (!this.scene || this.scene.w !== sw || this.scene.h !== sh) {
      freeTarget(this.gl, this.scene);
      this.scene = target(this.gl, sw, sh, this.gl.RGBA8, this.gl.RGBA, this.gl.UNSIGNED_BYTE);
      if (this.fluid) {
        this.fluid.dispose();
        this.fluid = null;
      }
    }
  }

  private readTimer(): void {
    if (!this.timer) return;
    const gl = this.gl;
    const ext = this.timer.ext;
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
      for (const q of this.pending) gl.deleteQuery(q);
      this.pending = [];
      return;
    }
    while (this.pending.length) {
      const q = this.pending[0]!;
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      this.gpuMs = this.gpuMs === null ? ns / 1e6 : this.gpuMs * 0.9 + (ns / 1e6) * 0.1;
      this.pending.shift();
      gl.deleteQuery(q);
    }
  }

  frame(i: StageInputs): void {
    if (this.lost || this.gl.isContextLost()) return;
    const dt = this.lastNow ? Math.min(0.05, (i.now - this.lastNow) / 1000) : 0;
    this.lastNow = i.now;
    this.frameNo += 1;

    // The look's own clock is integrated, so when the music changes its rate
    // the motion bends instead of jumping.
    this.time += dt * i.flow * (0.6 + 0.5 * i.energy + 0.35 * i.section);
    this.artMix = Math.min(1, this.artMix + dt / 1.0);
    const k = 1 - Math.exp(-dt / 0.35);
    for (let c = 0; c < this.palTarget.length; c += 1) {
      const cur = this.pal[c] ?? this.palTarget[c]!;
      const tgt = this.palTarget[c]!;
      this.pal[c] = [cur[0] + (tgt[0] - cur[0]) * k, cur[1] + (tgt[1] - cur[1]) * k, cur[2] + (tgt[2] - cur[2]) * k];
    }

    // Smooth caps the background at 30 Hz; the type above still runs at 60.
    if (i.tier === 'smooth' && this.frameNo % 2 === 1) return;

    const gl = this.gl;
    this.resize(i.tier);
    this.readTimer();
    let query: WebGLQuery | null = null;
    if (this.timer && this.pending.length < 4) {
      query = gl.createQuery();
      if (query) gl.beginQuery(this.timer.ext.TIME_ELAPSED_EXT, query);
    }

    const hi = i.tier === 'cinema';
    let dye: WebGLTexture | null = null;
    if (i.look === 'liquid-ink' && hi && this.floatOk && !this.fluidFailed) {
      try {
        this.fluid ??= new Fluid(gl, this.blit, this.scene!.w / this.scene!.h);
        this.driveFluid(i, dt * (i.tier === 'cinema' ? 1 : 2));
        dye = this.fluid.dyeTexture;
      } catch (err) {
        console.warn('[lyricroom] fluid disabled:', err);
        this.fluidFailed = true;
        this.fluid = null;
      }
    } else if (this.fluid && i.look !== 'liquid-ink') {
      this.fluid.dispose();
      this.fluid = null;
    }

    const p = this.lookProgram(i.look);
    gl.useProgram(p.prog);
    const u = p.u;
    gl.uniform2f(u['uRes'] ?? null, this.scene!.w, this.scene!.h);
    gl.uniform1f(u['uTime'] ?? null, this.time);
    if (this.pal.length === 5) gl.uniform3fv(u['uPal'] ?? null, new Float32Array(this.pal.flat()));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.artTex![0]);
    gl.uniform1i(u['uArt0'] ?? null, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.artTex![1]);
    gl.uniform1i(u['uArt1'] ?? null, 1);
    gl.uniform1f(u['uArtMix'] ?? null, this.artMix);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, dye ?? this.maskTex);
    gl.uniform1i(u['uDye'] ?? null, 2);
    gl.uniform1f(u['uHasDye'] ?? null, dye ? 1 : 0);
    gl.uniform1f(u['uBass'] ?? null, i.bass);
    gl.uniform1f(u['uKick'] ?? null, i.kick);
    gl.uniform1f(u['uSnare'] ?? null, i.snare);
    gl.uniform1f(u['uHat'] ?? null, i.hat);
    gl.uniform1f(u['uEnergy'] ?? null, i.energy);
    gl.uniform1f(u['uSection'] ?? null, i.section);
    gl.uniform1f(u['uImpact'] ?? null, i.impact);
    gl.uniform2f(u['uMood'] ?? null, i.valence, i.arousal);
    gl.uniform1f(u['uHi'] ?? null, hi ? 1 : 0);
    gl.uniform2f(u['uCam'] ?? null, i.cam[0], i.cam[1]);
    this.blit(this.scene);

    const q = this.post.u;
    gl.useProgram(this.post.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.scene!.tex);
    gl.uniform1i(q['uScene'] ?? null, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.uniform1i(q['uMask'] ?? null, 1);
    gl.uniform1f(q['uMaskAmt'] ?? null, hi ? i.mask : 0);
    const acc = this.pal[1] ?? [0.9, 0.7, 0.4];
    gl.uniform3f(q['uGlow'] ?? null, acc[0] * 0.42, acc[1] * 0.42, acc[2] * 0.42);
    gl.uniform2f(q['uRes'] ?? null, this.canvas.width, this.canvas.height);
    gl.uniform1f(q['uGrainT'] ?? null, (i.now / 1000) * 24);
    gl.uniform1f(q['uDim'] ?? null, i.dim);
    gl.uniform1f(q['uScrim'] ?? null, i.scrim);
    gl.uniform1f(q['uAberr'] ?? null, hi ? 0.0025 + 0.005 * Math.max(i.kick, i.impact * 0.6) : 0);
    this.blit(null);

    if (query && this.timer) {
      gl.endQuery(this.timer.ext.TIME_ELAPSED_EXT);
      this.pending.push(query);
    }
  }

  /**
   * Dev aid: render one frame and read the look target and the final output
   * back in the same task, before the compositor clears the drawing buffer.
   */
  debugRead(i: StageInputs): { scene: number[]; out: number[] } {
    this.frameNo = 0;
    this.frame(i);
    const gl = this.gl;
    const px = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene!.fbo);
    gl.readPixels(this.scene!.w >> 1, this.scene!.h >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const scene = [...px];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(this.canvas.width >> 1, this.canvas.height >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { scene, out: [...px], err: gl.getError(), pal: this.pal } as never;
  }

  private driveFluid(i: StageInputs, dt: number): void {
    const f = this.fluid!;
    const pal = this.pal.length === 5 ? this.pal : [[0.5, 0.4, 0.3]] as RGB[];
    const pick = (): RGB => {
      const c = pal[[1, 4, 0, 3][Math.floor(this.rand() * 4)] ?? 1] ?? pal[0]!;
      const b = 0.5 + 0.25 * i.energy;
      return [c[0] * b, c[1] * b, c[2] * b];
    };
    // Rising edges only: a kick is one event, not the 180 ms its envelope lasts.
    const kickHit = i.kick > 0.5 && this.lastKick <= 0.5;
    const landed = i.impact > 0.6 && this.lastImpact <= 0.6;
    this.lastKick = i.kick;
    this.lastImpact = i.impact;
    this.sinceSplat += dt;
    const burst = (n: number, force: number): void => {
      for (let s = 0; s < n; s += 1) {
        const x = 0.15 + this.rand() * 0.7;
        const y = 0.12 + this.rand() * 0.4;
        const a = (this.rand() - 0.5) * 1.6 + Math.PI / 2;
        f.splat(x, y, Math.cos(a) * force, Math.sin(a) * force, pick());
      }
      this.sinceSplat = 0;
    };
    if (kickHit) burst(1 + Math.round(i.kick * 2), 320 + 620 * i.bass);
    else if (landed) burst(1, 280);
    else if (this.sinceSplat > 0.9) burst(1, 160); // keep it alive when nothing is playing loud
    // Calm songs let the ink hang in the water; intense ones clear it fast.
    f.step(dt, 0.25 + 0.65 * i.arousal);
  }
}
