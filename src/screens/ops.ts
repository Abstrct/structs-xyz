/* Operations: the machinery behind the deck, full size.
 *   #/ops/queue       every transaction, its fate, reorder / cancel / retry
 *   #/ops/proofs      the proof-of-work engine: threads, thresholds, every task
 *   #/ops/replicants  the foundry: replicate, roles, what each one is doing and why
 *   #/ops/orders      doctrine: standing orders for replicants and the commander's autopilot
 */
import '../styles/ops.css';
import '../styles/dc-lab.css';
import type { Engine } from '../core/engine';
import { h, toast, portrait, confirmBox } from '../core/dom';
import { audio } from '../core/audio';
import { PanelScreen } from './panelScreen';
import { txq, type JobStatus } from '../wallet/queue';
import { pow } from '../pow/pow';
import { wallet } from '../wallet/wallet';
import { empire } from '../game/empire';
import { replicants, LOADOUTS, type Role } from '../game/replicants';
import { act } from '../game/actions';
import { record, RANKS, xpFor } from '../game/record';
import { MISSIONS } from '../game/missions';
import { academy } from '../game/academy';
import { live } from '../chain/live';
import { jobRow, taskRow, kids, fmtRate } from '../ui/opsDock';
import { openVault } from '../ui/vault';
import { formatAlpha } from '../core/util';
import { typeOf } from '../data/catalogue';
import { store } from '../chain/store';
import { LCD_URL } from '../chain/lcd';
import { grass } from '../grass/grass';
import { comms } from '../chat/matrix';
import { guilds as loadDirectory } from '../guild/directory';
import { canReach } from '../guild/transport';
import { replaceRoute } from '../core/nav';
import { icon } from '../ui/icons';
import { HUBS, hubFor } from '../data/learn';
import { keepFocus } from '../ui/keepFocus';

type Tab = 'queue' | 'proofs' | 'replicants' | 'orders' | 'record' | 'health';
/* Named as the hubs name them (Base: moves, rank; Lab: proofs, robots, rules, health): a picture
 * and one word on the tab, the full name and what the page is for one hover away. */
const TABS: [Tab, string, string, string][] = [
  ['queue', 'Moves', 'queue', 'Moves in Progress'], ['proofs', 'Proofs', 'chip', 'Proof Engine'], ['replicants', 'Robots', 'robot', 'Robot Helpers'],
  ['orders', 'Rules', 'rules', 'Robot Rules'], ['record', 'Rank', 'record', 'Rank & Missions'], ['health', 'Health', 'health', 'System Health']];

const OPS_PLAIN: Record<Tab, string> = {
  queue: 'Every move you make is a message your browser signs and sends to the game. Here is each one: waiting, sending, done, or didn’t work (and why).',
  proofs: 'Builds, mining and raids finish when your computer solves a puzzle: it guesses millions of numbers a second until one gives a fingerprint (a hash) that starts with enough zeros. The longer a puzzle waits, the fewer zeros it needs, so it gets easier.',
  replicants: 'Replicants are extra players made from your own key: robot helpers. Give each a job (mine, act as bait, or raid) and they work on their own, by the rules on the Robot Rules page.',
  orders: 'Rules your robots follow by themselves, like “if a helper has more than 2 alpha, send the rest home.” Change a number and you have changed their program.',
  record: 'Your rank, your XP and the missions that lead from your first build to your first raid. Academy lessons earn XP too.',
  health: 'Everything the game connects to, checked live. Green is good; if something is slow, this is where you find out what.',
};

export class OpsScreen extends PanelScreen {
  private tab: Tab = 'queue';
  private body!: HTMLElement;
  private nav!: HTMLElement;
  private wrap!: HTMLElement;
  private tabBtns = new Map<Tab, HTMLElement>();
  private filter: 'all' | 'active' | 'failed' = 'all';
  private timer = 0;
  /** The ? button: the page's explanations (each .dc-hint) show while it is pressed. */
  private why = false;
  /** The job chosen for the next replicant, and the guildmate typed into Crew (kept across repaints). */
  private newRole: Role = 'productive';
  private crewText = '';

  constructor(engine: Engine, navigate: (hash: string) => void) { super(engine, navigate, 'ops', 2.2); }

  protected mount(params: Record<string, string>) {
    this.tab = (TABS.find(([t]) => t === params.tab)?.[0]) || 'queue';
    this.nav = h('div', { class: 'ops-nav dc-tabs', role: 'tablist' });
    this.body = h('div', { class: 'ops-page scroll' + (this.why ? ' dc-why' : '') });
    const whyBtn = h('button', { class: 'btn ghost icon dc-why-btn' + (this.why ? ' active' : ''), 'aria-label': 'Explain this page', 'aria-pressed': this.why ? 'true' : 'false', title: 'Explain this page',
      onclick: () => { this.why = !this.why; audio.play('select'); this.body.classList.toggle('dc-why', this.why); whyBtn.classList.toggle('active', this.why); whyBtn.setAttribute('aria-pressed', this.why ? 'true' : 'false'); } },
    h('span', { html: icon('help', 18) }));
    this.tabs();
    this.wrap = h('div', { class: 'ops-wrap panel player' }, h('div', { class: 'panel-head dc-ops-head' }, this.nav, whyBtn), this.body);
    this.root.append(this.wrap);
    const paint = () => this.schedule();
    // The proof engine chatters; only its own tab follows it, at most once a second.
    let powTimer = 0;
    const powPaint = () => { if (this.tab === 'proofs' && !powTimer) powTimer = window.setTimeout(() => { powTimer = 0; this.paint(); }, 1000); };
    this.cleanup.push(txq.onChange(paint), pow.onChange(powPaint), wallet.onChange(paint), empire.onChange(paint), replicants.onChange(paint), live.onBlock(paint), () => clearTimeout(powTimer));
    this.paint();
  }
  protected unmount() { clearTimeout(this.timer); this.timer = 0; }

  private schedule() { if (!this.timer) this.timer = window.setTimeout(() => { this.timer = 0; this.paint(); }, 150); }

