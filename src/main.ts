import './styles/main.css';
import './styles/screens.css';
import { Engine, type Screen } from './core/engine';
import { h, fade, portrait, toast, ui } from './core/dom';
import { commander } from './chain/commander';
import { audio } from './core/audio';
import { live } from './chain/live';
import { store } from './chain/store';
import { lcd } from './chain/lcd';
import { TIPS } from './data/lore';
import { STRUCT_TYPES } from './data/catalogue';
import { getPixelModel } from './gfx/pixelModel';
import { applySettings, loadSettings, openSettings, setExpert } from './core/settings';
import { wallet } from './wallet/wallet';
import { txq } from './wallet/queue';
import { empire } from './game/empire';
import { pow } from './pow/pow';
import { replicants } from './game/replicants';
import { startAlerts } from './game/alerts';
import { record } from './game/record';
import { startMissions } from './game/missions';
import { openVault } from './ui/vault';
import { resumeEnlist } from './game/enlist';
import { opsDock, narrateJobs, kids, fmtRate } from './ui/opsDock';
import { togglePalette } from './ui/palette';
import { grass } from './grass/grass';
import { mountCommsDock } from './ui/comms/dock';
import { onGuilds, guilds } from './guild/directory';
import { loadRoster, saveRoster, cache } from './cache/idb';
import { comms } from './chat/matrix';
import type { RawFleet, RawGuild, RawPlayer } from './chain/lcd';
import { currentRoute, goTo, interceptLinks, normalizeRoute, setPageMeta } from './core/nav';
import { asset, withBase } from './core/base';
import { describeRoute } from './data/seo';
import { GUIDES } from './data/learn';
import { academy } from './game/academy';
import { buildHubNav, type HubNav } from './ui/hubs';
import { showGuide, closeGuide, tipsOn, setTips, wireTerms } from './ui/guide';
import { showWelcome, markWelcomed } from './ui/welcome';
import { toggleManual } from './ui/manual';
import { icon, MARK } from './ui/icons';
import { startPad } from './core/pad';
import { mountVmu } from './ui/vmu';
import { startPeek } from './ui/peek';
// Last, so the hubs and the learning layer's chrome win over the older top-bar rules.
import './styles/learn.css';
// The Dreamcast skin re-points every token and primitive: it must come after all of them.
import './styles/dc.css';
// The hubs' names (after dc.css, which made them icons only).
import './styles/dc-nav.css';
import './styles/dc-polish.css';
// The phone layer, last: safe areas, the visible height, touch taps (desktop doesn't move).
import './styles/mobile.css';

/* ── Boot ───────────────────────────────────────────────────────────────── */
const bootTip = document.getElementById('boot-tip')!;
bootTip.textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
const bootBar = document.querySelector('.boot-bar i') as HTMLElement;
const bootStep = document.getElementById('boot-step');
const bootN = document.getElementById('boot-n');
/** Progress, and the step it is on (the bar says how far; the label says what is happening). */
const setBoot = (p: number, step?: string, n?: number) => {
  bootBar.style.width = Math.round(p * 100) + '%';
  if (step && bootStep) bootStep.textContent = step;
  if (n && bootN) bootN.textContent = `${n} / 4`;
};

let engineOrNull: Engine | null = null;
try { engineOrNull = new Engine(document.getElementById('gl') as HTMLCanvasElement); } catch (e) {
  bootTip.textContent = 'This browser can’t draw the game’s 3D graphics (WebGL). Try a recent Chrome, Firefox or Safari, with hardware acceleration switched on.';
  bootTip.style.color = '#EE7D69';
  throw e;
}
const engine: Engine = engineOrNull;
(window as unknown as { __structs: unknown }).__structs = { engine, navigate: (p: string) => navigate(p), screens: () => screens, store, live, wallet, txq, empire, pow, replicants, step: (s: number) => engine.advance(s) };

