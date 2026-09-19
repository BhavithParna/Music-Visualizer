import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ART_DIR } from './config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** dist/ -> apps/daemon -> apps -> repo root */
const REPO_ROOT = join(HERE, '..', '..', '..');
const RENDERER_DIST = join(REPO_ROOT, 'apps', 'renderer', 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
};

async function sendFile(res: ServerResponse, path: string, req: IncomingMessage): Promise<boolean> {
  let info;
  try {
    info = await stat(path);
    if (!info.isFile()) return false;
  } catch {
    return false;
  }
  const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';

  // Range support so <audio> can seek in local files.
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : info.size - 1;
      if (start < info.size && end < info.size && start <= end) {
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Range': `bytes ${start}-${end}/${info.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
        });
        createReadStream(path, { start, end }).pipe(res);
        return true;
      }
    }
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': info.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': path.startsWith(ART_DIR) ? 'public, max-age=86400' : 'no-cache',
  });
  createReadStream(path).pipe(res);
  return true;
}

export interface ServerHooks {
  state(): unknown;
  remoteHtml(): Promise<string>;
}

/**
 * Reject anything that tries to climb out of the directory it is served from.
 *
 * The separator in the prefix check is load-bearing: a bare startsWith would
 * also accept a sibling directory whose name merely begins with the root's,
 * e.g. `.../art` matching `.../artifacts`.
 */
function safeJoin(root: string, rel: string): string | null {
  if (rel.includes('\0')) return null;
  const base = resolve(root);
  const target = resolve(normalize(join(base, rel)));
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}

export function createHttpServer(hooks: ServerHooks) {
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = decodeURIComponent(url.pathname);

      if (path === '/api/state') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(hooks.state(), null, 2));
        return;
      }

      if (path.startsWith('/art/')) {
        const file = safeJoin(ART_DIR, path.slice('/art/'.length));
        if (file && (await sendFile(res, file, req))) return;
        res.writeHead(404).end('no art');
        return;
      }

      if (path === '/remote' || path === '/remote/') {
        const html = await hooks.remoteHtml();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
      const file = safeJoin(RENDERER_DIST, rel);
      if (file && (await sendFile(res, file, req))) return;

      // SPA fallback only for route-like paths. A missing asset must 404, or a
      // broken build silently serves HTML where a script was expected.
      if (!extname(rel)) {
        const index = join(RENDERER_DIST, 'index.html');
        if (await sendFile(res, index, req)) return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(
        'LyricRoom daemon is running, but the renderer has not been built yet.\n' +
          'Run `npm run build -w @lyricroom/renderer`, or use `npm run dev` for the Vite dev server.\n',
      );
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end('error');
    });
  });
}

export async function readRendererAsset(rel: string): Promise<string> {
  return readFile(join(RENDERER_DIST, rel), 'utf8');
}