  /** The tabs, made once: a picture and a word each, and on three of them a counter of what is in
   * flight (moves sending, puzzles solving, robot helpers) that keeps itself up to date. */
  private tabs() {
    const badges: Partial<Record<Tab, HTMLElement>> = {};
    this.nav.replaceChildren(...TABS.map(([t, label, ico, full]) => {
      const n = h('span', { class: 'dc-tab-n' });
      if (t === 'queue' || t === 'proofs' || t === 'replicants') badges[t] = n;
      const b = h('button', { class: 'btn dc-tab', role: 'tab', 'aria-label': full, title: `${full}: ${OPS_PLAIN[t]}`,
        onclick: () => { if (this.tab === t) return; this.tab = t; replaceRoute('/ops/' + t); audio.play('select'); this.paint(true); } },
      h('span', { class: 'dc-tab-ico', html: icon(ico, 18) }), h('span', { class: 'dc-tab-word' }, label), n);
      this.tabBtns.set(t, b);
      return b;
    }));
    const count = (el: HTMLElement | undefined, k: number, what: string) => { if (!el) return; el.textContent = k ? String(k) : ''; el.title = `${k} ${what}`; };
    const upd = () => {
      count(badges.queue, txq.active.length, 'move(s) sending');
      count(badges.proofs, pow.active.filter((t) => t.status === 'hashing').length, 'puzzle(s) solving');
      count(badges.replicants, replicants.roster.length, 'robot helper(s)');
    };
    upd();
    this.cleanup.push(txq.onChange(upd), pow.onChange(upd), replicants.onChange(upd));
  }

  /** `force`: the player's own press (a tab, a filter) repaints even while a box keeps focus. */
  private paint(force = false) {
    if (!this.root?.isConnected) return;
    // Keep focus and scroll when repainting a form-heavy tab.
    const a = document.activeElement as HTMLElement | null;
    if (!force && a && this.root.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && (a as HTMLInputElement).type !== 'range') return;
    // Only the tabs of the page's own hub: Base (moves, rank) or Lab (proofs, robots, rules, health),
    // as the hub menus group them, so a player on their rank is never one press from the Lab's tools.
    const hub = hubFor('/ops/' + this.tab);
    let shown = 0;
    for (const [t, b] of this.tabBtns) {
      const mine = hubFor('/ops/' + t) === hub;
      b.style.display = mine ? '' : 'none';
      if (mine) shown++;
      b.classList.toggle('active', t === this.tab); b.setAttribute('aria-selected', t === this.tab ? 'true' : 'false');
    }
    // A short strip keeps its words even on a narrow screen.
    this.nav.classList.toggle('few', shown <= 2);
    // The page wears its hub's colour: Base for moves and rank, Lab for the rest.
    this.wrap.style.setProperty('--hub', HUBS.find((x) => x.id === hubFor('/ops/' + this.tab))?.color || '#7FD88A');
    const top = this.body.scrollTop;
    // The page repaints every block: the cursor (keyboard, pad) stays on the control it was on. A
    // move whose buttons are gone (it is sending now) hands the cursor to the filter, never to
    // another move's buttons.
    keepFocus(this.body, () => {
      if (this.tab === 'queue') this.paintQueue();
      else if (this.tab === 'proofs') this.paintProofs();
      else if (this.tab === 'replicants') this.paintReplicants();
      else if (this.tab === 'orders') this.paintOrders();
      else if (this.tab === 'record') this.paintRecord();
      else this.paintHealth();
      // Each page in a sentence, for someone new: behind the ? button.
      this.body.prepend(h('div', { class: 'ops-plain dc-hint' }, OPS_PLAIN[this.tab]));
    }, () => this.body.querySelector<HTMLElement>('.ops-bar .btn.active'));
    this.body.scrollTop = top;
  }

  private paintQueue() {
    const want: Record<string, JobStatus[]> = { all: [], active: ['queued', 'waiting', 'signing', 'pending'], failed: ['failed'] };
    const jobs = [...txq.jobs].filter((j) => !want[this.filter].length || want[this.filter].includes(j.status));
    const ok = txq.jobs.filter((j) => j.status === 'success').length, bad = txq.jobs.filter((j) => j.status === 'failed').length;
    const FILTER: Record<string, [string, string]> = { all: ['All', 'Every move'], active: ['Sending', 'Moves still on their way'], failed: ['Failed', 'Moves that didn’t work'] };
    this.body.replaceChildren(...kids(
      wallet.state === 'unlocked' && !txq.signerHere ? h('div', { class: 'vault-alert', title: 'One signer per browser, so no move goes out twice. Moves you queue here are handed to it.' },
        h('span', { html: icon('key', 16) }), h('span', { class: 't-tiny' }, 'Another tab is signing')) : null,
      wallet.state !== 'unlocked' ? h('div', { class: 'vault-alert', title: wallet.state === 'empty' ? 'No commander in this browser yet: enlist to sign moves.' : 'The vault is locked: nothing signs until you unlock.' },
        h('span', { html: icon('lock', 16) }), h('span', { class: 't-tiny' }, wallet.state === 'empty' ? 'No commander yet' : 'Vault locked'),
        h('button', { class: 'btn mini', onclick: () => openVault() }, wallet.state === 'empty' ? 'Enlist' : 'Unlock')) : null,
      h('div', { class: 'ops-bar' },
        ...(['all', 'active', 'failed'] as const).map((f) => h('button', { class: 'btn ghost mini' + (this.filter === f ? ' active' : ''), title: FILTER[f][1], onclick: () => { this.filter = f; this.paint(true); } }, FILTER[f][0])),
        h('div', { class: 'grow' }),
        num('check', ok, `${ok} landed`, 'c-player'), num('✕', bad, `${bad} failed`, bad ? 'c-enemy' : ''),
        h('button', { class: 'btn ghost mini', title: txq.paused ? 'Resume signing' : 'Pause signing: queued moves wait', onclick: () => txq.setPaused(!txq.paused) }, txq.paused ? h('span', { html: icon('play', 12) }) : h('span', null, '❚❚'), txq.paused ? 'Resume' : 'Pause'),
        h('button', { class: 'btn ghost mini', title: 'Clear finished moves from the list', onclick: () => txq.clearDone() }, 'Clear')),
      h('div', { class: 'ops-explain t-tiny c-hint x-only' }, 'Up to four transactions per account per block, pipelined by sequence. Struct actions (⚡) wait for their player’s charge and for the previous action to land. Proofs jump the line. A failure the next block can fix retries by itself; the rest stop here with the chain’s reason.'),
      ...(jobs.length ? [...jobs].reverse().map((j) => jobRow(j)) : [empty('queue', txq.jobs.length ? 'Nothing here' : 'No moves yet', txq.jobs.length ? `No ${this.filter === 'failed' ? 'moves that didn’t work' : 'moves sending right now'}.` : 'Build, sail or attack from My Base and each move shows up here.')])));
  }

