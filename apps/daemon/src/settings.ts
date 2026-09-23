import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import {
  DEFAULT_SETTINGS, LOOKS, PRESETS, type DisplaySettings,
} from '@lyricroom/shared';
import { DATA_DIR, SETTINGS_FILE } from './config.js';

/**
 * Display settings (render tier, look, motion preset), shared by every surface
 * and persisted, so the room keeps the look you chose across restarts.
 */
let current: DisplaySettings | null = null;

/** Accept only known values; a stale or hand-edited file must never break the display. */
export function sanitize(input: Partial<DisplaySettings>, base: DisplaySettings): DisplaySettings {
  const out = { ...base };
  if (input.tier === 'auto' || input.tier === 'cinema' || input.tier === 'smooth') out.tier = input.tier;
  if (input.look === 'auto' || (input.look && LOOKS.includes(input.look))) out.look = input.look;
  if (input.preset === 'auto' || (input.preset && PRESETS.includes(input.preset))) out.preset = input.preset;
  return out;
}

export async function loadSettings(): Promise<DisplaySettings> {
  if (current) return current;
  try {
    const raw = JSON.parse(await readFile(SETTINGS_FILE, 'utf8')) as Partial<DisplaySettings>;
    current = sanitize(raw, DEFAULT_SETTINGS);
  } catch {
    current = { ...DEFAULT_SETTINGS };
  }
  return current;
}

export async function updateSettings(patch: Partial<DisplaySettings>): Promise<DisplaySettings> {
  const next = sanitize(patch, await loadSettings());
  current = next;
  try {
    await mkdir(DATA_DIR, { recursive: true });
    const tmp = `${SETTINGS_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
    await rename(tmp, SETTINGS_FILE);
  } catch {
    /* best effort: the setting still applies for this session */
  }
  return next;
}