type RouteName = 'galaxy' | 'planet' | 'sim' | 'codex' | 'combat' | 'grid' | 'command' | 'ops' | 'forge' | 'comms' | 'intel' | 'economy' | 'guild' | 'academy' | 'lobby';
const screens: Partial<Record<RouteName, Screen>> = {};
/* Screens load on first visit (separate chunks), then stay alive. */
const LOADERS: Record<RouteName, () => Promise<Screen>> = {
  galaxy: () => import('./screens/galaxy').then((m) => new m.GalaxyScreen(engine, navigate)),
  planet: () => import('./screens/planet').then((m) => new m.PlanetScreen(engine, navigate)),
  sim: () => import('./screens/battle/battle').then((m) => new m.BattleScreen(engine, navigate)),
  codex: () => import('./screens/codex').then((m) => new m.CodexScreen(engine, navigate)),
  combat: () => import('./screens/combat').then((m) => new m.CombatScreen(engine, navigate)),
  grid: () => import('./screens/grid').then((m) => new m.GridScreen(engine, navigate)),
  command: () => import('./screens/command').then((m) => new m.CommandScreen(engine, navigate)),
  ops: () => import('./screens/ops').then((m) => new m.OpsScreen(engine, navigate)),
  forge: () => import('./screens/forge').then((m) => new m.ForgeScreen(engine, navigate)),
  comms: () => import('./screens/comms').then((m) => new m.CommsScreen(engine, navigate)),
  intel: () => import('./screens/intel').then((m) => new m.IntelScreen(engine, navigate)),
  guild: () => import('./screens/guild').then((m) => new m.GuildScreen(engine, navigate)),
  economy: () => import('./screens/economy').then((m) => new m.EconomyScreen(engine, navigate)),
  academy: () => import('./screens/academy').then((m) => new m.AcademyScreen(engine, navigate)),
  lobby: () => import('./screens/lobby/lobby').then((m) => new m.LobbyScreen(engine, navigate)),
};
async function screenFor(name: RouteName): Promise<Screen> {
  if (!screens[name]) {
    // A screen's first visit loads its chunk: past a beat, the console's NOW LOADING says so.
    const note = h('div', { class: 'dc-now-loading', 'aria-hidden': 'true' }, 'NOW LOADING');
    const t = setTimeout(() => document.body.appendChild(note), 300);
    try { screens[name] = await LOADERS[name](); } finally { clearTimeout(t); note.remove(); }
  }
  return screens[name]!;
}

/* ── Router ─────────────────────────────────────────────────────────────── */
let current: { name: RouteName; screen: Screen; key: string } | null = null;
let switching = false;
let entering: Screen | null = null;
let pending: string | null = null;
/** A URL the entering screen rewrote itself to (replaceRoute during enter). */
let replaced: string | null = null;

function parse(path: string): { name: RouteName; params: Record<string, string> } {
  const parts = normalizeRoute(path).slice(1).split('/').filter(Boolean);
  const [head, arg] = parts;
  if (head === 'planet' && arg) return { name: 'planet', params: { id: arg } };
  if (head === 'player' && arg) return { name: 'planet', params: { player: arg } };
  if (head === 'sim') return { name: 'sim', params: arg ? { code: arg } : {} };
  if (head === 'codex') return { name: 'codex', params: arg ? { type: arg } : {} };
  if (head === 'combat') return { name: 'combat', params: arg === 'by' && parts[2] ? { by: parts[2] } : arg ? { hash: arg, ...(parts[2] === 'e' ? { engage: '1' } : {}) } : {} };
  if (head === 'grid') return { name: 'grid', params: {} };
  if (head === 'lobby') return { name: 'lobby', params: {} };
  // The commander's own screens: /command[/<playerId>], /ops[/<tab>], /forge[/<Msg>], /comms[/<room>], /intel[/<tab>[/<arg>]]
  if (head === 'command') return { name: 'command', params: arg ? { player: arg } : {} };
  if (head === 'ops') return { name: 'ops', params: arg ? { tab: arg } : {} };
  if (head === 'forge') return { name: 'forge', params: arg ? { msg: arg } : {} };
  if (head === 'comms') return { name: 'comms', params: arg ? { room: decodeURIComponent(parts.slice(1).join('/')) } : {} };
  if (head === 'guild') return { name: 'guild', params: arg ? { guild: arg } : {} };
  if (head === 'economy') return { name: 'economy', params: { ...(arg ? { tab: arg } : {}), ...(parts[2] ? { arg: parts[2] } : {}) } };
  // /academy/<track>/<lesson>, or /academy/glossary/<word…> (a multi-word search, in segments or encoded).
  if (head === 'academy') return { name: 'academy', params: { ...(arg ? { track: arg } : {}), ...(parts[2] ? { lesson: safeDecode(parts.slice(2).join(' ')) } : {}) } };
  if (head === 'intel') return { name: 'intel', params: { ...(arg ? { tab: arg } : {}), ...(parts[2] ? { arg: parts[2] } : {}) } };
  return { name: 'galaxy', params: arg ? { focus: arg } : {} };
}

export function navigate(path: string) { goTo(path); }

function safeDecode(s: string) { try { return decodeURIComponent(s); } catch { return s; } }

