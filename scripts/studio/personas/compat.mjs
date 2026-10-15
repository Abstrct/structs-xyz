/* Persona lab, engines: what each browser engine supports of what the game actually uses, and what the
 * browser costs to run it.
 *
 *   scanUses()      counts each web feature in FEATURES across src/ (CSS and TypeScript), with example files
 *   ENGINE_PROBE    run in the page: the engine, WebGL (version, renderer, limits) and each feature's own test
 *   procTree(pid)   CPU seconds and resident memory of a browser's whole process tree (GPU, content and
 *                   renderer processes are its children), from `ps`; efficiency is CPU per minute of play
 *
 * A feature the game uses and an engine lacks is a compatibility issue. It is minor when the page degrades
 * (a CSS effect drops out, or `degrades`: the code checks for it and goes without, like rumble or WebGPU
 * hashing falling back to the CPU), major when a function stops (an API call throws or goes missing). Add a row to
 * FEATURES when the game starts using something newer; `uses` decides whether it counts. */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const FEATURES = [
  // CSS: a miss drops an effect or a layout rule.
  { id: 'css-has', name: ':has() selector', kind: 'css', uses: /:has\(/g, test: `CSS.supports('selector(:has(a))')` },
  { id: 'css-color-mix', name: 'color-mix()', kind: 'css', uses: /color-mix\(/g, test: `CSS.supports('color', 'color-mix(in srgb, red, blue)')` },
  { id: 'css-dvh', name: 'dvh / svh units', kind: 'css', uses: /\d(?:dvh|svh|lvh)\b/g, test: `CSS.supports('height', '100dvh')` },
  { id: 'css-container', name: 'container queries', kind: 'css', uses: /@container|container-type/g, test: `CSS.supports('container-type', 'inline-size')` },
  { id: 'css-backdrop', name: 'backdrop-filter', kind: 'css', uses: /(?<!-webkit-)backdrop-filter/g, test: `CSS.supports('backdrop-filter', 'blur(2px)')` },
  { id: 'css-pixelated', name: 'image-rendering: pixelated', kind: 'css', uses: /image-rendering:\s*pixelated/g, test: `CSS.supports('image-rendering', 'pixelated')` },
  { id: 'css-mask', name: 'mask-image', kind: 'css', uses: /(?<!-webkit-)mask-image/g, test: `CSS.supports('mask-image', 'linear-gradient(#000, transparent)')` },
  { id: 'css-scrollbar', name: 'scrollbar-width / gutter', kind: 'css', uses: /scrollbar-(?:width|gutter)/g, test: `CSS.supports('scrollbar-width', 'thin')` },
  { id: 'css-aspect', name: 'aspect-ratio', kind: 'css', uses: /aspect-ratio/g, test: `CSS.supports('aspect-ratio', '1')` },
  { id: 'css-text-wrap', name: 'text-wrap: balance', kind: 'css', uses: /text-wrap:\s*(?:balance|pretty)/g, test: `CSS.supports('text-wrap', 'balance')` },
  { id: 'css-anchor', name: 'anchor positioning', kind: 'css', uses: /anchor-name|position-anchor/g, test: `CSS.supports('anchor-name', '--a')` },
  { id: 'css-scroll-timeline', name: 'scroll-driven animations', kind: 'css', uses: /animation-timeline/g, test: `CSS.supports('animation-timeline', 'scroll()')` },
  { id: 'css-starting', name: '@starting-style', kind: 'css', uses: /@starting-style/g, test: `typeof CSSStartingStyleRule !== 'undefined'` },
  { id: 'css-field-sizing', name: 'field-sizing', kind: 'css', uses: /field-sizing/g, test: `CSS.supports('field-sizing', 'content')` },
  // JS: a miss can throw or leave a feature dead.
  { id: 'js-webgl2', name: 'WebGL 2', kind: 'js', uses: /WebGLRenderer|webgl2/g, test: `!!document.createElement('canvas').getContext('webgl2')` },
  { id: 'js-webgpu', degrades: true, name: 'WebGPU (navigator.gpu)', kind: 'js', uses: /navigator\.gpu/g, test: `!!navigator.gpu` },
  { id: 'js-haptics', degrades: true, name: 'gamepad rumble (vibrationActuator)', kind: 'js', uses: /vibrationActuator|playEffect/g, test: `typeof Gamepad !== 'undefined' && 'vibrationActuator' in Gamepad.prototype` },
  { id: 'js-idle', degrades: true, name: 'requestIdleCallback', kind: 'js', uses: /requestIdleCallback/g, test: `typeof requestIdleCallback === 'function'` },
  { id: 'js-locks', name: 'Web Locks (navigator.locks)', kind: 'js', uses: /navigator\.locks/g, test: `!!navigator.locks` },
  { id: 'js-popover', name: 'Popover API', kind: 'js', uses: /\bpopover\b/g, test: `'popover' in HTMLElement.prototype` },
  { id: 'js-inert', name: 'inert', kind: 'js', uses: /\.inert\b|'inert'/g, test: `'inert' in HTMLElement.prototype` },
  { id: 'js-clipboard', name: 'async clipboard', kind: 'js', uses: /navigator\.clipboard/g, test: `!!navigator.clipboard?.writeText` },
  { id: 'js-subtle', name: 'crypto.subtle', kind: 'js', uses: /crypto\.subtle/g, test: `!!crypto.subtle` },
  { id: 'js-worker-module', name: 'module workers', kind: 'js', uses: /new Worker\(/g, test: `typeof Worker === 'function'` },
  { id: 'js-notification', degrades: true, name: 'Notifications', kind: 'js', uses: /\bNotification\b/g, test: `typeof Notification === 'function'` },
  { id: 'js-view-transition', degrades: true, name: 'view transitions', kind: 'js', uses: /startViewTransition/g, test: `typeof document.startViewTransition === 'function'` },
  { id: 'js-scheduler', name: 'scheduler.postTask', kind: 'js', uses: /scheduler\.postTask/g, test: `typeof scheduler !== 'undefined' && typeof scheduler.postTask === 'function'` },
  { id: 'js-groupby', name: 'Object.groupBy', kind: 'js', uses: /Object\.groupBy/g, test: `typeof Object.groupBy === 'function'` },
  { id: 'js-iterator-helpers', name: 'iterator helpers', kind: 'js', uses: /Iterator\.from/g, test: `typeof Iterator !== 'undefined' && typeof Iterator.from === 'function'` },
];

/** How often each feature appears in the game's source (CSS and TypeScript under src/). */
export function scanUses(root) {
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|css)$/.test(f)) files.push(p); } };
  walk(join(root, 'src'));
  const out = {};
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const ft of FEATURES) {
      const n = (text.match(ft.uses) || []).length;
      if (!n) continue;
      const o = (out[ft.id] ||= { count: 0, files: [] });
      o.count += n;
      if (o.files.length < 3) o.files.push(relative(root, f));
    }
  }
  return out;
}

