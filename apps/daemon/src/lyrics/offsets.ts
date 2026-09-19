import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { DATA_DIR, OFFSETS_FILE } from '../config.js';

let cache: Record<string, number> | null = null;
let flushTimer: NodeJS.Timeout | null = null;

async function load(): Promise<Record<string, number>> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(OFFSETS_FILE, 'utf8')) as Record<string, number>;
  } catch {
    cache = {};
  }
  return cache;
}

export async function getOffset(trackKey: string): Promise<number> {
  const all = await load();
  return all[trackKey] ?? 0;
}

/**
 * Per-track timing correction, nudged from the remote or the keyboard.
 * Some providers time a whole document against a different master and land
 * seconds out; this is the only practical cure, so it must persist.
 */
export async function nudgeOffset(trackKey: string, deltaMs: number): Promise<number> {
  const all = await load();
  const next = Math.max(-20_000, Math.min(20_000, (all[trackKey] ?? 0) + deltaMs));
  all[trackKey] = next;
  scheduleFlush();
  return next;
}

export async function setOffset(trackKey: string, value: number): Promise<number> {
  const all = await load();
  all[trackKey] = value;
  scheduleFlush();
  return value;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, 500);
}

export async function flush(): Promise<void> {
  if (!cache) return;
  try {
    await mkdir(DATA_DIR, { recursive: true });
    const tmp = `${OFFSETS_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8');
    await rename(tmp, OFFSETS_FILE);
  } catch {
    /* best effort */
  }
}
