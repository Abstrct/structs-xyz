/* The built site (dist/) from one process, with no dependencies. This is what the container runs.
 *
 *   pnpm build && node server/serve.mjs      # http://localhost:8080
 *
 * The page talks to the chain and to each guild itself; this only serves files.
 * Env: PORT (8080), HOST (0.0.0.0), STATIC_DIR (../dist). GET /healthz answers 200.
 * Screens live at paths (/command, /codex/5). A prerendered page (dist/codex/5.html) answers its
 * own path; any other extension-less path is the app shell, which routes itself. */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { brotliCompressSync, gzipSync, constants as Z } from 'node:zlib';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.env.STATIC_DIR || fileURLToPath(new URL('../dist', import.meta.url)));
const PORT = Number(process.env.PORT || process.argv[2] || 8080);
const HOST = process.env.HOST || '0.0.0.0';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.map': 'application/json; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.txt', '.xml', '.map', '.wasm']);

// No other site may frame the game (a click there could land on something it can't see).
// Everything else is open: any origin may read the static files (crawlers, scrapers, other sites'
// scripts), timing included, and sites we link to see where their visitors came from.
const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
  'referrer-policy': 'strict-origin-when-cross-origin',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'timing-allow-origin': '*',
};

/** Vite's hashed assets never change; pages, the service worker, the manifest, robots and the sitemap
 * always revalidate; art, sound and fonts are unhashed but change only with a deploy. */
function cacheControl(rel) {
  if (rel.startsWith('assets/')) return 'public, max-age=31536000, immutable';
  if (/\.html$|^(sw\.js|manifest\.webmanifest|robots\.txt|sitemap\.xml)$/.test(rel)) return 'no-cache';
  if (/^(img|sound|fonts)\//.test(rel)) return 'public, max-age=604800';
  return 'public, max-age=3600';
}

/** Files read once, compressed once: dist is small and fixed for the life of the process. */
const cache = new Map();
async function load(abs, ext) {
  let e = cache.get(abs);
  if (!e) {
    const raw = await readFile(abs);
    const st = await stat(abs);
    e = { raw, mtime: st.mtime.toUTCString(), etag: `"${st.size.toString(36)}-${st.mtimeMs.toString(36)}"`, br: null, gz: null };
    if (COMPRESSIBLE.has(ext) && raw.length > 1024) {
      e.br = brotliCompressSync(raw, { params: { [Z.BROTLI_PARAM_QUALITY]: 9, [Z.BROTLI_PARAM_SIZE_HINT]: raw.length } });
      e.gz = gzipSync(raw, { level: 9 });
    }
    cache.set(abs, e);
  }
  return e;
}

/** A URL path to a file inside ROOT, or null (outside it, malformed, or not a file).
 * A route path (/codex/5) is its prerendered page (codex/5.html) when the build made one, else the
 * app shell; a path with an extension is only ever that file. */
async function resolveFile(pathname) {
  let p;
  try { p = decodeURIComponent(pathname); } catch { return null; }
  if (p.includes('\0')) return null;
  if (p.endsWith('/')) p += 'index.html';
  const inside = (rel) => { const abs = resolve(join(ROOT, rel)); return abs === ROOT || abs.startsWith(ROOT + sep) ? abs : null; };
  const isFile = async (abs) => { try { return abs && (await stat(abs)).isFile() ? abs : null; } catch { return null; } };
  const direct = await isFile(inside(p));
  if (direct) return direct;
  if (extname(p)) return null;
  return (await isFile(inside(p + '.html'))) || (await isFile(inside(p + '/index.html'))) || isFile(inside('/index.html'));
}

async function serveStatic(req, res) {
  if (req.method === 'OPTIONS') { res.writeHead(204, { ...BASE_HEADERS, 'access-control-max-age': '86400' }); res.end(); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { ...BASE_HEADERS, allow: 'GET, HEAD, OPTIONS' }); res.end(); return; }
  const url = new URL(req.url || '/', 'http://x');
  const abs = await resolveFile(url.pathname);
  if (!abs) { res.writeHead(404, { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
  const ext = extname(abs).toLowerCase();
  const e = await load(abs, ext);
  const rel = abs.slice(ROOT.length + 1).split(sep).join('/');
  const headers = { ...BASE_HEADERS, 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': cacheControl(rel), etag: e.etag, 'last-modified': e.mtime };
  if (e.br) headers.vary = 'accept-encoding';
  if (req.headers['if-none-match'] === e.etag) { res.writeHead(304, headers); res.end(); return; }
  const accept = String(req.headers['accept-encoding'] || '');
  let body = e.raw;
  if (e.br && /\bbr\b/.test(accept)) { body = e.br; headers['content-encoding'] = 'br'; }
  else if (e.gz && /\bgzip\b/.test(accept)) { body = e.gz; headers['content-encoding'] = 'gzip'; }
  headers['content-length'] = String(body.length);
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

const server = createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ok: true })); return; }
  serveStatic(req, res).catch((err) => {
    console.error('serve:', err);
    if (!res.headersSent) res.writeHead(500, { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
    res.end('Server error');
  });
});
server.listen(PORT, HOST, () => console.log(`structs-xyz on http://${HOST}:${PORT} (site: ${ROOT})`));

// `docker stop` sends SIGTERM to PID 1: finish in-flight requests, then go.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
