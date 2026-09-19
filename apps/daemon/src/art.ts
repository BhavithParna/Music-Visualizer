import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { ART_DIR, NET_TIMEOUT_MS, USER_AGENT } from './config.js';

const inflight = new Map<string, Promise<string | null>>();

export function artIdFor(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 16);
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/gif': '.gif',
};

/**
 * Download album art once and serve it from our own origin.
 *
 * This is not just caching: a canvas that has drawn a cross-origin image cannot
 * be read back, and the renderer derives its whole palette by reading pixels.
 * Same-origin art is what makes that legal.
 */
export async function cacheArt(url: string): Promise<string | null> {
  if (!url) return null;
  if (url.startsWith('file://')) return null;
  const id = artIdFor(url);
  const existing = inflight.get(id);
  if (existing) return existing;

  const job = (async (): Promise<string | null> => {
    await mkdir(ART_DIR, { recursive: true });
    for (const ext of Object.values(EXT_BY_TYPE)) {
      try {
        await readFile(join(ART_DIR, `${id}${ext}`));
        return `${id}${ext}`;
      } catch { /* not cached yet */ }
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), NET_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) return null;
      const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
      const ext = EXT_BY_TYPE[type] ?? (extname(new URL(url).pathname) || '.jpg');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength === 0) return null;
      const name = `${id}${ext}`;
      const target = join(ART_DIR, name);
      await writeFile(`${target}.tmp`, buf);
      await rename(`${target}.tmp`, target);
      return name;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      inflight.delete(id);
    }
  })();

  inflight.set(id, job);
  return job;
}
