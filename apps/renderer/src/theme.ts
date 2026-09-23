import type { DisplaySettings, LookName, MotionPreset, SongProfile } from '@lyricroom/shared';

/**
 * A song's look: which background, which faces, how the words move.
 *
 * Chosen from the song profile the daemon derives from the lyrics, the way the
 * Cotodama Lyric Speaker does it: a ballad gets a delicate face that drifts
 * slowly, a rap record a heavy condensed face that slams, and the theme of the
 * words (night, fire, water) picks the background. The remote can pin any part
 * of it. Deterministic per track, so a song always looks like itself.
 */

export interface FontSpec {
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  tracking: string;
  /** Mean advance per character in em, for the layout's first size guess. */
  charEm: number;
  /** Variable weight axis available, for the held-note swell. */
  variable?: boolean;
}

export const FONTS = {
  archivo: { family: "'Archivo Black'", weight: 400, style: 'normal', tracking: '-0.03em', charEm: 0.66 },
  anton: { family: "'Anton'", weight: 400, style: 'normal', tracking: '-0.005em', charEm: 0.47 },
  league: { family: "'League Gothic'", weight: 400, style: 'normal', tracking: '0em', charEm: 0.39 },
  bricolage: {
    family: "'Bricolage Grotesque Variable'", weight: 800, style: 'normal', tracking: '-0.035em', charEm: 0.56, variable: true,
  },
  fraunces: { family: "'Fraunces Variable'", weight: 600, style: 'normal', tracking: '-0.02em', charEm: 0.56, variable: true },
  instrument: { family: "'Instrument Serif'", weight: 400, style: 'italic', tracking: '-0.01em', charEm: 0.44 },
  inter: { family: "'Inter Variable'", weight: 800, style: 'normal', tracking: '-0.02em', charEm: 0.58 },
} satisfies Record<string, FontSpec>;

/** Which way the film travels. Up and left are lateral; push and pull are Z. */
export type Current = 'up' | 'left' | 'push' | 'pull';

export interface MotionParams {
  /** How early a word starts arriving before it is sung. */
  leadMs: number;
  /** Multiplier on the per-tier entry durations (hero 180 ms, support 150, connective 120). */
  inScale: number;
  outMs: number;
  /** Exit travel, % of the frame. */
  travel: number;
  /** Ghost copies in the exit smear, before the tier caps it. */
  smear: number;
  current: Current;
  /** Max tilt of the word wall, degrees. */
  tiltDeg: number;
  /** 0..1 glow strength on the hero. */
  glow: number;
  /** Entry scale for 'slam' arrivals (1 = none). */
  slam: number;
  /** Use a rack-focus cut on line boundaries (at most once per 8 s). */
  rack: boolean;
}

export interface Theme {
  look: LookName;
  preset: MotionPreset;
  hero: FontSpec;
  support: FontSpec;
  connective: FontSpec;
  motion: MotionParams;
  /** Palette grade: -1 cool .. 1 warm, and a saturation multiplier. */
  temperature: number;
  saturation: number;
  /** A short human label for the overlay. */
  reason: string;
}

const PRESET_MOTION: Record<MotionPreset, MotionParams> = {
  calm: {
    leadMs: 210, inScale: 1.45, outMs: 300, travel: 7, smear: 3, current: 'up', tiltDeg: 2.5, glow: 0.55, slam: 1, rack: true,
  },
  kinetic: {
    leadMs: 160, inScale: 1, outMs: 230, travel: 11, smear: 5, current: 'up', tiltDeg: 4.5, glow: 0.7, slam: 1, rack: false,
  },
  slam: {
    leadMs: 110, inScale: 0.8, outMs: 190, travel: 13, smear: 6, current: 'left', tiltDeg: 5.5, glow: 0.9, slam: 1.32, rack: false,
  },
};