async function route() {
  if (switching) { pending = currentRoute(); return; }
  switching = true;
  try {
    const { name, params } = parse(currentRoute());
    const key = name + JSON.stringify(params);
    if (current && current.key === key) return;
    // The page names itself after the screen (screens refine this once they know more).
    setPageMeta(describeRoute(name, params));
    const sameScreen = current && current.name === name;
    closeGuide();
    document.querySelector('.more-menu')?.remove();
    if (current) {
      if (!sameScreen) await fade(true);
      current.screen.exit();
      clearScreenUi();
    }
    const screen = await screenFor(name);
    engine.setScreen(screen);
    entering = screen;
    replaced = null;
    await screen.enter(params);
    entering = null;
    // The screen may have rewritten its URL while opening (codex entry, attack): that's the route now.
    // Only its own rewrite counts; a real navigation meanwhile is queued in pending and entered next.
    const now = replaced ? parse(replaced) : null;
    replaced = null;
    current = { name, screen, key: now && now.name === name ? name + JSON.stringify(now.params) : key };
    setActiveNav(name);
    if (!sameScreen) { engine.materialize(); riseIn(); }
    await fade(false);
    // The Academy counts screens seen; a screen opened for the first time explains itself.
    academy.visit(currentRoute());
    // (The Academy explains itself; its card is one ? away.)
    if (!sameScreen && name !== 'academy') showGuide(name, currentRoute(), navigate);
    // A screen loaded fine: a later chunk failure (a new deploy) may reload once again.
    try { sessionStorage.removeItem('structs.reloaded'); } catch { /* ignore */ }
  } catch (e) {
    console.error(e);
    // The old screen already exited. A half-entered one is exited too, so its listeners and
    // UI don't linger; then the next navigation starts clean.
    if (entering) { try { entering.exit(); } catch { /* best effort */ } entering = null; }
    clearScreenUi();
    current = null;
    toast('Could not open that screen: ' + String((e as Error).message || e), 'enemy', 5000);
    await fade(false);
  } finally {
    switching = false;
    if (pending) { pending = null; void route(); }
  }
}

function clearScreenUi() {
  document.querySelectorAll('#ui > .screen, .banner, .tooltip').forEach((n) => n.remove());
}

/* ── Top bar ────────────────────────────────────────────────────────────── */
/* Six hubs hold every screen (src/ui/hubs.ts); the Academy, Find, chat, the vault and your moves
 * sit on the right; status and client tools fold into one dot and a More menu (the pro status
 * bar in settings spells the links and the block out again). */
let hubNav: HubNav | null = null;
function setActiveNav(_name: RouteName) { hubNav?.setActive(currentRoute()); refitTopbar(); }
/** Re-fit the bar (buildTopbar sets it): which hub is active changes its width when only that one is named. */
let refitTopbar = () => {};

