/* ⌘K — the command line. Type a screen, an id, a name, or a verb:
 *   build extractor · sail 2-7 · home · explore · send 5 to Janet-Reed · replicate raider
 *   1-42 · 2-9 · janet · deck janet · forge attack · ops proofs · intel guild 0-5
 * Suggestions as you type; Enter runs the top one (or the highlighted), Tab completes. */
import '../styles/deck.css';
import { h, toast, confirmBox } from '../core/dom';
import { parseAlpha } from '../game/economy';
import { audio } from '../core/audio';
import { store } from '../chain/store';
import { wallet } from '../wallet/wallet';
import { empire } from '../game/empire';
import { act, buildable, exploreConfirmed, reservedSlots } from '../game/actions';
import { replicants, type Role } from '../game/replicants';
import { pow } from '../pow/pow';
import { MSGS } from '../wallet/schema.gen';
import { STRUCT_TYPES, AMBITS } from '../data/catalogue';
import { openVault } from './vault';
import { opsDock } from './opsDock';
import { isAddress } from '../wallet/keys';
import { lcd } from '../chain/lcd';
import { academy } from '../game/academy';
import { GLOSSARY } from '../data/learn';

interface Cmd { line: string; what: string; group: string; run: () => void | Promise<void> }

/** [word, route, what, alias?]: each screen answers to its own name and to the friendly one the hubs
 * use (base, training, replays…); an alias only shows once you type it. */
const SCREENS: [string, string, string, 1?][] = [
  ['academy', '/academy', 'Lessons on strategy, economics and technology'], ['learn', '/academy', 'The Academy', 1], ['glossary', '/academy/glossary', 'Every game word, explained'],
  ['command', '/command', 'My Base: your planet, fleet and next moves'], ['base', '/command', 'My Base', 1], ['galaxy', '/galaxy', 'Galaxy Map: the live galaxy'], ['combat', '/combat', 'Battle Replays: every real attack'], ['replays', '/combat', 'Battle Replays', 1],
  ['grid', '/grid', 'Power Grid: where energy flows'], ['intel', '/intel', 'News & Rankings: activity, guilds, leaderboards'], ['news', '/intel', 'News & Rankings', 1], ['leaderboards', '/intel/leaderboards', 'The galaxy’s rankings'], ['comms', '/comms', 'Chat with your guild'], ['chat', '/comms', 'Chat', 1],
  ['sim', '/sim', 'Training Battles against the computer'], ['training', '/sim', 'Training Battles', 1], ['codex', '/codex', 'Unit Guide: every struct type'], ['units', '/codex', 'Unit Guide', 1], ['ops', '/ops', 'Engine room: moves, proofs, robots, orders'],
  ['forge', '/forge', 'Code Lab: every chain message as a form'], ['code', '/forge', 'Code Lab', 1], ['economy', '/economy', 'Trade: power, fuel, market, banks'], ['trade', '/economy', 'Trade', 1], ['market', '/economy/market', 'Energy Market'], ['banks', '/economy/banks', 'Guild banks'],
  ['guild', '/guild', 'Guild Hall: roster, membership desk'], ['team', '/guild', 'Guild Hall', 1], ['permissions', '/guild/perms', 'Who may act for you'], ['queue', '/ops/queue', 'Moves in progress'], ['moves', '/ops/queue', 'Moves in progress', 1], ['proofs', '/ops/proofs', 'Proof engine: hash puzzles'],
  ['replicants', '/ops/replicants', 'Robot Helpers: the replicant foundry'], ['robots', '/ops/replicants', 'Robot Helpers', 1], ['orders', '/ops/orders', 'Robot Rules: standing orders'], ['rules', '/ops/orders', 'Robot Rules', 1],
  ['record', '/ops/record', 'Rank, XP and missions'], ['missions', '/ops/record', 'The mission ladder', 1], ['health', '/ops/health', 'System Health: every link, measured'], ['daily', '/sim/daily', 'Daily Challenge'],
];

const POPULAR = ['academy', 'training', 'galaxy', 'base', 'replays', 'units', 'trade', 'chat', 'code', 'glossary'];