const PRESET_FONTS: Record<MotionPreset, [FontSpec, FontSpec]> = {
  calm: [FONTS.fraunces, FONTS.instrument],
  kinetic: [FONTS.archivo, FONTS.instrument],
  slam: [FONTS.anton, FONTS.inter],
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Where a profile sits, as a preset and a starting look. */
function fromProfile(p: SongProfile, seed: number): { preset: MotionPreset; look: LookName; hero: FontSpec; reason: string } {
  const themes = new Set(p.themes);
  let preset: MotionPreset;
  let look: LookName;
  let hero: FontSpec;
  let reason: string;

  if (p.arousal > 0.62 || p.density > 3.1) {
    preset = 'slam';
    hero = p.density > 3.8 ? FONTS.league : FONTS.anton;
    look = themes.has('night') || themes.has('money') ? 'night-city' : 'liquid-ink';
    reason = 'intense';
  } else if (p.arousal < 0.4 && p.valence < -0.12) {
    preset = 'calm';
    hero = FONTS.fraunces;
    look = 'smoke';
    reason = 'dark and slow';
  } else if (p.valence > 0.25) {
    preset = 'kinetic';
    hero = seed % 2 ? FONTS.bricolage : FONTS.archivo;
    look = seed % 3 === 0 ? 'aureole' : 'sunlit';
    reason = 'bright';
  } else {
    preset = p.arousal < 0.42 ? 'calm' : 'kinetic';
    hero = preset === 'calm' ? FONTS.fraunces : FONTS.archivo;
    look = 'aureole';
    reason = 'even';
  }

  // What the words are about overrides the mood's first guess for the stage.
  const lead = p.themes[0];
  if (lead === 'night') look = 'night-city';
  else if (lead === 'fire') look = 'sunlit';
  else if (lead === 'water') look = 'liquid-ink';
  else if (lead === 'heartbreak' && preset !== 'slam') look = 'smoke';
  if (lead) reason += `, ${lead}`;

  return { preset, look, hero, reason };
}

export function buildTheme(
  profile: SongProfile | null,
  settings: Pick<DisplaySettings, 'look' | 'preset'>,
  trackKey: string,
): Theme {
  const seed = hash(trackKey);
  const base = profile
    ? fromProfile(profile, seed)
    : { preset: 'kinetic' as MotionPreset, look: 'aureole' as LookName, hero: FONTS.archivo, reason: 'no profile' };

  const preset = settings.preset !== 'auto' ? settings.preset : base.preset;
  const look = settings.look !== 'auto' ? settings.look : base.look;
  // A pinned preset brings its own faces; otherwise the profile's hero wins.
  const [presetHero, support] = PRESET_FONTS[preset];
  const hero = settings.preset !== 'auto' ? presetHero : base.hero;

  const motion = { ...PRESET_MOTION[preset] };
  // Kinetic songs pick their current per track, so not every song rises.
  if (preset === 'kinetic' && seed % 4 === 1) motion.current = 'left';

  const themes = new Set(profile?.themes ?? []);
  let temperature = (profile?.valence ?? 0) * 0.6;
  if (themes.has('fire')) temperature += 0.35;
  if (themes.has('night') || themes.has('water')) temperature -= 0.3;
  temperature = Math.max(-1, Math.min(1, temperature));
  const saturation = 0.82 + (profile?.arousal ?? 0.5) * 0.45;

  return {
    look,
    preset,
    hero,
    support: support.family === hero.family ? FONTS.inter : support,
    connective: FONTS.inter,
    motion,
    temperature,
    saturation,
    reason: `${base.reason}${settings.look !== 'auto' || settings.preset !== 'auto' ? ' (pinned)' : ''}`,
  };
}

/** Push a theme's faces into the stylesheet. */
export function applyThemeFonts(theme: Theme): void {
  const root = document.documentElement.style;
  const set = (tier: string, f: FontSpec): void => {
    root.setProperty(`--${tier}-family`, `${f.family}, 'Inter Variable', system-ui, sans-serif`);
    root.setProperty(`--${tier}-weight`, String(f.weight));
    root.setProperty(`--${tier}-style`, f.style);
    root.setProperty(`--${tier}-tracking`, f.tracking);
  };
  set('hero', theme.hero);
  set('support', theme.support);
  set('connective', theme.connective);
}

/** Resolve once every face this theme needs is loaded, so fit-to-frame measures real glyphs. */
export async function loadThemeFonts(theme: Theme): Promise<void> {
  const specs = [theme.hero, theme.support, theme.connective];
  try {
    await Promise.all(specs.map((f) =>
      document.fonts.load(`${f.style} ${f.weight} 64px ${f.family}`)));
  } catch {
    /* a missing face falls back; layout still measures the fallback */
  }
}