function buildTopbar() {
  const mark = h('div', { class: 'brand-mark', html: MARK });
  const brand = h('a', { class: 'brand', href: '/galaxy', title: 'Structs: the galaxy map' }, mark, h('span', { class: 'brand-name' }, 'STRUCTS'));
  // The home planet's view is My Base's own, so it lights the Base hub (it opens there by default).
  const homePlanet = () => { const pid = wallet.active?.playerId; return (pid && empire.players.get(pid)?.planetId) || null; };
  hubNav = buildHubNav(() => togglePalette(navigate), homePlanet);
  // The commander loads after the first paint: when the home planet becomes known (or changes), the
  // highlight follows, the menu staying as it is. Only then: the top bar fits itself on the first
  // paint, and an early extra pass at it settled some routes one stage tighter.
  let knownHome: string | null = null;
  empire.onChange(() => { const h = homePlanet(); if (h === knownHome) return; knownHome = h; hubNav?.setActive(currentRoute(), false); });

  // The Academy: the way in for anyone new, with how far along they are.
  const acad = h('a', { class: 'tb-academy', href: '/academy', title: 'Academy: short lessons on strategy, economics and technology, with XP', onclick: () => audio.play('select') });
  const paintAcad = () => {
    acad.classList.toggle('active', currentRoute().startsWith('/academy'));
    acad.replaceChildren(h('span', { class: 'tb-ico', html: icon('academy') }), h('span', { class: 'tb-academy-label' }, 'Academy'), h('span', { class: 'tb-academy-n' }, `${academy.doneCount}/${academy.total}`));
  };
  academy.onChange(paintAcad); paintAcad();
  window.addEventListener('structs:navigate', paintAcad); window.addEventListener('popstate', paintAcad);

  // Find: names, ids, addresses, screens and verbs, all in the command line.
  const findBtn = h('button', { class: 'tb-btn tb-find', title: 'Find a player, planet, screen or command (⌘K or /)', 'aria-label': 'Find', onclick: () => togglePalette(navigate) },
    h('span', { class: 'tb-ico', html: icon('find') }), h('span', { class: 'tb-find-label' }, 'Find'));

  // The links: one dot for everyone, each link spelled out in the pro status bar.
  const linkDot = h('span', { class: 'dot pulse' });
  const linkText = h('span', null, 'Linking');
  const link = h('div', { class: 'link-state warn', title: 'Live link to the Structs testnet (Tendermint WebSocket)' }, linkDot, linkText);
  const grassDot = h('span', { class: 'dot' });
  const grassPill = h('button', { class: 'link-state grass-pill warn', title: 'GRASS — the guild event stream', onclick: () => navigate('/intel/activity') }, grassDot, h('span', null, 'Grass'));
  const heightEl = h('span', { class: 'num' }, '—');
  const clock = h('div', { class: 'blockclock', title: 'Current block height' }, h('span', { class: 't-label' }, 'Block'), heightEl);
  const conn = h('button', { class: 'tb-conn warn', 'aria-label': 'Connection', onclick: () => navigate('/ops/health') }, h('span', { class: 'dot' })) as HTMLButtonElement;
  let liveState = 'connecting', grassState = 'connecting', height = 0;
  const paintConn = () => {
    const ok = liveState === 'live';
    conn.className = 'tb-conn ' + (ok ? 'ok' : liveState === 'connecting' ? 'warn' : 'bad');
    conn.title = (ok ? 'Connected to the galaxy' : liveState === 'connecting' ? 'Connecting to the galaxy…' : 'Can’t reach the galaxy right now')
      + (height ? ` · block ${height.toLocaleString('en-US')} (a new one every ~6 s)` : '')
      + ` · event stream ${grassState === 'live' ? 'live' : grassState === 'down' ? 'down' : 'connecting'} · click for system health`;
  };
  live.onState((st) => {
    link.className = 'link-state ' + (st === 'live' ? 'ok' : st === 'connecting' ? 'warn' : 'bad');
    linkText.textContent = st === 'live' ? 'Live' : st === 'connecting' ? 'Linking' : 'Offline';
    liveState = st; paintConn();
  });
  grass.onState((st) => {
    grassPill.className = 'link-state grass-pill ' + (st === 'live' ? 'ok' : st === 'down' ? 'bad' : 'warn');
    const fo = grass.failedOver;
    grassPill.title = `GRASS ${st}${grass.guildId ? ' · ' + store.guildName(grass.guildId) : ''} — the guild event stream${fo ? ` (${store.guildName(fo.guildId)}’s server ${fo.url} is not answering)` : ''}`;
    grassState = st; paintConn();
  });
  live.onBlock((b) => {
    heightEl.textContent = b.height.toLocaleString('en-US');
    clock.classList.remove('tick'); void clock.offsetWidth; clock.classList.add('tick');
    height = b.height; paintConn();
  });
  lcd.latestHeight().then((r) => { if (!live.height) { heightEl.textContent = r.height.toLocaleString('en-US'); height = r.height; paintConn(); } }).catch(() => { /* live feed will fill it */ });
  paintConn();

  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT' || !plainKey(e)) return;
    if (e.key === 'm' || e.key === 'M') toggleMute();
  });

  // Pinned commander: battery, grid status and ore at risk, one click from their world.
  const me = h('button', { class: 'me-chip', title: 'Your pinned commander' }) as HTMLButtonElement;
  me.addEventListener('click', () => { if (commander.id) navigate('/player/' + commander.id); });
  commander.onChange((st) => {
    me.style.display = commander.id ? '' : 'none';
    if (!st) { me.replaceChildren(h('span', { class: 't-label c-hint' }, commander.id ? 'Reading ' + commander.id + '…' : '')); return; }
    // Who it is; how they are doing is the VMU's job (face, battery, charge, ore at risk).
    me.title = `${st.name}: charge ${st.charge} (builds need 8) · grid ${st.online ? 'online' : 'offline: fix it in Trade › Power'}${st.storedOre ? ` · ${st.storedOre} ore at risk: refine it into alpha` : ''}`;
    me.replaceChildren(portrait(st.pfp, 'xs player', st.id), h('span', { class: 'me-name' }, st.name));
    if (!st.online) me.append(h('span', { class: 'chip enemy' }, 'Off'));
  });

  const helpBtn = h('button', { class: 'tb-btn tb-help', title: 'What is this screen? (?)', 'aria-label': 'Help for this screen', onclick: () => toggleHelp(), html: icon('help') });
  const moreBtn = h('button', { class: 'tb-btn tb-more', title: 'More: manual, settings, sound, picture', 'aria-label': 'More', 'aria-haspopup': 'menu', onclick: () => toggleMore(moreBtn) }, h('span', { html: icon('more') })) as HTMLButtonElement;
  window.addEventListener('keydown', (e) => { if ((e.target as HTMLElement)?.tagName !== 'INPUT' && plainKey(e) && (e.key === 'p' || e.key === 'P')) void snap(); });
  window.addEventListener('keydown', (e) => {
    if (isTyping(e)) return;
    if (e.key === '?') toggleHelp();
    if (e.key === 'Escape') {
      // Closing the manual is all this Escape does, when the manual is the window on top
      // (the screen behind keeps its selection; a window above the manual takes its own Escape).
      const modals = document.querySelectorAll('.modal-back');
      const top = modals[modals.length - 1];
      if (top?.classList.contains('help-back')) { top.remove(); e.stopImmediatePropagation(); }
      closeGuide(); document.querySelector('.more-menu')?.remove();
    }
  });
  // The vault: who you are, and whether you can sign.
  const walletChip = h('button', { class: 'wallet-chip', title: 'Vault (V)', onclick: () => { audio.play('select'); openVault(); } }) as HTMLButtonElement;
  const paintWallet = () => {
    const st = wallet.state;
    const a = wallet.active;
    const sp = a?.playerId ? store.players.get(a.playerId) : undefined;
    walletChip.className = 'wallet-chip ' + st;
    const lock = `<svg class="lock" viewBox="0 0 12 12"><rect x="2" y="5" width="8" height="6" fill="currentColor"/><path d="M4 5V3.5a2 2 0 0 1 4 0${st === 'unlocked' ? 'V3' : 'V5'}" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>`;
    // Not a lock (that means "needs a commander" on the hub tiles): a person joining.
    if (st === 'empty') { walletChip.innerHTML = icon('join', 16); walletChip.append(h('span', { class: 'nm' }, 'Enlist')); walletChip.title = 'Make your free commander and start playing (V)'; walletChip.setAttribute('aria-label', 'Enlist'); return; }
    walletChip.removeAttribute('aria-label');
    walletChip.replaceChildren(portrait(sp?.pfpClientRenderAttributes, 'xs', a?.address || ''), h('span', { class: 'nm' }, a?.label || 'Commander'));
    walletChip.insertAdjacentHTML('beforeend', lock);
    walletChip.title = st === 'unlocked' ? 'Vault open — signing as ' + (a?.label || '') + ' (V)' : 'Vault locked — click to unlock (V)';
  };
  wallet.onChange(paintWallet); store.onCore(paintWallet); paintWallet();
  // Moves: the queue and the hashers at a glance; click for the dock.
  const opsChip = h('button', { class: 'ops-chip', title: 'Moves in progress and proofs at work (Q)', onclick: () => opsDock().toggle() }) as HTMLButtonElement;
  const paintOps = () => {
    const active = txq.active.length;
    const failed = txq.jobs.filter((j) => j.status === 'failed' && Date.now() - j.updatedAt < 120_000).length;
    const hashing = pow.active.filter((t) => t.status === 'hashing').length;
    opsChip.className = 'ops-chip' + (failed ? ' fail' : active ? ' busy' : hashing ? ' hash' : '');
    opsChip.style.display = wallet.state === 'empty' && !active ? 'none' : '';
    opsChip.replaceChildren(...kids(
      h('i', { class: 'glyph' }), h('span', null, 'Moves'), active ? h('span', { class: 'n' }, String(active)) : null,
      hashing ? h('span', { class: 'n c-secondary' }, fmtRate(pow.rate).replace(' ', '')) : null,
    ));
  };
  txq.onChange(paintOps); pow.onChange(paintOps); wallet.onChange(paintOps);
  window.addEventListener('structs:help', () => toggleManual(navigate));
  window.addEventListener('structs:settings', () => openSettings(engine));
  window.addEventListener('structs:mute', () => toggleMute());
  window.addEventListener('structs:expert', () => { const on = !document.body.classList.contains('expert'); setExpert(engine, on); toast(on ? 'Expert mode on' : 'Expert mode off', 'player', 1800); });
  // ⌘K / Ctrl-K anywhere (even in a field) opens the command line.
  window.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); togglePalette(navigate); } }, true);
  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA' || !plainKey(e)) return;
    if (e.key === 'q' || e.key === 'Q') opsDock().toggle();
    if (e.key === 'c' || e.key === 'C') commsDock.toggle();
    if (e.key === '/' ) { e.preventDefault(); togglePalette(navigate); }
    if (e.key === 'v' || e.key === 'V') openVault();
  });
  // Comms: the slide-out chat with its unread badge (C toggles it).
  const commsDock = mountCommsDock(navigate);
  const cluster = h('div', { class: 'status-cluster' },
    acad, findBtn, commsDock.button, walletChip, opsChip, me, mountVmu(),
    h('div', { class: 'x-only x-contents' }, link, grassPill, clock), conn, helpBtn, moreBtn);
  const bar = h('div', { class: 'topbar' }, brand, hubNav.el, cluster);
  document.body.appendChild(h('div', { class: 'shell' }, bar));
  // The hubs keep their words while they fit beside whatever the right side holds (it grows with a
  // commander's chips): first everything tightens, then the hubs go to icons, then the extras step back.
  // Re-fit when the window or the right side changes size. fit() always lands on the same stage for
  // the same contents, so the resize its own stage change causes settles after one more pass.
  let fitQueued = 0;
  const fit = () => {
    fitQueued = 0;
    for (const st of ['', 'tight', 'icons', 'min']) { bar.dataset.fit = st; if (hubNav!.el.scrollWidth <= hubNav!.el.clientWidth + 1) break; }
  };
  const queueFit = () => { if (!fitQueued) fitQueued = requestAnimationFrame(fit); };
  refitTopbar = queueFit;
  window.addEventListener('resize', queueFit);
  new ResizeObserver(queueFit).observe(cluster);
  void document.fonts?.ready.then(queueFit);
  queueFit();
}

