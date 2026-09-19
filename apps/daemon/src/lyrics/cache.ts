import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { LyricDoc } from '@lyricroom/shared';
import { CACHE_DIR, TTL_LINE_MS, TTL_MISS_MS, TTL_WORD_MS } from '../config.js';
import { safeKey } from './providers/sidecar.js';

interface Entry {
  doc: LyricDoc | null;
  storedAt: number;
}

function ttlFor(doc: LyricDoc | null): number {
  if (!doc) return TTL_MISS_MS;
  if (doc.level === 'word') return TTL_WORD_MS;
  return TTL_LINE_MS;
}

const mem = new Map<string, Entry>();

export async function readCache(trackKey: string): Promise<Entry | null> {
  const hit = mem.get(trackKey);
  if (hit && Date.now() - hit.storedAt < ttlFor(hit.doc)) return hit;

  try {
    const raw = await readFile(join(CACHE_DIR, `${safeKey(trackKey)}.json`), 'utf8');
    const entry = JSON.parse(raw) as Entry;
    if (Date.now() - entry.storedAt >= ttlFor(entry.doc)) return null;
    mem.set(trackKey, entry);
    return entry;
  } catch {
    return null;
  }
}

export async function writeCache(trackKey: string, doc: LyricDoc | null): Promise<void> {
  const entry: Entry = { doc, storedAt: Date.now() };
  mem.set(trackKey, entry);
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const target = join(CACHE_DIR, `${safeKey(trackKey)}.json`);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(entry), 'utf8');
    await rename(tmp, target);
  } catch {
    /* an unwritable cache must never break playback */
  }
}

export function forget(trackKey: string): void {
  mem.delete(trackKey);
}