/** In the page: which engine, WebGL, and each feature's test. */
export const ENGINE_PROBE = `(() => {
  const gl = (() => { try { return window.__structs?.engine?.renderer?.getContext() || document.createElement('canvas').getContext('webgl2'); } catch { return null; } })();
  let webgl = null;
  if (gl) {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    webgl = { version: String(gl.getParameter(gl.VERSION)), renderer: String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE), extensions: (gl.getSupportedExtensions() || []).length };
  }
  const info = window.__structs?.engine?.renderer?.info?.render;
  const features = {};
  ${FEATURES.map((f) => `try { features[${JSON.stringify(f.id)}] = !!(${f.test}); } catch { features[${JSON.stringify(f.id)}] = false; }`).join('\n  ')}
  return { ua: navigator.userAgent, webgl, drawCalls: info?.calls ?? null, triangles: info?.triangles ?? null, features };
})()`;

/** CPU seconds and resident MB of `pid` and every process under it. */
export function procTree(pid) {
  if (!pid) return null;
  try {
    const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,time=,rss='], { encoding: 'utf8' }).trim().split('\n').map((l) => l.trim().split(/\s+/));
    const kids = new Map();
    for (const [p, pp] of rows) { if (!kids.has(pp)) kids.set(pp, []); kids.get(pp).push(p); }
    const tree = new Set([String(pid)]), q = [String(pid)];
    while (q.length) for (const k of kids.get(q.shift()) || []) if (!tree.has(k)) { tree.add(k); q.push(k); }
    const secs = (t) => { const [d, rest] = t.includes('-') ? t.split('-') : ['0', t]; return rest.split(':').map(Number).reduce((a, x) => a * 60 + x, 0) + Number(d) * 86400; };
    let cpu = 0, rss = 0;
    for (const [p, , t, r] of rows) if (tree.has(p)) { cpu += secs(t); rss += Number(r) || 0; }
    return { cpuSec: +cpu.toFixed(1), rssMB: Math.round(rss / 1024), procs: tree.size };
  } catch { return null; }
}
