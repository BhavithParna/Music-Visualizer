import vader from 'vader-sentiment';
import { afinn165 } from 'afinn-165';
import { detectSections, type LyricDoc, type SongProfile } from '@lyricroom/shared';
import { stem } from '../glyphs/mapper.js';

/**
 * What a song is about and how hard it moves, from its lyrics alone.
 *
 * Offline and lexicon-based on purpose: a room display should not need a
 * network call or a model to decide that a song about crying in the rain wants
 * slow smoke rather than neon slams. Valence comes from VADER (negation and
 * intensifier aware) blended with AFINN; arousal from a small hand-built word
 * list plus how the song is sung -- words per second, shouting, repetition.
 * English only; anything else falls back to the timing-derived half.
 */

/** Words that raise or lower the temperature, whatever their sentiment. */
const HIGH_AROUSAL = new Set([
  'fire', 'burn', 'run', 'scream', 'shout', 'fight', 'wild', 'crazy', 'party', 'dance', 'jump',
  'fast', 'rush', 'explode', 'rage', 'kill', 'war', 'gun', 'bang', 'boom', 'loud', 'hype', 'lit',
  'go', 'move', 'shake', 'drop', 'thunder', 'storm', 'electric', 'rock', 'money', 'racks', 'drip',
  'flex', 'ball', 'ride', 'speed', 'faster', 'higher', 'alive', 'freak', 'hot', 'danger',
]);
const LOW_AROUSAL = new Set([
  'slow', 'sleep', 'dream', 'quiet', 'calm', 'soft', 'gentle', 'lonely', 'alone', 'still', 'rest',
  'tired', 'fade', 'hush', 'whisper', 'gone', 'empty', 'cold', 'grey', 'gray', 'rain', 'tear',
  'cry', 'miss', 'memory', 'remember', 'goodbye', 'silence', 'lullaby', 'night', 'moon', 'breathe',
]);

/**
 * Theme clusters. Stems, matched after the same crude stemmer the glyph mapper
 * uses, so `burning` and `burned` count for `fire` here too.
 */
export const CLUSTERS: Record<string, string[]> = {
  love: ['love', 'heart', 'kiss', 'baby', 'darling', 'hold', 'touch', 'lover', 'forever', 'together'],
  heartbreak: ['broke', 'break', 'cry', 'tear', 'miss', 'gone', 'goodbye', 'pain', 'hurt', 'lonely', 'alone', 'leave', 'lost'],
  money: ['money', 'cash', 'rich', 'gold', 'diamond', 'bank', 'racks', 'dollar', 'bag', 'chain', 'ice', 'drip'],
  night: ['night', 'dark', 'moon', 'star', 'city', 'street', 'neon', 'light', 'midnight', 'tonight', 'lights'],
  fire: ['fire', 'burn', 'flame', 'hot', 'heat', 'sun', 'summer', 'blaze', 'smoke'],
  water: ['water', 'rain', 'ocean', 'sea', 'wave', 'river', 'drown', 'swim', 'tide', 'storm'],
  party: ['party', 'dance', 'club', 'drink', 'shot', 'floor', 'dj', 'wild', 'crazy', 'lit'],
  faith: ['god', 'heaven', 'pray', 'angel', 'soul', 'lord', 'holy', 'grace', 'devil', 'hell'],
  road: ['road', 'drive', 'car', 'highway', 'ride', 'run', 'away', 'home', 'mile', 'wheel'],
  nature: ['sky', 'tree', 'flower', 'rose', 'garden', 'mountain', 'wind', 'earth', 'bird', 'field'],
};

const CLUSTER_OF = new Map<string, string>();
for (const [cluster, stems] of Object.entries(CLUSTERS)) {
  for (const s of stems) if (!CLUSTER_OF.has(s)) CLUSTER_OF.set(s, cluster);
}

const tokens = (text: string): string[] => text.split(/\s+/).filter(Boolean);
const clamp = (v: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, v));