  private paintProofs() {
    const s = pow.settings;
    const cores = navigator.hardwareConcurrency || 4;
    const threads = h('input', { type: 'range', class: 'range', min: '0', max: String(Math.max(1, cores)), value: String(s.threads), 'aria-label': 'CPU threads' }) as HTMLInputElement;
    threads.addEventListener('change', () => { threads.blur(); pow.save({ threads: Number(threads.value) }); });
    const start = h('input', { type: 'range', class: 'range', min: '4', max: '12', value: String(s.startAt), 'aria-label': 'Start hashing at' }) as HTMLInputElement;
    start.addEventListener('change', () => { start.blur(); pow.save({ startAt: Number(start.value) }); });
    const tasks = [...pow.tasks.values()].sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || pow.required(a) - pow.required(b));
    const gpu = pow.gpu;
    const hashing = pow.active.filter((t) => t.status === 'hashing').length;
    // Idle (nothing to solve yet): one picture and three words. The engine's zeros and switches only
    // mean something once there is work, so until then they are expert mode's (a paused engine still
    // shows its Resume, like auto-submit off).
    const idle = !tasks.length;
    const quiet = idle ? ' x-only' : '';
    const gpuWhat = [gpu.available ? (gpu.adapter || 'WebGPU') : (gpu.error || 'not started'), gpu.task ? 'on ' + (pow.tasks.get(gpu.task)?.label || gpu.task) : '', 'WebGPU SHA-256 engine'].filter(Boolean).join(' · ');
    this.body.replaceChildren(...kids(
      idle ? h('div', { class: 'dc-idle', title: 'Building, mining and raiding give your computer puzzles to solve. It starts on its own.' },
        h('span', { class: 'dc-idle-ico', html: icon('hash', 56) }),
        h('span', { class: 'dc-idle-word' }, 'Starts when you build'),
        h('span', { class: 't-tiny c-hint dc-hint' }, 'Building, mining and raiding give your computer puzzles to solve. It starts on its own.')) : null,
      h('div', { class: 'ops-cards dc-tiles' + quiet },
        tile('gauge', fmtRate(pow.rate), 'Hashrate', `guesses a second · ${hashing} task(s) hashing`),
        tile('hash', (pow.totalHashes / 1e9).toFixed(2) + ' G', 'Hashed', 'billions of guesses this session'),
        tile('chip', gpu.available ? (gpu.rate ? `${(gpu.rate / 1e9).toFixed(2)} GH/s` : 'On') : 'Off', 'GPU', gpuWhat, gpu.available ? 'c-player' : 'c-hint'),
        tile('check', String(txq.jobs.filter((j) => j.source === 'pow' && j.status === 'success').length), 'Landed', 'proofs accepted, from this browser')),
      h('div', { class: 'ops-settings' },
        h('label', { class: 'set-row dc-set' + quiet, title: `CPU threads: ${s.threads} of ${cores}` }, h('span', { class: 'dc-set-ico', html: icon('chip', 20) }), h('span', { class: 'dc-set-k' }, 'CPU'), h('b', { class: 'dc-set-n' }, `${s.threads}/${cores}`), threads),
        h('label', { class: 'set-row dc-set x-only' }, h('span', { class: 't-label c-hint' }, `Start hashing at ${s.startAt} zeros`), start),
        h('div', { class: 'set-row x-only' }, h('span', { class: 't-label c-hint' }, 'Engine'),
          ...(['auto', 'gpu', 'cpu'] as const).map((e) => h('button', { class: 'btn mini ' + (s.engine === e ? 'active' : 'ghost'), onclick: () => { pow.save({ engine: e }); audio.play('select'); } }, e === 'auto' ? 'GPU + CPU' : e === 'gpu' ? 'GPU only' : 'CPU only'))),
        h('div', { class: 'row' },
          h('button', { class: 'btn ' + (s.enabled ? 'danger' : 'solid') + (s.enabled ? quiet : ''), title: s.enabled ? 'Pause all hashing' : 'Resume hashing', onclick: () => pow.save({ enabled: !s.enabled }) },
            s.enabled ? h('span', null, '❚❚') : h('span', { html: icon('play', 14) }), s.enabled ? 'Pause' : 'Resume'),
          // Off is unusual and stops proofs going out: then the switch shows for everyone.
          h('button', { class: 'btn ghost' + (s.autoSubmit ? ' x-only' : ''), title: 'Send each proof the block it becomes valid', onclick: () => pow.save({ autoSubmit: !s.autoSubmit }) }, s.autoSubmit ? 'Auto-submit on' : 'Auto-submit off'))),
      this.signers(),
      this.crew(),
      h('div', { class: 'ops-explain t-tiny c-hint x-only' }, 'A proof is sha256(prefix + nonce) with enough leading hex zeros. The chain’s bar falls as the clock ages — 64 zeros the block it starts, one zero once it is as old as the struct’s difficulty. The engine keeps the best proof it has found and submits it the moment the bar for the next block meets it.'),
      tasks.length ? h('div', { class: 'ops-grid' }, ...tasks.map(taskRow)) : null));
  }

  private paintReplicants() {
    const cmdr = wallet.primary?.playerId ? empire.players.get(wallet.primary.playerId) : undefined;
    const loadout = (r: Role) => LOADOUTS[r].map(([id]) => typeOf(id)?.type).join(', ');
    const JOB: Record<Role, string> = { productive: 'mines and sends you alpha', bait: 'draws raiders away from you', raider: 'builds ships to attack' };
    // The job picked for the next helper lives on the screen: the page repaints every block, and a
    // rebuilt select must not fall back to "productive" before Replicate is pressed.
    const role = h('select', { class: 'input mini-select', 'aria-label': 'Job', 'data-k': 'rep:new:role' }, ...(['productive', 'bait', 'raider'] as Role[]).map((r) => h('option', { value: r, selected: this.newRole === r, title: `${JOB[r]} · builds ${loadout(r)}` }, r))) as HTMLSelectElement;
    role.addEventListener('change', () => { this.newRole = role.value as Role; });
    const go = h('button', { class: 'btn solid big', title: 'Make a new robot helper with this job', 'data-k': 'rep:new:go' }, h('span', { class: 'dc-face a' }, 'A'), 'Replicate') as HTMLButtonElement;
    go.addEventListener('click', async () => {
      if (!wallet.unlocked) { openVault(); return; }
      go.disabled = true; audio.play('warp');
      try { await replicants.replicate(this.newRole); toast('A replicant is born', 'player'); audio.stinger('alpha', 0.5); }
      catch (e) { toast((e as Error).message, 'enemy', 6000); audio.play('deny'); }
      finally { go.disabled = false; }
    });
    const rows = replicants.roster.map((a) => {
      const p = a.playerId ? empire.players.get(a.playerId) : undefined;
      const sel = h('select', { class: 'input mini-select', 'aria-label': 'Job', 'data-k': `rep:${a.index}:role` }, ...(['productive', 'bait', 'raider'] as Role[]).map((r) => h('option', { value: r, selected: a.role === r, title: JOB[r] }, r))) as HTMLSelectElement;
      sel.addEventListener('change', () => replicants.setRole(a.index, sel.value as Role));
      const intent = a.playerId ? replicants.intents.get(a.playerId) : undefined;
      const job = txq.active.find((j) => j.account === a.index);
      const building = p ? [...p.structs.values()].filter((s) => !s.built && !s.destroyed).length : 0;
      return h('div', { class: 'rep' },
        portrait(p?.pfp, 'sm ' + (a.role === 'raider' ? 'enemy' : 'player'), a.address),
        h('div', { class: 'col grow', style: 'gap:3px; min-width:0' },
          h('div', { class: 'row wrap' }, h('span', { class: 't-label-lg c-player' }, p?.name || a.label), a.playerId ? h('a', { class: 'chip', href: '/command/' + a.playerId }, a.playerId) : h('span', { class: 'chip warn' }, 'unborn'), p ? h('span', { class: 'chip ' + (p.online ? 'player' : 'enemy') }, p.online ? 'online' : 'offline') : null),
          h('div', { class: 't-tiny c-hint' }, job ? `▸ ${job.label} (${job.status})` : intent ? `▸ ${intent}` : '▸ waiting'),
          p ? h('div', { class: 'row wrap dc-nums' }, num('alpha', formatAlpha(p.alpha.toString()), 'Alpha', 'c-player'), num('ore', p.ore, 'Ore in the hold', p.ore ? 'c-enemy' : ''), num('charge', empire.charge(p), 'Charge'),
            num('build', p.structs.size, `${p.structs.size} structs${building ? ` · ${building} building` : ''}`)) : null),
        h('div', { class: 'col', style: 'gap:4px; align-items:flex-end' }, sel,
          h('button', { class: 'btn ghost mini', title: 'Remove it from this vault (its player stays on chain)', 'data-k': `rep:${a.index}:forget`, onclick: async () => { if (await confirmBox('Forget replicant', `Remove ${a.label} from this vault? Its player stays on chain and can be re-derived from your phrase at HD index ${a.index}.`, 'Forget')) wallet.removeAccount(a.index); } }, 'Forget')));
    });
    this.body.replaceChildren(...kids(
      h('div', { class: 'foundry panel' },
        h('span', { class: 'dc-foundry-ico', html: icon('robot', 52) }),
        h('div', { class: 'col grow', style: 'gap:6px' },
          h('div', { class: 't-display c-player' }, 'Foundry'),
          h('div', { class: 't-tiny c-hint x-only' }, `Each replicant is another player derived from your recovery phrase, born into ${cmdr ? 'your guild' : 'a guild'} and run by standing orders: build its loadout, power it, mine, refine, sweep alpha home. Its proofs are ground by this browser alongside yours. Guild power limits how many can run: every player draws from the substation.`),
          h('div', { class: 't-tiny c-hint dc-hint' }, 'A replicant is an extra player made from your own key: a robot helper. Pick a job and press Replicate. Productive helpers mine and send you alpha, bait draws raiders away from you, and raiders build ships to attack. They follow the program on Robot Rules.'),
          h('div', { class: 'row wrap t-tiny' }, ...(Object.keys(LOADOUTS) as Role[]).map((r) => h('span', { class: 'chip ' + (r === 'raider' ? 'enemy' : r === 'bait' ? 'warn' : 'player'), title: `${r}: ${JOB[r]} · builds ${loadout(r)}` }, r, h('span', { class: 'x-only' }, `: ${loadout(r)}`))))),
        h('div', { class: 'col', style: 'gap:6px; align-items:stretch' }, role, go)),
      replicants.roster.length ? h('div', { class: 'ops-bar' },
        h('span', { class: 'dc-set-ico', title: 'Orders to every robot at once', html: icon('robot', 18) }),
        h('button', { class: 'btn mini', title: 'Sweep all alpha home', onclick: () => this.mass('sweep') }, h('span', { html: icon('alpha', 14) }), 'Sweep'),
        h('button', { class: 'btn mini', title: 'Recall all fleets', onclick: () => this.mass('home') }, h('span', { html: icon('ship', 14) }), 'Recall'),
        h('button', { class: 'btn mini ghost', title: 'Power up everything', onclick: () => this.mass('power') }, h('span', { html: icon('power', 14) }), 'Power')) : null,
      ...replicants.births.filter((b) => !b.done || Date.now() - b.startedAt < 120_000).map((b) => h('div', { class: 'birth ' + (b.error ? 'bad' : b.done ? 'ok' : '') },
        h('div', { class: 't-label-lg' }, `${b.name} · ${b.role}`), ...b.steps.map((s) => h('div', { class: 't-tiny c-player-hi' }, '▸ ' + s)), b.error ? h('div', { class: 't-tiny c-enemy' }, b.error) : null)),
      ...(rows.length ? rows : [cmdr ? empty('robot', 'No robots yet', 'Pick a job above and press Replicate.') : empty('lock', 'Enlist first', 'Robot helpers are made from your commander.')])));
  }

  private paintRecord() {
    const r = record.r, rank = record.rank;
    const p = wallet.primary?.playerId ? empire.players.get(wallet.primary.playerId) ?? null : null;
    const moves = Object.entries(r.counts).sort((a, b) => b[1] - a[1]);
    const next = rank + 1 < RANKS.length ? RANKS[rank + 1] : null;
    const toNext = next ? xpFor(rank + 1) - r.xp : 0;
    const done = MISSIONS.filter((m) => m.done(p)).length;
    const next1 = MISSIONS.find((m) => !m.done(p)) ?? null;
    this.body.replaceChildren(...kids(
      h('div', { class: 'foundry panel dc-rank' },
        h('span', { class: 'dc-foundry-ico c-neutral', html: icon('record', 52) }),
        h('div', { class: 'col grow', style: 'gap:6px' },
          h('div', { class: 'spread' }, h('span', { class: 't-display c-neutral' }, RANKS[rank]), num('star', r.xp, `${r.xp} XP`, 'dc-big c-neutral')),
          h('div', { class: 'bar warn', title: next ? `${toNext} XP to ${next}` : 'The highest rank there is' }, h('i', { style: `width:${record.progress * 100}%` })),
          // Every rank as a pip: the ones behind you lit, yours ringed. Names on hover.
          h('div', { class: 'spread' },
            h('div', { class: 'lab-pips', role: 'img', 'aria-label': `Rank ${rank + 1} of ${RANKS.length}` }, ...RANKS.map((n, i) => h('i', { class: i < rank ? 'on' : i === rank ? 'here' : '', title: n }))),
            next ? h('span', { class: 'dc-num c-hint', title: `${toNext} XP to go to ${next}` }, h('span', { html: icon('star', 12) }), `${toNext} to go ▸ `, next) : h('span', { class: 'dc-num c-neutral' }, '★')),
          h('div', { class: 't-tiny c-hint dc-hint' }, 'XP comes from moves that land, missions, and Academy lessons.'),
          h('div', { class: 'row wrap' },
            h('a', { class: 'btn ghost mini', href: '/academy', title: `Academy: ${academy.doneCount}/${academy.total} lessons` }, h('span', { html: icon('academy', 14) }), `${academy.doneCount}/${academy.total}`),
            ...academy.badges.map((t) => h('span', { class: 'dc-badge', title: `${t.badge} badge`, html: icon('star', 18) }))))),
      h('div', { class: 'ops-cards dc-tiles' },
        tile('target', String(r.kills), 'Kills', 'enemy ships and buildings destroyed'), tile('battle', String(r.damage), 'Damage', 'damage dealt'),
        tile('flag', String(r.raids), 'Raids', 'raids won: ore taken from rivals'), tile('ore', String(r.ore), 'Ore', 'ore mined: dug from the ground'),
        tile('alpha', (r.alpha / 1e6).toFixed(2), 'Alpha', 'alpha refined into your wallet'), tile('queue', String(moves.reduce((n, [, c]) => n + c, 0)), 'Moves', 'moves done from this browser')),
      h('div', { class: 'dc-sec' }, h('span', { html: icon('flag', 16) }), h('span', { class: 't-label c-hint' }, 'Missions'), h('span', { class: 'dc-num c-hint' }, `${done}/${MISSIONS.length}`)),
      // The mission ladder as numbered tiles (names on hover, or listed under the ? button); the next
      // one is named, and opens the career in the Academy.
      next1 ? h('a', { class: 'task dc-mission', href: '/academy/career', title: `Next mission: ${next1.title}. ${next1.brief}` },
        h('div', { class: 'spread' },
          h('span', { class: 'row', style: 'gap:8px; min-width:0' }, h('span', { class: 'dc-n' }, String(MISSIONS.indexOf(next1) + 1)), h('span', { class: 't-label' }, next1.title)),
          num('star', `+${next1.xp}`, `${next1.xp} XP`, 'c-neutral')),
        h('div', { class: 't-tiny c-hint dc-hint' }, next1.brief)) : null,
      h('div', { class: 'ac-tiles dc-mtiles' }, ...MISSIONS.map((m, i) => {
        const ok = m.done(p);
        return h('span', { class: 'ac-tile' + (ok ? ' done' : '') + (m === next1 ? ' on' : ''), title: `${i + 1}. ${m.title} · +${m.xp} XP${ok ? ' ✓' : ''}\n${m.brief}` },
          h('span', { class: 'ac-tile-n' }, ...(ok ? [h('span', { html: icon('check', 20) })] : [String(i + 1)])), h('span', { class: 'ac-tile-t dc-hint' }, m.title));
      })),
      h('div', { class: 't-label c-hint x-only' }, 'Every move'),
      h('div', { class: 'row wrap x-only' }, ...(moves.length ? moves.map(([n, c]) => h('span', { class: 'chip' }, `${n.replace(/([a-z])([A-Z])/g, '$1 $2')} ×${c}`)) : [h('span', { class: 't-tiny c-hint' }, 'Nothing landed yet.')]))));
  }

  /** Every link the client depends on, measured, and what the queue has been through. */
  private probes: Record<string, { ms: number | null; ok: boolean; at: number }> = {};
  private probing = false;
  private guildReach: { open: number; total: number } | null = null;
  private async probe() {
    if (this.probing) return;
    this.probing = true;
    const time = async (name: string, f: () => Promise<unknown>) => {
      const t0 = performance.now();
      try { await f(); this.probes[name] = { ms: Math.round(performance.now() - t0), ok: true, at: Date.now() }; }
      catch { this.probes[name] = { ms: null, ok: false, at: Date.now() }; }
    };
    await Promise.all([
      time('LCD', () => fetch(LCD_URL + '/cosmos/base/tendermint/v1beta1/blocks/latest').then((r) => { if (!r.ok) throw new Error(); })),
      // Which guilds' APIs answer this site directly (each must allow it with CORS).
      loadDirectory().then(async (gs) => {
        const withApi = gs.filter((g) => g.services?.guild_api);
        const open = (await Promise.all(withApi.map((g) => canReach(g.id)))).filter(Boolean).length;
        this.guildReach = { open, total: withApi.length };
      }).catch(() => { this.guildReach = null; }),
    ]);
    this.probing = false;
    if (this.tab === 'health') this.schedule();
  }

  private paintHealth() {
    if (!Object.keys(this.probes).length || Date.now() - Math.max(...Object.values(this.probes).map((p) => p.at)) > 30_000) void this.probe();
    const hour = txq.jobs.filter((j) => Date.now() - j.updatedAt < 3600_000);
    const ok = hour.filter((j) => j.status === 'success').length, bad = hour.filter((j) => j.status === 'failed');
    const errs = new Map<string, number>();
    for (const j of bad) { const k = (j.error || '?').replace(/\d+/g, 'N').slice(0, 90); errs.set(k, (errs.get(k) || 0) + 1); }
    const sinceBlock = live.lastBlockAt ? Math.round((Date.now() - live.lastBlockAt) / 1000) : null;
    // Each link by a plain word and a picture, the real name beside it in expert mode (this is the Lab:
    // learning the real names is the point), and the detail on hover.
    const PLAIN: Record<string, [string, string, string]> = { 'Chain link': ['Chain', 'explore', 'Game connection'], LCD: ['Data', 'chip', 'Game data'], GRASS: ['News', 'news', 'Live news'], Guilds: ['Guilds', 'flag', 'Guild servers'],
      Comms: ['Chat', 'chat', 'Chat'], Vault: ['Key', 'key', 'Your key'], 'Signing (1 h)': ['Moves', 'send', 'Moves sent (1 h)'], 'Proof engine': ['Solver', 'hash', 'Puzzle solver'] };
    const health = (label: string, value: string, tone: 'ok' | 'warn' | 'bad', sub: string) => {
      const [word, ico, plain] = PLAIN[label];
      return h('div', { class: 'ops-card dc-tile', title: `${plain} (${label}): ${sub}` },
        h('span', { class: 'dc-tile-ico', html: icon(ico, 26) }),
        h('span', { class: 'cd-big ' + (tone === 'ok' ? 'c-player' : tone === 'warn' ? 'c-warn' : 'c-enemy') }, value),
        h('span', { class: 'dc-tile-k' }, word, h('span', { class: 'ops-real x-only' }, ' · ' + label)),
        h('span', { class: 't-tiny c-hint x-only' }, sub));
    };
    const pr = (k: string) => this.probes[k];
    this.body.replaceChildren(
      h('div', { class: 'ops-cards dc-tiles four' },
        health('Chain link', live.state === 'live' ? 'Live' : live.state === 'connecting' ? 'Linking' : 'Down', live.state === 'live' ? (sinceBlock != null && sinceBlock > 20 ? 'warn' : 'ok') : 'bad', sinceBlock != null ? `last block ${sinceBlock}s ago · #${live.height.toLocaleString('en-US')} · ${live.blockTime.toFixed(1)} s/block` : 'no block yet'),
        health('LCD', pr('LCD')?.ok ? `${pr('LCD')!.ms} ms` : pr('LCD') ? 'Down' : '…', pr('LCD')?.ok ? (pr('LCD')!.ms! > 1500 ? 'warn' : 'ok') : 'bad', LCD_URL.replace(/^https?:\/\//, '')),
        health('GRASS', grass.state.charAt(0).toUpperCase() + grass.state.slice(1), grass.state === 'live' ? 'ok' : grass.state === 'down' ? 'bad' : 'warn', `${store.guildName(grass.guildId || '')} · ${grass.received} msgs`),
        health('Guilds', this.guildReach ? `${this.guildReach.open}/${this.guildReach.total}` : '…', !this.guildReach ? 'warn' : this.guildReach.open ? 'ok' : 'warn', this.guildReach ? 'guild APIs that let this site connect (enlisting, guild info)' : 'checking each guild…'),
        health('Comms', ({ idle: 'Idle', connecting: 'Linking', live: 'Live', stalled: 'Stalled', expired: 'Expired', signedOut: 'Signed out' } as Record<string, string>)[comms.state] || comms.state, comms.state === 'live' ? 'ok' : comms.state === 'stalled' || comms.state === 'expired' ? 'bad' : 'warn', 'Matrix sync'),
        health('Vault', ({ empty: 'None', locked: 'Locked', unlocked: 'Open' } as Record<string, string>)[wallet.state], wallet.state === 'unlocked' ? 'ok' : 'warn', `${wallet.accounts.length} account(s) · auto-lock ${wallet.autoLockMinutes || 'off'}`),
        health('Signing (1 h)', hour.length ? `${Math.round((ok / Math.max(1, ok + bad.length)) * 100)}%` : '—', bad.length > ok ? 'bad' : bad.length ? 'warn' : 'ok', `${ok} landed · ${bad.length} failed · ${txq.active.length} in flight`),
        health('Proof engine', fmtRate(pow.rate), pow.settings.enabled ? 'ok' : 'warn', `${pow.settings.threads} CPU${pow.gpu.available ? ' + GPU ' + (pow.gpu.adapter || '') : ''} · ${pow.active.length} owed`)),
      h('div', { class: 'dc-sec', title: 'The commonest errors of the last hour' }, h('span', { html: icon('health', 16) }), h('span', { class: 't-label c-hint' }, 'Errors'), h('span', { class: 'dc-num c-hint' }, '1 h')),
      ...(errs.size ? [...errs].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([e, n]) => h('div', { class: 'job failed' }, h('i', { class: 'ic' }), h('div', { class: 't-tiny' }, e), h('span', { class: 'chip enemy' }, `×${n}`)))
        : [h('div', { class: 'dc-num c-player', title: 'Every move this hour landed or is still in flight.' }, h('span', { html: icon('check', 16) }), 'None')]),
      h('div', { class: 'row' },
        h('button', { class: 'btn ghost mini', title: 'Re-test links', onclick: () => { this.probes = {}; void this.probe(); } }, h('span', { html: icon('refresh', 14) }), 'Re-test'),
        h('button', { class: 'btn ghost mini', title: 'Reload client', onclick: () => location.reload() }, h('span', { html: icon('replay', 14) }), 'Reload')));
  }

  /** Which key signs each player's proofs: its own, or a linked field key (Guild Hall → Permissions). */
  private signers() {
    const keys = wallet.accounts.filter((a) => a.role === 'key');
    const players = wallet.accounts.filter((a) => a.playerId);
    if (!keys.length || !players.length) return null;
    // An expert's panel, unless a signer is already set: then it stays where it can be changed.
    const set = Object.keys(pow.settings.signers || {}).length > 0;
    const what = 'A field key linked to a player with the Hash permissions can submit that player’s proofs, keeping the main key out of the loop.';
    return h('div', { class: 'panel' + (set ? '' : ' x-only'), title: what, style: 'padding:10px; display:flex; flex-direction:column; gap:6px' },
      h('div', { class: 'dc-sec' }, h('span', { html: icon('key', 16) }), h('span', { class: 't-label-lg' }, 'Signers')),
      h('div', { class: 't-tiny c-hint dc-hint' }, what),
      ...players.map((a) => {
        const sel = h('select', { class: 'input mini-select' }, h('option', { value: '' }, `${a.label} (own key)`), ...keys.map((k) => h('option', { value: String(k.index), selected: pow.settings.signers?.[a.playerId!] === k.index }, k.label))) as HTMLSelectElement;
        sel.addEventListener('change', () => { sel.blur(); pow.setSigner(a.playerId!, sel.value ? Number(sel.value) : null); audio.play('select'); });
        return h('div', { class: 'set-row' }, h('span', { class: 't-label c-hint', style: 'width:auto' }, a.label), h('div', { class: 'grow' }), sel);
      }));
  }

  /** Crew: grind proofs for guildmates who granted us the Hash permissions on their player. */
  private crew() {
    const me = wallet.active;
    // What was typed lives on the screen, so a repaint (every block) doesn't wipe it.
    const who = h('input', { class: 'input mini-select', placeholder: 'guildmate id or name', 'aria-label': 'Guildmate id or name', 'data-k': 'crew:who', value: this.crewText }) as HTMLInputElement;
    who.addEventListener('input', () => { this.crewText = who.value; });
    const add = async () => {
      const v = who.value.trim();
      const pid = /^1-\d+$/.test(v) ? v : [...store.players.values()].find((p) => p.name?.toLowerCase() === v.toLowerCase())?.id;
      if (!pid || !me?.playerId) { toast(me?.playerId ? 'No such commander' : 'Your commander needs a player first', 'warn'); return; }
      // The chain checks the signer's permission on the owner: read it so a refusal is explained up front.
      const bits = await fetch(`${LCD_URL}/structs/permission/${encodeURIComponent(pid + '@' + me.playerId)}`).then((r) => r.json()).then((j) => Number(j?.permissionRecord?.value || 0)).catch(() => 0);
      const hash = bits & (0xf << 20);
      if (!hash) toast(`${store.playerName(pid)} hasn’t granted you the Hash permissions yet (Guild Hall → Permissions on their side). Added anyway.`, 'warn', 7000);
      pow.help(pid, wallet.activeIndex);
      audio.play('confirm');
    };
    // An expert's panel, unless this browser already helps someone: then it stays, so it can stop.
    const what = 'Lend your hashers to guildmates. Add a guildmate who granted you Hash permissions on their player: this browser grinds their builds, mining, refining and raid proofs and submits them, signed by you.';
    return h('div', { class: 'panel' + (pow.helping.size ? '' : ' x-only'), title: what, style: 'padding:10px; display:flex; flex-direction:column; gap:6px' },
      h('div', { class: 'dc-sec' }, h('span', { html: icon('team', 16) }), h('span', { class: 't-label-lg' }, 'Crew')),
      h('div', { class: 't-tiny c-hint dc-hint' }, what),
      ...[...pow.helping].map(([pid]) => {
        const owed = [...pow.tasks.values()].filter((t) => t.playerId === pid && t.status !== 'done').length;
        return h('div', { class: 'row' }, h('a', { class: 'lnk grow', href: '/command/' + pid }, `${store.playerName(pid)} (${pid})`),
          num('hash', owed, `${owed} proofs owed`),
          h('button', { class: 'btn ghost mini', 'data-k': `crew:${pid}:stop`, onclick: () => pow.stopHelping(pid) }, 'Stop'));
      }),
      h('div', { class: 'row' }, who, h('button', { class: 'btn mini', onclick: () => void add() }, 'Help')));
  }

  /** One order to every replicant at once (each still one move per block in the queue). */
  private async mass(what: 'sweep' | 'home' | 'power') {
    if (!wallet.unlocked) { openVault(); return; }
    const cmdr = wallet.primary;
    if (what === 'sweep' && !(await confirmBox('Sweep all alpha home', `Send every replicant's alpha to your commander (${cmdr?.address || '?'})?`, 'Sweep', 'player'))) return;
    const players = replicants.roster.map((a) => (a.playerId ? empire.players.get(a.playerId) : undefined)).filter((p): p is NonNullable<typeof p> => !!p);
    let n = 0;
    for (const p of players) {
      try {
        if (what === 'sweep' && cmdr && p.alpha > 100_000n) { act.send(p, cmdr.address, p.alpha, 'armada'); n++; }
        if (what === 'home' && p.fleet?.status === 'away') { act.fleetMove(p, p.planetId, 'armada'); n++; }
        if (what === 'power') for (const st of p.structs.values()) if (st.built && !st.online && !st.destroyed) { act.activate(p, st, 'armada'); n++; }
      } catch (e) { toast((e as Error).message, 'enemy'); }
    }
    audio.play(n ? 'confirm' : 'deny');
    toast(n ? `${n} order(s) queued across the armada` : 'Nothing to do', n ? 'player' : 'warn');
  }

  private paintOrders() {
    const d = replicants.doctrine;
    // Each order: a picture, two words and a switch. What it does is on hover, or under the ? button.
    const toggle = (ico: string, label: string, hint: string, on: boolean, flip: () => void, cls = '') => h('div', { class: 'set-row dc-order ' + cls, title: hint },
      h('span', { class: 'dc-set-ico', html: icon(ico, 20) }),
      h('div', { class: 'col', style: 'gap:2px' }, h('span', { class: 't-label-lg' }, label), h('span', { class: 't-tiny c-hint dc-hint' }, hint)), h('div', { class: 'grow' }),
      h('button', { class: 'btn mini ' + (on ? 'active' : 'ghost'), 'aria-pressed': on ? 'true' : 'false', 'aria-label': label, 'data-k': `order:${label}`,
        // Shown at once: the proof engine's own changes only repaint the Proofs page.
        onclick: () => { flip(); audio.play('select'); this.paint(true); } }, on ? 'On' : 'Off'));
    const sweep = h('input', { class: 'input mini-select', type: 'number', min: '0', step: '0.5', value: String(d.sweepAbove), 'aria-label': 'Send alpha home above' }) as HTMLInputElement;
    sweep.addEventListener('change', () => replicants.set({ sweepAbove: Math.max(0, Number(sweep.value) || 0) }));
    const rally = h('input', { class: 'input mini-select', placeholder: '2-… (empty: home)', value: d.rally, spellcheck: false, 'aria-label': 'Raider meeting point' }) as HTMLInputElement;
    rally.addEventListener('change', () => replicants.set({ rally: /^2-\d+$/.test(rally.value.trim()) ? rally.value.trim() : '' }));
    const field = (ico: string, label: string, hint: string, ...input: (HTMLElement | null)[]) => h('div', { class: 'set-row dc-order', title: hint },
      h('span', { class: 'dc-set-ico', html: icon(ico, 20) }),
      h('div', { class: 'col', style: 'gap:2px' }, h('span', { class: 't-label-lg' }, label), h('span', { class: 't-tiny c-hint dc-hint' }, hint)), h('div', { class: 'grow' }), ...input);
    this.body.replaceChildren(
      h('div', { class: 'ops-orders col' },
        toggle('robot', 'Robot orders', 'Every other block, each robot helper picks its next move by the program below.', d.enabled, () => replicants.set({ enabled: !d.enabled })),
        toggle('base', 'Autopilot', 'Commander autopilot: your commander switches machines on and claims a new planet when the old one is used up. Off: you make every move.', d.commanderAutopilot, () => replicants.set({ commanderAutopilot: !d.commanderAutopilot })),
        toggle('team', 'Delegate newborns', 'New replicants grant your commander full permissions on themselves, so any Structs tool you use can act for them.', d.delegate, () => replicants.set({ delegate: !d.delegate }), 'x-only'),
        toggle('hash', 'Auto-submit', 'Auto-submit proofs: submit each proof the block it becomes valid.', pow.settings.autoSubmit, () => pow.save({ autoSubmit: !pow.settings.autoSubmit }), pow.settings.autoSubmit ? 'x-only' : ''),
        field('alpha', 'Keep', 'Send alpha home above this: helpers with the “productive” job send any alpha above this amount to your commander.', sweep, h('span', { class: 'dc-set-ico c-player', html: icon('alpha', 16) })),
        field('flag', 'Meeting point', 'Raiders sail to this planet and wait there. Leave it empty and they stay home.', rally)),
      robotProgram(d),
      h('div', { class: 'ops-explain t-tiny c-hint dc-hint' }, 'Orders only ever queue one move per player at a time and only while your vault is open. Everything they queue shows in the queue, labelled replicant or autopilot, and can be cancelled there.'));
  }
}