/** A new screen's panels rise into place as the fade lifts (dc-nav.css): only what is there on
 * arrival, so later repaints never replay it. */
let riseTimer = 0;
function riseIn() {
  document.body.classList.add('screen-rise');
  clearTimeout(riseTimer);
  riseTimer = window.setTimeout(() => document.body.classList.remove('screen-rise'), 900);
}

function toggleMute() {
  audio.toggle();
  document.querySelector('.more-menu')?.remove();
}

async function snap() {
  const blob = await engine.capture();
  if (!blob) { toast('Capture failed', 'warn'); return; }
  const a = h('a', { href: URL.createObjectURL(blob), download: `structs-${currentRoute().replace(/[^a-z0-9-]+/gi, '-').replace(/^-|-$/g, '') || 'deck'}-${Date.now()}.png` });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  audio.play('confirm');
  toast('Picture saved', 'player', 1400);
}

/** The More menu: help, the glossary, the tour, settings, sound, a picture of the view. */
/** Closes the open More menu (and its listeners); `back` hands focus to ⋯. */
let closeMore: ((back: boolean) => void) | null = null;
function toggleMore(anchor: HTMLElement) {
  const open = document.querySelector('.more-menu');
  if (open) { if (closeMore) closeMore(true); else open.remove(); return; }
  audio.play('select');
  // A picture and a name per row; what each does is in its title. A key shortcut shows as a cap.
  // A row closes the menu and hands focus back to ⋯ first, so a pad's next press starts there (a
  // window the row opens takes focus for itself).
  const item = (ico: string, label: string, hint: string, run: () => void, key = '') => h('button', { class: 'mm-item', role: 'menuitem', title: hint, onclick: () => { close(true); run(); } },
    h('span', { class: 'mm-ico', html: icon(ico, 18) }), h('span', { class: 'mm-label' }, label), key ? h('kbd', { class: 'mm-hint' }, key) : h('span'));
  const phoneOnly = (el: HTMLElement) => { el.classList.add('phone-only'); return el; };
  // A switch reads as a switch: the name, then an on/off pill (the state, not the action).
  const toggleItem = (ico: string, label: string, on: boolean, hint: string, run: () => void) => h('button', { class: 'mm-item', role: 'menuitemcheckbox', 'aria-checked': String(on), title: hint, onclick: () => { close(true); run(); } },
    h('span', { class: 'mm-ico', html: icon(ico, 18) }), h('span', { class: 'mm-label' }, label), h('span', { class: 'mm-switch' + (on ? ' on' : '') }, on ? 'On' : 'Off'));
  // tabindex -1: a click on the menu's own gaps or separators focuses the menu, not the page, so
  // the focus-leaving check below doesn't take it for a click away.
  const menu = h('div', { class: 'more-menu panel', role: 'menu', tabindex: -1 },
    // On a phone the top bar keeps only the hubs, the vault and More: the Academy and chat come here.
    phoneOnly(item('academy', 'Academy', 'Lessons on strategy, economics and technology', () => navigate('/academy'))),
    phoneOnly(item('chat', 'Chat', 'Talk with your guild', () => navigate('/comms'))),
    item('help', 'Help', 'What this screen is, and three things to try', () => toggleHelp(), '?'),
    item('find', 'Find', 'A player, planet, place or word', () => togglePalette(navigate), '/'),
    item('book', 'Manual', 'The field manual: everything, in tabs', () => toggleManual(navigate)),
    item('academy', 'Glossary', 'Every game word, explained', () => navigate('/academy/glossary')),
    item('star', 'Welcome', 'Where to start', () => showWelcome(navigate)),
    toggleItem('check', 'Tips', tipsOn(), tipsOn() ? 'Screen tips on: a card on each new screen' : 'Screen tips off: press ? on any screen', () => { setTips(!tipsOn()); toast(tipsOn() ? 'Tips on' : 'Tips off · ? for help', 'player', 2600); }),
    h('div', { class: 'mm-sep' }),
    item('gear', 'Settings', 'Sound, picture, alerts', () => openSettings(engine)),
    toggleItem('terminal', 'Expert', document.body.classList.contains('expert'), 'Expert mode: chain links, block numbers and raw details', () => {
      const on = !document.body.classList.contains('expert');
      setExpert(engine, on);
      toast(on ? 'Expert mode on' : 'Expert mode off', 'player', 2600);
    }),
    toggleItem(audio.muted ? 'mute' : 'sound', 'Sound', !audio.muted, 'Sound on or off (M)', () => toggleMute()),
    item('play', 'Picture', 'Save a picture of the screen', () => void snap(), 'P'),
    item('health', 'Health', 'System health: every connection, measured', () => navigate('/ops/health')));
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
  const away = (e: Event) => { if (!menu.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(false); };
  document.addEventListener('pointerdown', away, true);
  // Keys and the pad stay inside: focus starts on the first row, the arrows (the d-pad) step to the
  // nearest row that way (across too, where a short screen lays it out in two columns) and wrap at
  // the ends, Escape (B) closes it and hands focus back to ⋯, and focus leaving it closes it.
  const rows = () => [...menu.querySelectorAll<HTMLElement>('.mm-item')].filter((el) => el.offsetParent !== null);
  const close = (back: boolean) => {
    if (closeMore === close) closeMore = null;
    const had = menu.isConnected;
    menu.remove(); document.removeEventListener('pointerdown', away, true);
    if (back && had) anchor.focus({ preventScroll: true });
  };
  closeMore = close;
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return; }
    const dir = ({ ArrowDown: [0, 1], ArrowUp: [0, -1], ArrowRight: [1, 0], ArrowLeft: [-1, 0] } as Record<string, [number, number]>)[e.key];
    if (!dir) return;
    e.preventDefault(); e.stopPropagation();
    const all = rows(), cur = document.activeElement as HTMLElement;
    if (!all.includes(cur)) { all[0]?.focus(); return; }
    const a = cur.getBoundingClientRect(), [dx, dy] = dir;
    let best: HTMLElement | null = null, bestScore = Infinity;
    for (const el of all) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect();
      const x = b.left + b.width / 2 - (a.left + a.width / 2), y = b.top + b.height / 2 - (a.top + a.height / 2);
      const along = x * dx + y * dy, across = Math.abs(x * dy) + Math.abs(y * dx);
      if (along <= 4) continue;
      const score = along + across * 2;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    // Off an end: down wraps to the top, up to the bottom; across stays put.
    (best || (dy > 0 ? all[0] : dy < 0 ? all[all.length - 1] : cur)).focus();
    audio.play('hover', 0.5);
  });
  // Focus leaving for somewhere else closes it; leaving for nowhere (Tab past the last row) is
  // checked a frame later, once the browser has decided where focus went.
  menu.addEventListener('focusout', (e) => {
    const to = (e as FocusEvent).relatedTarget as Node | null;
    if (to) { if (!menu.contains(to) && !anchor.contains(to)) close(false); return; }
    requestAnimationFrame(() => { const at = document.activeElement; if (menu.isConnected && !menu.contains(at) && !anchor.contains(at)) close(false); });
  });
  rows()[0]?.focus({ preventScroll: true });
}