function lineValence(text: string): number {
  const compound = vader.SentimentIntensityAnalyzer.polarity_scores(text).compound;
  let sum = 0;
  let hits = 0;
  for (const t of tokens(text)) {
    const w = t.toLowerCase().replace(/[^a-z']/g, '');
    const v = afinn165[w];
    if (v !== undefined) {
      sum += v;
      hits += 1;
    }
  }
  const af = hits ? clamp(sum / (hits * 4), -1, 1) : 0;
  return clamp(compound * 0.7 + af * 0.3, -1, 1);
}

function lineArousalWords(text: string): number {
  let up = 0;
  let down = 0;
  for (const t of tokens(text)) {
    const s = stem(t);
    const raw = t.toLowerCase().replace(/[^a-z']/g, '');
    if (HIGH_AROUSAL.has(s) || HIGH_AROUSAL.has(raw)) up += 1;
    if (LOW_AROUSAL.has(s) || LOW_AROUSAL.has(raw)) down += 1;
  }
  const bang = (text.match(/!/g) ?? []).length;
  const caps = tokens(text).filter((t) => t.length > 2 && t === t.toUpperCase() && /[A-Z]/.test(t)).length;
  return (up - down) * 0.18 + bang * 0.12 + caps * 0.08;
}

export function analyzeSong(doc: LyricDoc): SongProfile {
  const lines = doc.lines;
  const perLine = lines.map((line) => {
    const span = Math.max(250, line.endMs - line.startMs) / 1000;
    const wps = Math.max(1, line.words.length) / span;
    return { valence: lineValence(line.text), wordsArousal: lineArousalWords(line.text), wps };
  });

  // Density matters twice: a 4 words/s rap verse is intense whatever it says.
  const lineMood = perLine.map((p) => ({
    valence: p.valence,
    arousal: clamp(0.25 + clamp((p.wps - 1.2) / 3.2) * 0.5 + p.wordsArousal + Math.abs(p.valence) * 0.1),
  }));

  const { sections, lineSection } = detectSections(lines, lineMood.map((m) => m.arousal));

  const totalWords = lines.reduce((a, l) => a + Math.max(1, l.words.length), 0);
  const sungSec = lines.reduce((a, l) => a + Math.max(250, l.endMs - l.startMs), 0) / 1000;
  const density = sungSec > 0 ? totalWords / sungSec : 0;

  const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  // Repetition is energy: a song that says the same thing over and over is
  // chanting, and chants are loud.
  const distinct = new Set(lines.map((l) => l.text.toLowerCase().trim())).size;
  const repetition = lines.length ? 1 - distinct / lines.length : 0;

  const valence = clamp(mean(lineMood.map((m) => m.valence)) * 1.6, -1, 1);
  const arousal = clamp(mean(lineMood.map((m) => m.arousal)) * 0.85 + repetition * 0.25);

  // Theme clusters by how many lines mention them, not raw counts, so one
  // line that says "fire fire fire" does not make the whole song about fire.
  const clusterLines = new Map<string, number>();
  for (const line of lines) {
    const seen = new Set<string>();
    for (const t of tokens(line.text)) {
      const s = stem(t);
      const c = CLUSTER_OF.get(s) ?? CLUSTER_OF.get(t.toLowerCase().replace(/[^a-z']/g, ''));
      if (c) seen.add(c);
    }
    for (const c of seen) clusterLines.set(c, (clusterLines.get(c) ?? 0) + 1);
  }
  const floor = Math.max(2, lines.length * 0.08);
  const themes = [...clusterLines.entries()]
    .filter(([, n]) => n >= floor)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([c]) => c);

  return {
    valence: Number(valence.toFixed(3)),
    arousal: Number(arousal.toFixed(3)),
    themes,
    density: Number(density.toFixed(2)),
    sections,
    lineSection,
    lineMood: lineMood.map((m) => ({ valence: Number(m.valence.toFixed(2)), arousal: Number(m.arousal.toFixed(2)) })),
  };
}