let el: HTMLElement | null = null;

export function togglePalette(navigate: (hash: string) => void) {
  if (el) { close(); return; }
  const input = h('input', { class: 'input pal-input', placeholder: 'Find a player, planet, place or command…', spellcheck: false, autocomplete: 'off' }) as HTMLInputElement;
  const list = h('div', { class: 'pal-list scroll' });
  el = h('div', { class: 'modal-back pal-back', onclick: (e: Event) => { if (e.target === el) close(); } },
    h('div', { class: 'pal panel player' }, input, list, h('div', { class: 'pal-foot t-tiny c-hint' },
      // The grammar, said once: a command is a verb, then what it acts on.
      h('div', { class: 'pal-syntax' }, h('span', { class: 'c-player' }, 'verb'), ' + ', h('span', { class: 'c-secondary' }, 'details'), ' → ',
        h('code', null, h('span', { class: 'c-player' }, 'build'), ' ', h('span', { class: 'c-secondary' }, 'extractor')), ' · ',
        h('code', null, h('span', { class: 'c-player' }, 'sail'), ' ', h('span', { class: 'c-secondary' }, '2-7')), ' · ',
        h('code', null, h('span', { class: 'c-player' }, 'send'), ' ', h('span', { class: 'c-secondary' }, '5 to janet'))),
      h('span', null, h('kbd', null, '↑↓'), ' pick  ', h('kbd', null, 'Tab'), ' complete  ', h('kbd', null, '↵'), ' run  ', h('kbd', null, 'Esc'), ' close'))));
  document.body.appendChild(el);
  audio.play('select');
  academy.mark('palette');
  let cmds: Cmd[] = [];
  let cur = 0;
  const paint = () => {
    cmds = suggest(input.value, navigate);
    cur = Math.min(cur, Math.max(0, cmds.length - 1));
    let last = '';
    list.replaceChildren(...cmds.slice(0, 40).flatMap((c, i) => {
      const head = c.group !== last ? [h('div', { class: 'pal-group t-label c-hint' }, c.group)] : [];
      last = c.group;
      return [...head, h('button', { class: 'pal-row' + (i === cur ? ' on' : ''), onmousedown: (e: Event) => { e.preventDefault(); void run(c); } },
        h('span', { class: 'pal-line' }, c.line), h('span', { class: 't-tiny c-hint' }, c.what))];
    }));
    if (!cmds.length) list.replaceChildren(h('div', { class: 'pane-empty' }, 'No match. Try “help”.'));
    list.querySelector('.pal-row.on')?.scrollIntoView({ block: 'nearest' });
  };
  const run = async (c: Cmd) => {
    close();
    audio.play('confirm');
    try { await c.run(); } catch (e) { audio.play('deny'); toast((e as Error).message, 'enemy', 4500); }
  };
  input.addEventListener('input', () => { cur = 0; paint(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); cur = Math.min(cmds.length - 1, cur + 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cur = Math.max(0, cur - 1); paint(); }
    else if (e.key === 'Tab') { e.preventDefault(); if (cmds[cur]) { input.value = cmds[cur].line + ' '; paint(); } }
    else if (e.key === 'Enter') { e.preventDefault(); if (cmds[cur]) void run(cmds[cur]); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  paint();
  input.focus();
}

function close() { el?.remove(); el = null; }

function me() {
  const pid = wallet.active?.playerId;
  const p = pid ? empire.players.get(pid) : undefined;
  if (!p) throw new Error(wallet.state === 'empty' ? 'Enlist first (V opens the vault)' : 'Your commander is still loading, or has no player yet');
  if (wallet.state !== 'unlocked') { openVault(); throw new Error('Unlock the vault to act'); }
  return p;
}

function playerByQuery(q: string) {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  if (/^1-\d+$/.test(s)) { const p = store.players.get(s); return p ? [p] : [{ id: s, name: s, planetId: '', primaryAddress: '' } as never]; }
  const out = [];
  for (const p of store.players.values()) if (p.name && p.name.toLowerCase().includes(s)) { out.push(p); if (out.length >= 6) break; }
  return out.sort((a, b) => Number(b.name.toLowerCase() === s) - Number(a.name.toLowerCase() === s));
}

function suggest(raw: string, nav: (h: string) => void): Cmd[] {
  const text = raw.trim();
  const lower = text.toLowerCase();
  const [verb, ...rest] = lower.split(/\s+/);
  const arg = rest.join(' ');
  const out: Cmd[] = [];
  const go = (hash: string) => () => nav(hash);

  // Nothing typed yet: a short list of the places people go most; typing searches all of them.
  if (!text) {
    for (const w of POPULAR) { const sc = SCREENS.find((x) => x[0] === w); if (sc) out.push({ line: sc[0], what: sc[2], group: 'Popular places', run: go(sc[1]) }); }
    return out;
  }

  // Ids first: they are unambiguous.
  const id = /^(\d{1,2})-(\d+)$/.exec(text);
  if (id) {
    const k = Number(id[1]);
    if (k === 1) out.push({ line: text, what: `Player ${store.playerName(text)} — their planet`, group: 'Go to', run: go('/player/' + text) }, { line: `visit ${text}`, what: 'Their base', group: 'Go to', run: go('/command/' + text) });
    if (k === 2) out.push({ line: text, what: 'Planet map', group: 'Go to', run: go('/planet/' + text) }, { line: `sail ${text}`, what: 'Send your fleet there', group: 'Act', run: () => { act.fleetMove(me(), text); } });
    if (k === 0) out.push({ line: text, what: `Guild ${store.guildName(text)}`, group: 'Go to', run: go('/intel/guild/' + text) });
    if (k === 9) { const f = store.fleets.get(text); out.push({ line: text, what: 'Fleet owner', group: 'Go to', run: go('/player/' + (f?.owner || '1-' + id[2])) }); }
  }
  if (isAddress(text)) out.push({ line: text, what: 'Who is this?', group: 'Go to', run: async () => {
    const pid = store.byAddress.get(text) || await lcd.address(text).then((r) => r.playerId && r.playerId !== '1-0' ? r.playerId : '').catch(() => '');
    if (pid) nav('/player/' + pid); else toast('No player at that address', 'warn');
  } });
  // A bare number is a player's index (42 → 1-42).
  if (/^\d+$/.test(text)) out.push({ line: text, what: `Player 1-${text} — their planet`, group: 'Go to', run: go('/player/1-' + text) });

  // Verbs.
  const V = (line: string, what: string, run: () => void | Promise<void>, group = 'Act') => out.push({ line, what, group, run });
  if (!text || 'build'.startsWith(verb) && !arg) V('build', 'build <type> [ambit] — into your first free slot', () => nav('/command'));
  if (verb === 'build' && arg) {
    const ambit = AMBITS.find((a) => rest.includes(a));
    // The whole phrase names the type ("ore bunker", "bunker"); exact and prefix matches rank first.
    const phrase = rest.filter((w) => !AMBITS.includes(w as never)).join(' ');
    const rank = (n: string) => (n === phrase ? 0 : n.startsWith(phrase) ? 1 : n.split(' ').some((w) => w.startsWith(phrase)) ? 2 : 3);
    const matches = STRUCT_TYPES.filter((x) => x.id !== 1 && x.type.toLowerCase().includes(phrase)).sort((a, b) => rank(a.type.toLowerCase()) - rank(b.type.toLowerCase()));
    for (const t of matches.slice(0, 6)) {
      V(`build ${t.type.toLowerCase()}${ambit ? ' ' + ambit : ''}`, `${t.category} · ⚡${t.buildCharge} · proof range ${t.buildDifficulty}`, () => {
        const p = me();
        const owned = [...p.structs.values()].filter((x) => x.typeId === t.id && !x.destroyed).length;
        if (t.buildLimit && owned >= t.buildLimit) throw new Error(`Build limit reached: ${t.buildLimit} ${t.type} per player`);
        const holder = (t.category === 'planet' ? p.planet?.Planet : p.fleet) as unknown as Record<string, string[] | string> | undefined;
        if (!holder) throw new Error(`No ${t.category} to build on`);
        for (const a of ambit ? [ambit] : AMBITS) {
          if (!buildable(t.category, a).some((x) => x.id === t.id)) continue;
          const slots = (holder[a] as string[]) || [];
          const n = Math.max(Number(holder[a + 'Slots'] || 0), slots.length);
          const held = reservedSlots(p.playerId);
          for (let i = 0; i < n; i++) if (!slots[i] && !held.has(`${t.category}:${a}:${i}`)) { act.build(p, t, a, i); toast(`${t.type} queued · ${a} ${i + 1}`, 'player'); return; }
        }
        throw new Error(`No free slot for a ${t.type}`);
      });
    }
  }
  // Verbs that act match the whole word only: a stray "h" or "r" + Enter must never recall a raid
  // or birth a replicant.
  if (verb === 'explore') V('explore', 'Claim a fresh planet (abandons this one)', async () => { await exploreConfirmed(me()); });
  if (verb === 'home') V('home', 'Fleet returns home', async () => { const p = me(); if (p.fleet?.status === 'away' && !(await confirmBox('Recall the fleet', `Bring ${p.name}’s fleet home from ${p.fleet.locationId}? A raid in progress is abandoned.`, 'Recall', 'enemy'))) return; act.fleetMove(p, p.planetId); });
  if ((verb === 'sail' || verb === 'raid' || verb === 'go') && arg) {
    if (/^2-\d+$/.test(arg)) V(`sail ${arg}`, 'Send your fleet to that planet', () => { act.fleetMove(me(), arg); });
    for (const p of playerByQuery(arg)) if (p.planetId) V(`sail ${p.name}`, `Fleet to ${p.name}’s planet ${p.planetId}`, () => { act.fleetMove(me(), p.planetId); });
  }
  if (verb === 'send' && rest.length >= 2) {
    // Exact units, no float: "2.5", "2.5alpha", "300000ualpha". Never sent without a confirm.
    const ualpha = parseAlpha(rest[0]);
    const who = rest.slice(1).join(' ').replace(/^to\s+/, '');
    if (ualpha && ualpha > 0n) for (const p of playerByQuery(who)) if (p.primaryAddress) {
      const shown = `${Number(ualpha) / 1e6} alpha`;
      V(`send ${rest[0]} to ${p.name}`, `${shown} → ${p.id}`, async () => {
        const from = me();
        if (!(await confirmBox('Send alpha', `Send ${shown} (${ualpha} ualpha) from ${from.name} (${from.playerId}) to ${p.name || p.id} (${p.id}, ${p.primaryAddress})? Transfers cannot be undone.`, 'Send', 'player'))) return;
        act.send(from, p.primaryAddress, ualpha);
        toast('Transfer queued', 'player');
      });
    }
  }
  if (verb === 'replicate') for (const r of ['productive', 'bait', 'raider'] as Role[]) if (!arg || r.startsWith(arg)) V(`replicate ${r}`, `Spawn a ${r} replicant`, async () => {
    if (!(await confirmBox('Replicate', `Birth a ${r} replicant? It derives the next key from your phrase, signs up with your guild, claims a planet and runs on standing orders.`, 'Replicate', 'player'))) return;
    nav('/ops/replicants'); await replicants.replicate(r);
  });
  if (verb === 'rally') V(`rally ${arg || '<planet>'}`, 'Raiders sail here (empty: home)', () => { replicants.set({ rally: /^2-\d+$/.test(arg) ? arg : '' }); toast(arg ? `Raiders rally at ${arg}` : 'Raiders hold at home', 'player'); });
  if (verb === 'say' && arg) V(`say ${arg}`, 'Draft it in comms (you press send)', async () => { (await import('./comms/dock')).mountCommsDock().draft(text.slice(4)); }, 'Comms');
  if (('comms'.startsWith(verb) || 'chat'.startsWith(verb)) && verb.length > 1 && !arg) V('chat', 'Open the comms dock', async () => { (await import('./comms/dock')).mountCommsDock().open(); }, 'Comms');
  if ('targets'.startsWith(verb) && verb.length > 1) V('targets', 'Target board: the fattest, softest holds in the galaxy', async () => { (await import('./targets')).openTargets(nav); }, 'War');
  if (verb === 'autopilot') V(`autopilot ${replicants.doctrine.commanderAutopilot ? 'off' : 'on'}`, 'Commander autopilot', () => replicants.set({ commanderAutopilot: !replicants.doctrine.commanderAutopilot }));
  if ((verb === 'pow' || verb === 'hash')) V(pow.settings.enabled ? 'pow pause' : 'pow resume', pow.settings.enabled ? 'Pause the hashers' : 'Resume hashing', () => pow.save({ enabled: !pow.settings.enabled }), 'Engine');
  if (verb === 'lock') V('lock', 'Lock the vault now', () => wallet.lock(), 'Vault');
  if (('vault'.startsWith(verb) || 'unlock'.startsWith(verb) || 'wallet'.startsWith(verb)) && verb) V('vault', 'Open the vault', () => openVault(), 'Vault');
  if ('queue'.startsWith(verb) && verb && verb.length > 1) V('queue', 'Open the ops dock', () => opsDock().open('queue'), 'Vault');
  if ((verb === 'deck' || verb === 'watch' || verb === 'visit') && arg) for (const p of playerByQuery(arg)) V(`visit ${p.name}`, `Visit ${p.name}’s base (look only)`, go('/command/' + p.id), 'Go to');
  if (verb === 'forge') for (const n of Object.keys(MSGS).filter((m) => !arg || m.toLowerCase().includes(arg.replace(/\s+/g, ''))).slice(0, 12)) V(`forge ${n.replace(/^Msg/, '')}`, MSGS[n].doc.slice(0, 80) || 'Hand-craft this message', go('/forge/' + n), 'Forge');

  // Screens.
  for (const [w, hash, what] of SCREENS) if (w.startsWith(lower) || (verb === w && arg)) out.push({ line: w + (verb === w && arg ? ' ' + arg : ''), what, group: 'Screens', run: go(hash + (verb === w && arg ? '/' + arg.replace(/\s+/g, '/') : '')) });

  // Names: any commander in the galaxy.
  if (text.length >= 2 && !id && !['build', 'send', 'sail', 'forge', 'deck', 'watch', 'visit', 'raid', 'go'].includes(verb)) {
    for (const p of playerByQuery(text)) out.push({ line: p.name, what: `${p.id} · ${store.guildName((p as { guildId?: string }).guildId || '')}`, group: 'Commanders', run: go('/player/' + p.id) });
  }
  // A game word: what it means, right here (Enter opens the glossary on it).
  if (text.length >= 3) for (const t of GLOSSARY) if (t.word.toLowerCase().includes(lower) || t.key === lower)
    out.push({ line: t.word, what: t.short.length > 90 ? t.short.slice(0, 88) + '…' : t.short, group: 'What does it mean?', run: go('/academy/glossary/' + encodeURIComponent(t.word.replace(/\s*\(.*$/, '').replace(/\s*\/.*$/, ''))) });
  for (const [w, ev, what] of [['manual', 'structs:help', 'Field manual'], ['tips', 'structs:help', 'Field manual and keys'], ['expert', 'structs:expert', 'Expert mode on/off: technical details'], ['settings', 'structs:settings', 'Sound, graphics, motion, text size, alerts'], ['mute', 'structs:mute', 'Toggle sound']] as const)
    if (w.startsWith(lower) && lower.length > 1) out.push({ line: w, what, group: 'Client', run: () => { window.dispatchEvent(new Event(ev)); } });
  if ('help'.startsWith(lower) && lower) out.push({ line: 'help', what: 'build <type> · sail <planet|name> · home · explore · send <n> to <name> · replicate <role> · rally <planet> · visit <name> · forge <msg> · lock', group: 'Help', run: () => toast('Try: build extractor · sail 2-7 · send 5 to janet · replicate raider · forge attack', 'player', 7000) });
  return out;
}