/** Help for where you are: the screen's guide card (the manual for anything without one). */
function toggleHelp() {
  if (document.querySelector('.guide-card')) { closeGuide(); return; }
  if (current && GUIDES[current.name]) showGuide(current.name, currentRoute(), navigate, true);
  else toggleManual(navigate);
}

/* ── Start ──────────────────────────────────────────────────────────────── */
// A deploy replaced the chunks under a running tab: reload once to pick up the new build.
/** A shortcut key on its own: not part of a system chord (Cmd/Ctrl+P, Cmd+M…), not auto-repeat,
 * and not typed into a field (a recovery phrase, a chat message). */
function plainKey(e: KeyboardEvent) { return !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat && !isTyping(e); }
function isTyping(e: KeyboardEvent) { const t = e.target as HTMLElement | null; return !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable); }

window.addEventListener('vite:preloadError', () => { if (!sessionStorage.getItem('structs.reloaded')) { sessionStorage.setItem('structs.reloaded', '1'); location.reload(); } });

async function boot() {
  // Old #/… links open the same screens at their path form.
  if (location.hash.startsWith('#/')) history.replaceState(null, '', withBase(normalizeRoute(location.hash)));
  interceptLinks();
  setBoot(0.1, 'Loading the game', 1);
  // The DC kit's faces (src/styles/dc.css): labels and numbers, then words.
  await Promise.race([document.fonts.load('900 10px "DC Display"'), new Promise((r) => setTimeout(r, 1500))]);
  await Promise.race([Promise.all([document.fonts.load('500 14px "DC Text"'), document.fonts.load('800 14px "DC Text"')]), new Promise((r) => setTimeout(r, 800))]);
  setBoot(0.3, 'Reading your last visit', 2);
  applySettings(engine, loadSettings());
  // Instant boot: last visit's roster paints first; the live read replaces it.
  store.onRosterRead = (snap) => { void saveRoster(snap); };
  void loadRoster<RawPlayer, RawFleet, RawGuild>().then((r) => { if (r) store.hydrate(r); }).catch(() => { /* no cache */ });
  onGuilds((list) => store.setGuildNames(list.map((g) => ({ id: g.id, name: g.meta?.name, tag: g.meta?.tag }))));
  void guilds().catch(() => { /* names fall back to ids */ });
  const grassOn = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_GRASS_URL !== 'off';
  if (grassOn) grass.start();
  // The guild indexer often hears about our objects before the next periodic read: refresh on it.
  // Debounced per player: a burst of indexer events is one re-read, not one each.
  const grassTimers = new Map<string, number>();
  if (grassOn) grass.on(undefined, (e) => {
    for (const id of [e.playerId, e.planetId, e.objectId]) if (id && empire.isMine(id)) {
      const p = empire.ownerOf(id) || empire.players.get(id);
      if (p && !grassTimers.has(p.playerId)) grassTimers.set(p.playerId, window.setTimeout(() => { grassTimers.delete(p.playerId); void empire.refresh(p.playerId); }, 2500));
      return;
    }
  });
  live.start();
  narrateJobs();
  startAlerts();
  startMissions();
  // Forgetting the vault lets go of everything that acted for it.
  wallet.onForget(() => {
    // The session id an older version kept for its guild relay, if any.
    try { localStorage.removeItem('structs.relay.session'); } catch { /* ignore */ }
    void cache.clear('guild-api');
    try { for (const k of Object.keys(sessionStorage)) if (k.startsWith('structs.guild.session')) sessionStorage.removeItem(k); } catch { /* ignore */ }
    void comms.forget();
    pow.resetForVault();
    replicants.resetDoctrine();
    commander.pin(null);
  });
  commander.owned = (pid) => empire.commands(pid);
  void empire; void pow; void replicants; void record;
  // The wallet's commander is the one whose vitals ride in the top bar, unless another was pinned.
  const pinOwn = () => { const pid = wallet.active?.playerId; if (pid && (!commander.id || wallet.byPlayer(commander.id))) { if (commander.id !== pid) commander.pin(pid); } };
  wallet.onChange(pinOwn); pinOwn();
  // A one-click vault opens itself; a signup the guild was still working on picks up again.
  await Promise.race([wallet.restore(), new Promise((r) => setTimeout(r, 5000))]).catch((e) => toast((e as Error).message, 'enemy', 9000, { label: 'Vault', run: () => openVault() }));
  wallet.onChange(resumeEnlist); resumeEnlist();
  setBoot(0.45, 'Connecting to the galaxy', 3);
  if (wallet.state === 'locked' && txq.active.length) toast(`${txq.active.length} queued move(s) wait for your vault`, 'warn', 6000, { label: 'Unlock', run: () => openVault() });
  void store.loadCore().catch((e) => { console.warn(e); toast('Could not reach the Structs testnet LCD', 'enemy', 6000); });
  buildTopbar();
  ui();
  engine.start();
  setBoot(0.6, 'Drawing the galaxy', 4);
  window.addEventListener('popstate', () => void route());
  window.addEventListener('structs:navigate', () => void route());
  // A screen rewrote its URL in place: that is now the route being shown.
  window.addEventListener('structs:replace-route', (e) => {
    if (entering) { replaced = (e as CustomEvent<string>).detail; return; }
    if (!current) return;
    const { name, params } = parse((e as CustomEvent<string>).detail);
    if (name === current.name) current.key = name + JSON.stringify(params);
    academy.visit((e as CustomEvent<string>).detail);
    hubNav?.setActive(currentRoute(), false);
  });
  // A real attack anywhere on the chain: offer to watch it (at most one offer every 20 s).
  let lastOffer = 0;
  store.onFeed((item) => {
    if (item.kind !== 'attack' || item.replay || !item.hash || current?.name === 'combat' || Date.now() - lastOffer < 20000) return;
    lastOffer = Date.now();
    toast(item.text, 'enemy', 7000, { label: 'Watch ▸', run: () => navigate('/combat/' + item.hash) });
  });
  await route();
  setBoot(1, 'Ready');
  // Someone new: the welcome on the front door, a nudge toward it anywhere else (a shared link).
  wireTerms();
  // (The galaxy's title is the front door, with its own Academy door; anywhere else gets a nudge.)
  if (document.querySelector('.title-overlay')) markWelcomed();
  // (Elsewhere, a newcomer finds the welcome from the Structs mark, the hubs or More › Welcome.)
  // Only when the title stepped aside on the galaxy itself, not because the galaxy is being left.
  window.addEventListener('structs:title-closed', () => { if (!switching && current?.name === 'galaxy' && parse(currentRoute()).name === 'galaxy') showGuide('galaxy', currentRoute(), navigate); });
  setTimeout(() => document.getElementById('boot')!.classList.add('done'), 250);
  setTimeout(() => { document.getElementById('boot')!.remove(); document.getElementById('seo')?.remove(); }, 1200);
  // A controller plays the whole game: buttons become the keys every screen already knows.
  try { startPad(); } catch (e) { console.warn('[pad] no controllers here', e); }
  // A tap reads what a hover would (stat chips and icons explain themselves in their titles).
  startPeek();
  // Warm the model cache while idle so the simulator and codex open instantly.
  const idle = (window as unknown as { requestIdleCallback?: (f: () => void) => void }).requestIdleCallback || ((f: () => void) => setTimeout(f, 1500));
  idle(() => { for (const t of STRUCT_TYPES) { void getPixelModel(t.id, 'player'); void getPixelModel(t.id, 'enemy'); } });
}

void boot();
// Installed or not, the app shell works offline (production builds only; dev serves fresh files).
if ((import.meta as { env?: { PROD?: boolean } }).env?.PROD && 'serviceWorker' in navigator) {
  // The build id names the cache, so each deploy starts clean and the last one's chunks are dropped.
  // Registered from the base path, so its scope is the site (a GitHub project page included).
  window.addEventListener('load', () => { navigator.serviceWorker.register(asset('/sw.js') + '?v=' + encodeURIComponent(__BUILD_ID__)).catch(() => { /* optional */ }); });
}
