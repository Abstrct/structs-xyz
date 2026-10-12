/* The field manual: everything about the client in one place, in tabs so it never reads as a
 * wall — start here, the places (hub by hub, with how each screen works), the keys, the words,
 * and where the data comes from. */
import { h } from '../core/dom';
import { touchWords } from '../core/touch';
import { audio } from '../core/audio';
import { HUBS, LESSONS, trackOf } from '../data/learn';
import { academy } from '../game/academy';
import { glossaryList } from './guide';
import { icon } from './icons';

type Tab = 'start' | 'places' | 'keys' | 'words' | 'about';
const TABS: [Tab, string][] = [['start', 'Start here'], ['places', 'Places'], ['keys', 'Keys'], ['words', 'Words'], ['about', 'About']];

/* How each screen works, in more depth than its hub line. */
const HOW: Record<string, string> = {
  '/galaxy': 'Every world ever discovered on the Structs testnet, oldest at the core. Lit worlds are commanders’ homes; red arcs are fleets away on raids; hot worlds saw recent activity. Drag to orbit, wheel to zoom, click a world. H replays the discovery history. The feed replays recent blocks, then follows the chain live.',
  '/grid': 'Reactors, substations, allocations and infusions from the chain: who powers whom. Substations ring the centre with their connected players around them; reactors hang above in guild colours. Click one for capacity, load, connections and the energy market; hover (or tap) a beam for who feeds whom, and how much.',
  '/combat': 'Every real attack, newest first, replayed shot by shot: hits, blocks, dodges, return fire and kills. ↑/↓ step through the list, R replays, E (or ▶ Fight) plays the whole fight, Auto keeps going back in time, Refight flies it yourself. Hover (or tap) a ship for its owner, slot and health, and any number or call for what it means. The ▶ beside a battle in the galaxy’s live feed opens one.',
  '/sim': 'Your fleet against the computer, using the real game’s combat rules. Select a ship (Tab), pick a weapon (1/2), click a red-ringed target (on a touch screen, tap it once to see what will happen and again to fire). G sets a guard, D moves the Command Ship to another layer, S hides a ship (stealth), Space pauses. Charge goes up one per turn; every action uses it up. Destroy the enemy Command Ship to win. The Gauntlet is five fights in a row; the Daily is one battle a day, the same for everyone.',
  '/codex': 'All 22 struct types with full mechanics. Drag to turn a model; Matchups shows expected damage for every fleet matchup (hover or tap a cell for the breakdown).',
  '/command': 'My Base opens on your home planet’s map, your base and fleet as they stand. Drag to move the map, wheel to zoom, and double-click to frame it again. Click a machine for its orders or an empty tile to build; pick a weapon (1/2) and click a red target, G guards, M moves. Its Base button opens the panels: your stats, charge, slots and fleet, with “What to do next” and the Missions that lead to your first raid. Pin a commander to keep their charge, power and ore at risk in the top bar.',
  '/economy/power': 'Your power supply and use, and what happens if you run short (a “what if” shows which machines would switch off first).',
  '/guild': 'Your team’s members and ranks, requests to join, and who may act for you (permissions).',
  '/comms': 'Your guild’s chat (C opens it anywhere); every planet and fleet has a channel.',
  '/intel': 'Live news, guilds, leaderboards, raids, charts and every commander’s books.',
  '/ops/queue': 'Q opens the moves dock: every transaction and every proof being ground. The full screen reorders, cancels and retries.',
  '/ops/proofs': 'The puzzle solver: how hard your computer works (CPU threads, plus the graphics card through WebGPU) and every puzzle in progress.',
  '/ops/replicants': 'Make robot helpers: more players from your own key, each with a job.',
  '/ops/orders': 'The rules your robot helpers follow, shown as the program they run, plus your commander’s autopilot.',
  '/forge': 'Build any of the game’s 97 messages by hand and see it written as code, with a dry run to test it.',
};

let tabNow: Tab = 'start';