/** The robots' standing orders as the program they really run (src/game/replicants.ts decide()):
 * top to bottom, the first rule that fits is the move. It redraws as the settings above change. */
function robotProgram(d: typeof replicants.doctrine): HTMLElement {
  const k = (t: string) => h('span', { class: 'rc-k' }, t);
  const v = (t: string) => h('span', { class: 'rc-v' }, t);
  const c = (t: string) => h('span', { class: 'rc-c' }, t);
  const names = (role: Role) => LOADOUTS[role].map(([id]) => typeOf(id)?.type || 'struct ' + id).join(', ');
  const line = (indent: number, ...parts: (HTMLElement | string)[]) => h('div', { class: 'rc-line', style: `padding-left:${indent * 2}ch` }, ...parts);
  const keep = String(d.sweepAbove);
  return h('div', { class: 'robot-program' },
    h('div', { class: 'dc-sec', title: 'Your robots’ program: change a setting above and watch it change' }, h('span', { class: 'c-player', html: icon('code', 16) }), h('span', { class: 't-label c-player' }, 'Program')),
    h('div', { class: 'robot-code' },
      // The program's comments are explanations: under the ? button (the OFF note always shows).
      d.enabled ? h('div', { class: 'dc-hint' }, c('// Every other block, each robot helper runs this. The first rule that fits is its move.')) : c('// Robot orders are OFF: helpers wait until you switch them on.'),
      line(0, k('function'), ' nextMove(helper) {'),
      line(1, k('if'), ' (planet is used up)  ', k('return'), ' explore()'),
      line(1, k('if'), ' (a machine is off ', k('and'), ' power allows)  ', k('return'), ' switchOn(machine)'),
      // One build at a time: while something is under construction the build rules are skipped
      // (replicants.ts build() returns null) and the rules below them get their turn.
      h('div', { class: 'dc-hint' }, line(1, c('// free to build: nothing is under construction, and power, the fleet and the Command Ship allow it'))),
      line(1, k('if'), ' (free to build) {'),
      line(2, k('if'), ' (job == ', v('"productive"'), ' ', k('and'), ' a machine is missing)  ', k('return'), ' build(next of: ', v(names('productive')), ')'),
      line(2, k('if'), ' (job == ', v('"bait"'), ' ', k('and'), ' a machine is missing)  ', k('return'), ' build(', v(names('bait')), ')'),
      line(2, k('if'), ' (job == ', v('"raider"'), ' ', k('and'), ' a ship is missing)  ', k('return'), ' build(next of: ', v(names('raider')), ')'),
      line(1, '}'),
      line(1, k('if'), ' (job == ', v('"raider"'), ')  ', k('return'), ' sail(', v(d.rally ? `"${d.rally}"` : '"home"'), ')'),
      line(1, k('if'), ' (job == ', v('"productive"'), ' ', k('and'), ' alpha > ', v(keep), ' + ', v('0.1'), ')  ', k('return'), ' sendHome(alpha − ', v(keep), ')'),
      line(1, k('return'), ' wait()'),
      line(0, '}'),
      h('div', { class: 'dc-hint' }, c(d.commanderAutopilot ? '// Your commander (autopilot ON): explore when the planet is used up, otherwise switch machines on.' : '// Your commander (autopilot OFF): you make every move yourself.'))));
}

/** A stat tile, Dreamcast style: a picture, a big number, one word. What it counts is on hover. */
function tile(ico: string, value: string, label: string, what: string, tone = 'c-player') {
  return h('div', { class: 'ops-card dc-tile', title: `${label}: ${what}` }, h('span', { class: 'dc-tile-ico', html: icon(ico, 26) }), h('span', { class: 'cd-big ' + tone }, value), h('span', { class: 'dc-tile-k' }, label));
}

/** A number with its picture (an icon name, or a glyph like ✕); the title says what it counts. */
function num(ico: string, n: number | string, what: string, cls = '') {
  return h('span', { class: 'dc-num ' + cls, title: what, role: 'img', 'aria-label': what }, /^[a-z]/.test(ico) ? h('span', { html: icon(ico, 14) }) : h('span', null, ico), String(n));
}

/** An empty list: a picture and two words; the sentence behind them is on hover and under the ? button. */
function empty(ico: string, words: string, why: string) {
  return h('div', { class: 'pane-empty dc-empty', title: why }, h('span', { class: 'dc-empty-ico', html: icon(ico, 30) }), h('span', null, words), h('span', { class: 't-tiny c-hint dc-hint' }, why));
}
