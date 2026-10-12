/* After `vite build`: a real HTML page for every screen, written into dist/ beside the app shell.
 *
 * Each page is the shell with its own title, description, canonical and Open Graph tags and a text
 * body (from src/data/seo.ts, and structTypes.json for the codex), so crawlers, link previews and
 * browsers without WebGL get the page itself; the app boots on top and replaces it. The server
 * answers /codex/5 with dist/codex/5.html, and any other route with the shell. Also writes
 * sitemap.xml, fills in robots.txt, and writes 404.html: the shell again, which is how GitHub
 * Pages (no rewrites) opens a route with no page of its own (/planet/2-7): it serves 404.html and
 * the app routes itself. Links follow the base path (a project page, /repo/), as the build does.
 * Usage: tsx scripts/prerender.ts [dist-dir] */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ROUTES, SITE_DESCRIPTION, SITE_NAME, type RouteDoc } from '../src/data/seo';
import { AMBIT_NAME, DEFENSE_NAME, PASSIVE_NAME, STRUCT_TYPES, ambitsOf, controlName, hasWeapon, reachLabel, roleOf, weaponLabel, type StructType, type WeaponSystem } from '../src/data/catalogue';

const DIST = resolve(process.argv[2] || join(dirname(new URL(import.meta.url).pathname), '..', 'dist'));
const SITE_URL = (process.env.VITE_SITE_URL || 'https://structs.xyz').replace(/\/+$/, '');
/** The same base vite.config.ts builds with: SITE_URL's path, or VITE_BASE. */
const BASE = ('/' + (process.env.VITE_BASE ?? new URL(SITE_URL).pathname).replace(/^\/+|\/+$/g, '') + '/').replace(/^\/\/$/, '/');
const rawShell = readFileSync(join(DIST, 'index.html'), 'utf8');
if (!rawShell.includes('<!--seo:start-->')) throw new Error('dist/index.html has no <!--seo:start--> block');
// A build made for another base would link every page to the wrong place: refuse it.
if (!rawShell.includes(`src="${BASE}assets/`)) throw new Error(`dist/index.html was not built for base ${BASE} (set the same VITE_SITE_URL / VITE_BASE for both)`);
/** Root-relative links in page text, under the base ('/codex/5' → '/repo/codex/5'). */
const based = (html: string) => (BASE === '/' ? html : html.replace(/(href|src)="\/(?!\/)/g, `$1="${BASE}`));
const shell = rawShell.replace(/<!--seo:start-->[\s\S]*<!--seo:end-->/, (m) => based(m));

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const attr = esc;

interface Page { path: string; title: string; description: string; html: string; jsonLd?: object; lastmod?: string; priority: number }

/** The shell, re-headed and re-bodied for one page. */
function render(p: Page): string {
  const url = SITE_URL + p.path;
  const title = p.path === '/' ? SITE_NAME : `${p.title} · ${SITE_NAME}`;
  let out = shell
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${attr(p.description)}$2`)
    .replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${attr(url)}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${attr(title)}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${attr(p.description)}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${attr(url)}$2`)
    .replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${attr(title)}$2`)
    .replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${attr(p.description)}$2`)
    .replace(/<!--seo:start-->[\s\S]*<!--seo:end-->/, `<!--seo:start-->\n    <main id="seo">\n${based(p.html)}\n    </main>\n    <!--seo:end-->`);
  if (p.jsonLd) out = out.replace('</head>', `    <script type="application/ld+json">${JSON.stringify(p.jsonLd)}</script>\n  </head>`);
  return out;
}

const crumbs = (items: { name: string; path: string }[]) => ({
  '@context': 'https://schema.org', '@type': 'BreadcrumbList',
  itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: SITE_URL + it.path })),
});

const nav = () => `      <nav aria-label="Screens"><p>${ROUTES.map((r) => `<a href="${r.path}">${esc(r.title)}</a>`).join(' · ')}</p></nav>`;
const home = () => `      <p><a href="/">${SITE_NAME}</a>: ${esc(SITE_DESCRIPTION.replace(/^Structs Command Deck: /, ''))}</p>`;

function screenPage(r: RouteDoc): Page {
  const extra = r.path === '/codex'
    ? `      <h2>Struct types</h2>\n      <ul>\n${STRUCT_TYPES.map((t) => `        <li><a href="/codex/${t.id}">${esc(t.type)}</a> (${esc(t.defaultCosmeticName)} ${esc(t.defaultCosmeticModelNumber)}): ${esc(roleOf(t))}</li>`).join('\n')}\n      </ul>`
    : '';
  const html = `      <h1>${esc(r.title)}</h1>\n${r.body.map((b) => `      <p>${esc(b)}</p>`).join('\n')}\n${extra}\n${nav()}\n${home()}`;
  return { path: r.path, title: r.title, description: r.description, html, priority: r.commander ? 0.6 : 0.8, jsonLd: crumbs([{ name: SITE_NAME, path: '/' }, { name: r.title, path: r.path }]) };
}

function weaponRows(t: StructType, ws: WeaponSystem): string {
  if (!hasWeapon(t, ws)) return '';
  const f = (k: string) => (t as unknown as Record<string, unknown>)[ws + k];
  const rate = `${f('ShotSuccessRateNumerator')}/${f('ShotSuccessRateDenominator')}`;
  return `        <tr><th>${ws === 'primaryWeapon' ? 'Primary' : 'Secondary'} weapon</th><td>${esc(weaponLabel(t, ws))} (${esc(controlName(String(f('Control'))))}): ${f('Shots')} shot${Number(f('Shots')) === 1 ? '' : 's'} × ${f('Damage')} damage at ${f('Targets')} target${Number(f('Targets')) === 1 ? '' : 's'}, hit rate ${rate}, charge ${f('Charge')}, reach ${esc(reachLabel(t, ws))}${f('Blockable') ? ', blockable' : ''}${f('Counterable') ? ', counterable' : ''}${Number(f('RecoilDamage')) ? `, recoil ${f('RecoilDamage')}` : ''}</td></tr>`;
}

function codexPage(t: StructType): Page {
  const x = t as unknown as Record<string, unknown>;
  const ambits = ambitsOf(t.possibleAmbit).map((a) => AMBIT_NAME[a]).join(', ') || 'Any';
  const prose = [x.primary_weapon_description, x.drive_description, x.passive_weaponry_description].filter((s): s is string => typeof s === 'string' && s.length > 0);
  const rows = [
    `        <tr><th>Class</th><td>${esc(t.class)}${t.classAbbreviation && t.classAbbreviation !== t.class ? ` (${esc(t.classAbbreviation)})` : ''}</td></tr>`,
    `        <tr><th>Category</th><td>${t.category === 'fleet' ? 'Fleet' : 'Planetary'}</td></tr>`,
    `        <tr><th>Ambit</th><td>${esc(ambits)}</td></tr>`,
    `        <tr><th>Health</th><td>${t.maxHealth}</td></tr>`,
    `        <tr><th>Build</th><td>difficulty ${t.buildDifficulty}, draw ${t.buildDraw}, charge ${t.buildCharge}${t.buildLimit ? `, limit ${t.buildLimit}` : ''}</td></tr>`,
    `        <tr><th>Passive draw</th><td>${t.passiveDraw}</td></tr>`,
    `        <tr><th>Charges</th><td>activate ${t.activateCharge}, move ${t.moveCharge}, defend ${t.defendChangeCharge}${t.stealthActivateCharge ? `, stealth ${t.stealthActivateCharge}` : ''}</td></tr>`,
    weaponRows(t, 'primaryWeapon'),
    weaponRows(t, 'secondaryWeapon'),
    t.passiveWeaponry && t.passiveWeaponry !== 'noPassiveWeaponry' ? `        <tr><th>Passive weaponry</th><td>${esc(PASSIVE_NAME[t.passiveWeaponry] || t.passiveWeaponry)}</td></tr>` : '',
    ...(['unitDefenses', 'oreReserveDefenses', 'planetaryDefenses'] as const).map((k) => (t[k] && !/^no/.test(String(t[k])) ? `        <tr><th>${k === 'unitDefenses' ? 'Unit defence' : k === 'oreReserveDefenses' ? 'Ore defence' : 'Planetary defence'}</th><td>${esc(DEFENSE_NAME[String(t[k])] || String(t[k]))}</td></tr>` : '')),
    t.planetaryMining && !/^no/.test(t.planetaryMining) ? `        <tr><th>Mining</th><td>${esc(t.planetaryMining)}, difficulty ${t.oreMiningDifficulty}</td></tr>` : '',
    t.planetaryRefinery && !/^no/.test(t.planetaryRefinery) ? `        <tr><th>Refining</th><td>${esc(t.planetaryRefinery)}, difficulty ${t.oreRefiningDifficulty}</td></tr>` : '',
    t.powerGeneration && !/^no/.test(t.powerGeneration) ? `        <tr><th>Power generation</th><td>${esc(t.powerGeneration)}, rate ${t.generatingRate}</td></tr>` : '',
    t.planetaryShieldContribution ? `        <tr><th>Planetary shield</th><td>+${t.planetaryShieldContribution}</td></tr>` : '',
    `        <tr><th>Mobility</th><td>${t.movable ? 'Movable' : 'Fixed'}${t.slotBound ? ', slot-bound' : ''}${t.stealthSystems ? ', stealth systems' : ''}</td></tr>`,
  ].filter(Boolean);
  const title = `${t.type} · Codex`;
  const description = `${t.type} (${t.defaultCosmeticName} ${t.defaultCosmeticModelNumber}): ${roleOf(t)}. Weapons, charge costs, build costs and defences from the Structs chain.`;
  const html = [
    `      <h1>${esc(t.type)}</h1>`,
    `      <p>${esc(t.defaultCosmeticName)} ${esc(t.defaultCosmeticModelNumber)} · ${esc(roleOf(t))}</p>`,
    ...prose.map((s) => `      <p>${esc(s)}</p>`),
    `      <h2>Mechanics</h2>`,
    `      <table>\n${rows.join('\n')}\n      </table>`,
    `      <h2>All struct types</h2>`,
    `      <p>${STRUCT_TYPES.map((o) => (o.id === t.id ? `<strong>${esc(o.type)}</strong>` : `<a href="/codex/${o.id}">${esc(o.type)}</a>`)).join(' · ')}</p>`,
    nav(), home(),
  ].join('\n');
  return { path: `/codex/${t.id}`, title, description, html, priority: 0.7, jsonLd: crumbs([{ name: SITE_NAME, path: '/' }, { name: 'Codex', path: '/codex' }, { name: t.type, path: `/codex/${t.id}` }]) };
}

const pages: Page[] = [...ROUTES.map(screenPage), ...STRUCT_TYPES.map(codexPage)];
for (const p of pages) {
  const file = join(DIST, p.path.slice(1) + '.html');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, render(p));
  // /codex is a page and a folder (/codex/5): also codex/index.html, for hosts that look there first.
  if (pages.some((q) => q.path.startsWith(p.path + '/'))) {
    mkdirSync(join(DIST, p.path.slice(1)), { recursive: true });
    writeFileSync(join(DIST, p.path.slice(1), 'index.html'), render(p));
  }
}
// The shell itself: the home page, with its own canonical already in place (and its links based).
writeFileSync(join(DIST, 'index.html'), shell);
// GitHub Pages' fallback for every other route: the shell, kept out of search results.
writeFileSync(join(DIST, '404.html'), shell.replace(/<meta name="robots" content="[^"]*" \/>/, '<meta name="robots" content="noindex" />'));
const today = new Date().toISOString().slice(0, 10);
const urls = [{ path: '/', priority: 1 }, ...pages].map((p) => `  <url><loc>${esc(SITE_URL + p.path)}</loc><lastmod>${today}</lastmod><priority>${p.priority.toFixed(1)}</priority></url>`);
writeFileSync(join(DIST, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
const robots = join(DIST, 'robots.txt');
writeFileSync(robots, readFileSync(robots, 'utf8').replaceAll('%SITE_URL%', SITE_URL));
console.log(`prerender: ${pages.length} pages + sitemap.xml + 404.html → ${DIST} (${SITE_URL}, base ${BASE})`);