export function toggleManual(navigate: (p: string) => void, tab?: Tab) {
  const open = document.querySelector('.help-back');
  if (open && !tab) { open.remove(); return; }
  open?.remove();
  if (tab) tabNow = tab;
  academy.mark('help');
  const body = h('div', { class: 'panel-body col scroll man-body' });
  const tabs = h('div', { class: 'man-tabs', role: 'tablist' });
  const go = (p: string) => { back.remove(); navigate(p); };
  const paint = () => {
    tabs.replaceChildren(...TABS.map(([t, label]) => h('button', { class: 'man-tab' + (t === tabNow ? ' on' : ''), role: 'tab', 'aria-selected': t === tabNow ? 'true' : 'false', onclick: () => { tabNow = t; audio.play('select'); paint(); } }, label)));
    body.replaceChildren(...page(tabNow, go));
    body.scrollTop = 0;
  };
  const back = h('div', { class: 'modal-back help-back', onclick: (e: Event) => { if (e.target === back) back.remove(); } },
    h('div', { class: 'modal panel player manual' },
      h('div', { class: 'panel-head' }, h('span', { class: 't-label' }, 'Field manual'), h('button', { class: 'btn ghost icon', 'aria-label': 'Close', onclick: () => back.remove() }, '×')),
      tabs, body));
  paint();
  document.body.appendChild(back);
}

const sec = (title: string, ...lines: (string | HTMLElement | null)[]) => h('div', { class: 'help-sec' }, h('div', { class: 't-label c-player' }, title), ...lines.filter(Boolean).map((l) => typeof l === 'string' ? h('div', { class: 't-body' }, l) : l!));
const ext = (href: string, text: string) => h('a', { href, target: '_blank', rel: 'noopener' }, text);

function page(tab: Tab, go: (p: string) => void): HTMLElement[] {
  if (tab === 'start') {
    const step = (n: number, title: string, text: string, label: string, path: string) => h('div', { class: 'man-step' },
      h('span', { class: 'man-n' }, String(n)), h('div', { class: 'col', style: 'gap:3px; min-width:0' }, h('div', { class: 't-label-lg c-player' }, title), h('div', { class: 't-body c-hint' }, text)),
      h('button', { class: 'btn mini', onclick: () => go(path) }, label));
    return [
      h('div', { class: 't-body' }, 'Structs is a space strategy game where robot commanders build bases, mine ore, trade energy and fight over Alpha Matter. Here is a good way in:'),
      step(1, 'Win a practice battle', 'Learn how fleets fight, with nothing to lose.', 'Training ▸', '/sim'),
      step(2, 'Take Academy lessons', 'Strategy, economics and technology, a few minutes each, with XP.', 'Academy ▸', '/academy'),
      step(3, 'Enlist and build your base', 'Make a free commander, claim a planet, build an extractor.', 'My Base ▸', '/command'),
      sec('Lost?', 'The ? button (top right) explains the screen you are on. Every hub menu says what each screen is for. Words with a dotted underline explain themselves when you hover or tap them.'),
      sec('Make it yours', 'Text too small? Settings › Larger text. Curious how it all works underneath? Switch on Expert mode in the More menu (the three dots, top right) to see block numbers, raw events and where every number comes from.'),
      sec('Learn more', h('span', { class: 't-body' }, ext('https://structs.ai/START', 'Start'), ' · ', ext('https://structs.ai/knowledge/mechanics/combat', 'Combat'), ' · ', ext('https://structs.ai/knowledge/mechanics/hashing', 'Proof-of-work'), ' · ', ext('https://structs.ai/knowledge/lore/universe', 'Lore'), ' — on structs.ai')),
    ];
  }
  if (tab === 'places') {
    return HUBS.map((hub) => h('div', { class: 'man-hub', style: `--hub:${hub.color}` },
      h('div', { class: 'man-hub-head' }, h('span', { html: icon(hub.id, 16) }), h('span', { class: 't-label-lg' }, hub.label), h('span', { class: 't-tiny c-hint' }, hub.tagline)),
      ...hub.items.map((it) => h('div', { class: 'man-place' },
        h('div', { class: 'spread' }, h('span', { class: 't-body c-player-hi' }, it.label), it.path ? h('button', { class: 'btn mini ghost', onclick: () => go(it.path!) }, 'Open ▸') : null),
        h('div', { class: 't-tiny c-hint' }, it.desc),
        it.path && HOW[it.path] ? h('div', { class: 't-tiny man-how' }, touchWords(HOW[it.path])) : null))));
  }
  if (tab === 'keys') {
    const rows: [string, string][] = [
      ['?', 'Help for the screen you are on'], ['V', 'Vault: your commander, accounts, sending alpha'], ['Q', 'Moves dock: transactions and proofs at work'], ['C', 'Chat dock'],
      ['⌘K or /', 'Command line: screens, names, ids and verbs'], ['M', 'Sound on or off'], ['P', 'Save a picture of the view'], ['Esc', 'Close a window'],
      ['Wheel / pinch', 'Zoom toward the cursor on the battle, planet and combat boards'], ['Z or double-click', 'Frame the board again'],
      ['1–9', 'Pick an item in an open hub menu, or a tab on tabbed screens'],
    ];
    return [
      h('div', { class: 'man-keys' }, ...rows.flatMap(([k, what]) => [h('span', null, ...k.split(' or ').flatMap((x, i) => i ? [' or ', h('kbd', null, x)] : [h('kbd', null, x)])), h('span', { class: 't-body c-hint' }, what)])),
      sec('Command line', '⌘K (or /) opens it anywhere. Type a screen, a name or an id, or a verb: build extractor · sail 2-7 · home · explore · send 5 to Janet · replicate raider · rally 2-9 · visit Janet · forge attack · targets · academy · expert · lock. Type a game word (charge, alpha) to see what it means.'),
    ];
  }
  if (tab === 'words') {
    const toLesson = (id: string) => go(`/academy/${trackOf(id)?.id || ''}/${id}`);
    const list = h('div', null, glossaryList('', toLesson));
    const input = h('input', { class: 'input', placeholder: 'Find a word: alpha, charge, hash…', 'aria-label': 'Find a word', spellcheck: false }) as HTMLInputElement;
    input.addEventListener('input', () => list.replaceChildren(glossaryList(input.value, toLesson)));
    return [input, list];
  }
  return [
    sec('For parents and teachers', `Structs teaches by playing. Strategy: unit matchups, timing (charge), defence and risk. Economics: supply and demand, scarcity, prices per unit, exchange rates and saving versus spending. Technology: how a blockchain orders moves, proof-of-work puzzles, messages as function calls, and if-then rules for robot helpers. The Academy has ${LESSONS.length} short lessons with quizzes.`,
      'Safety: this is the practice network (testnet), so its tokens are not real money. Commanders use game names. Chat warns before anything that looks like a secret recovery phrase is sent. AI helpers suggest moves for the player to approve (a player can let some kinds go through on their own; moving alpha always asks). Settings › Start the Academy over resets lessons for a new learner on a shared computer.'),
    sec('What is live', 'The galaxy, planets, battles, the energy grid and the market are read live from the Structs testnet. Training battles run on your computer with the same rules.'),
    sec('Your keys', 'Your recovery phrase is sealed in this browser (AES-256-GCM under a device key or your passphrase) and never leaves the tab; transactions are signed here and sent straight to the chain. Never share the phrase.'),
    sec('Data', `Testnet LCD + Tendermint WebSocket, guild APIs called directly (each guild must allow this site), GRASS events over NATS.`),
    sec('Links', h('span', { class: 't-body' }, ext('https://playstructs.com', 'playstructs.com'), ' — official site · ', ext('https://structs.ai', 'structs.ai'), ' — game documentation')),
  ];
}
