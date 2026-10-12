/* The ops dock: a console that slides up over any screen — the transaction queue and the
 * proof-of-work engine, live. The full-page version lives at #/ops; this is the glance. */
import '../styles/deck.css';
import { h, copyText, toast, banner } from '../core/dom';
import { audio } from '../core/audio';
import { txq, type TxJob } from '../wallet/queue';
import { pow, type PowTask } from '../pow/pow';
import { wallet } from '../wallet/wallet';
import { live } from '../chain/live';
import { ago, formatInt } from '../core/util';
import { openVault } from './vault';
import { goTo } from '../core/nav';
import { icon } from './icons';

export function jobRow(j: TxJob, compact = false): HTMLElement {
  const acct = wallet.account(j.account);
  const state: Record<string, string> = { queued: 'Waiting to send', waiting: 'Waiting', signing: 'Signing', pending: 'Sending…', success: 'Done ✓', failed: 'Didn’t work', cancelled: 'Cancelled' };
  const meta = h('div', { class: 'meta t-tiny c-hint' },
    h('span', { class: 'chip ' + (j.status === 'success' ? 'player' : j.status === 'failed' ? 'enemy' : j.status === 'waiting' || j.status === 'queued' ? 'warn' : '') }, state[j.status]),
    j.waitReason && (j.status === 'waiting' || j.status === 'queued') ? h('span', null, j.waitReason) : null,
    !compact && acct && wallet.accounts.length > 1 ? h('span', null, acct.label) : null,
    j.lane === 'action' ? h('span', { class: 'c-warn' }, `⚡${j.chargeCost ?? '?'}`) : null,
    j.source !== 'you' ? h('span', { class: 'c-secondary' }, j.source) : null,
    j.height ? h('span', { class: 'x-only' }, `#${formatInt(j.height)}`) : null,
    h('span', null, ago(Date.now() - j.updatedAt)));
  const acts = h('div', { class: 'acts' });
  // Each control is keyed to its move (data-k), so a repaint puts the cursor back on THIS move's
  // button, never on whichever move now sits in the same place (src/ui/keepFocus.ts).
  const k = (what: string) => `job:${j.id}:${what}`;
  if (j.status === 'queued' || j.status === 'waiting') {
    if (!compact) { acts.append(h('button', { class: 'btn ghost mini', title: 'Earlier', 'aria-label': 'Earlier', 'data-k': k('up'), onclick: () => txq.move(j.id, -1) }, '↑'), h('button', { class: 'btn ghost mini', title: 'Later', 'aria-label': 'Later', 'data-k': k('down'), onclick: () => txq.move(j.id, 1) }, '↓')); }
    acts.append(h('button', { class: 'btn ghost mini', title: 'Cancel', 'aria-label': `Cancel ${j.label}`, 'data-k': k('cancel'), onclick: () => { txq.cancel(j.id); audio.play('deny'); } }, '×'));
  }
  if (j.status === 'failed' || j.status === 'cancelled') acts.append(h('button', { class: 'btn ghost mini', title: 'Try again', 'aria-label': `Try ${j.label} again`, 'data-k': k('retry'), onclick: () => { txq.retry(j.id); audio.play('select'); } }, '↻'));
  return h('div', { class: `job ${j.status}` },
    h('i', { class: 'ic' }),
    h('div', { class: 'col', style: 'gap:3px; min-width:0' },
      h('div', { class: 't-body', style: 'font-size:13px' }, j.label),
      meta,
      j.error && j.status === 'failed' ? h('div', { class: 'err' }, j.error) : null,
      j.hash ? h('div', { class: 'hash x-only', title: 'Copy tx hash', onclick: () => copyText(j.hash!, 'Hash copied') }, j.hash.slice(0, 16) + '…') : null),
    acts);
}

export function taskRow(t: PowTask): HTMLElement {
  const need = pow.required(t);
  const best = t.best?.zeros ?? 0;
  const show = Math.max(need, best, 6);
  const zeros = h('div', { class: 'zeros', title: `best proof ${best} zeros · chain needs ${need} next block` },
    ...Array.from({ length: Math.min(show, 24) }, (_, i) => h('i', { class: (i < best ? 'got' : '') + (i < need ? ' need' : '') })));
  const startIn = need > pow.settings.startAt ? pow.blocksUntil(t, pow.settings.startAt) : 0;
  const meetIn = best >= need ? 0 : best ? pow.blocksUntil(t, best) : null;
  const eta = need > best && need <= pow.settings.startAt + 2 ? pow.etaSeconds(need, t.rate || pow.rate) : 0;
  // In plain words: where the puzzle stands. The card shows the short form (a clock and a time, or
  // a word); the sentence is on hover, and the numbers behind it are expert mode's.
  const held = !!t.holdUntil && live.height < t.holdUntil;
  const plain = t.status === 'done' ? 'Done ✓' : t.status === 'submitting' ? 'Solved! Sending it now.'
    : held ? (pow.settings.autoSubmit ? `Not accepted yet (see below). Trying again in about ${fmtSecs((t.holdUntil! - live.height) * live.blockTime)}.` : 'Not accepted yet (see below). Auto-submit is off, so it waits for you.')
    : best >= need ? (pow.settings.autoSubmit ? 'Solved! It goes out with the next block.' : 'Solved, but auto-submit is off: switch it on in the Proof Engine.')
    : startIn ? `The puzzle gets easy enough to start in about ${fmtSecs(startIn * live.blockTime)}.` : t.status === 'hashing' ? 'Your computer is guessing answers…' : 'Waiting its turn.';
  const clock = (s: number) => h('span', { class: 'dc-num' }, h('span', { html: icon('clock', 13) }), fmtSecs(s));
  const short = t.status === 'done' || t.status === 'submitting' ? null
    : held ? (pow.settings.autoSubmit ? clock((t.holdUntil! - live.height) * live.blockTime) : h('span', { class: 'c-warn' }, 'Auto-submit off'))
    : best >= need ? (pow.settings.autoSubmit ? h('span', { class: 'c-player' }, '✓ Solved') : h('span', { class: 'c-warn' }, 'Auto-submit off'))
    : startIn ? clock(startIn * live.blockTime) : null;
  return h('div', { class: `task ${t.status}${best >= need ? ' ready' : ''}`, title: plain },
    h('div', { class: 'spread' }, h('span', { class: 't-label ' + (t.kind === 'raid' ? 'c-enemy' : 'c-player') }, t.label),
      h('span', { class: 'chip ' + (t.status === 'hashing' ? 'neutral' : t.status === 'submitting' ? 'player' : t.status === 'done' ? 'player' : '') }, t.status === 'idle' ? (need > pow.settings.startAt ? 'waiting' : 'queued') : t.status === 'hashing' ? 'solving' : t.status === 'submitting' ? 'sending' : t.status)),
    zeros,
    short ? h('div', { class: 't-tiny c-hint s-only' }, short) : null,
    h('div', { class: 'row t-tiny c-hint wrap x-only' },
      h('span', null, `need ${need}`), h('span', null, `best ${best}`),
      t.rate ? h('span', { class: 'c-secondary' }, fmtRate(t.rate)) : null,
      pow.gpu.task === t.id ? h('span', { class: 'chip neutral' }, 'GPU') : null,
      t.workers ? h('span', null, `${t.workers} thr`) : null,
      startIn ? h('span', null, `hashing opens in ${startIn} blk (~${fmtSecs(startIn * live.blockTime)})`) : null,
      meetIn ? h('span', null, `best proof valid in ${meetIn} blk`) : null,
      best >= need ? h('span', { class: 'c-player' }, 'proof valid — submitting') : null,
      eta && eta < 1e7 ? h('span', null, `luck ≈ ${fmtSecs(eta)}`) : null),
    t.best ? h('div', { class: 'hash-tape x-only' }, t.best.hash) : null,
    t.error ? h('div', { class: 't-tiny c-enemy' }, t.error) : null);
}

/** Hashes per second, in the unit that reads best. */
export function fmtRate(r: number): string { return r >= 1e9 ? `${(r / 1e9).toFixed(2)} GH/s` : r >= 1e6 ? `${(r / 1e6).toFixed(2)} MH/s` : `${Math.round(r / 1e3)} kH/s`; }

/** Children without the gaps (replaceChildren would print "null"). */
export function kids(...xs: (Node | null | undefined | false)[]): Node[] { return xs.filter((x): x is Node => !!x); }

export function fmtSecs(s: number) {
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${(s / 3600).toFixed(1)}h`;
  return `${Math.round(s / 86400)}d`;
}

let dock: { el: HTMLElement; open: (tab?: 'queue' | 'work') => void; toggle: () => void } | null = null;

export function opsDock() {
  if (dock) return dock;
  let tab: 'queue' | 'work' = 'queue';
  const body = h('div', { class: 'ops-body scroll' });
  const tabs = h('div', { class: 'ops-tabs' });
  const el = h('div', { class: 'ops-dock panel player', role: 'dialog', 'aria-label': 'Moves in progress' },
    h('div', { class: 'panel-head' }, tabs, h('div', { class: 'row' },
      h('button', { class: 'btn ghost mini', title: 'Open Moves in Progress', onclick: () => { goTo('/ops/queue'); close(); } }, 'See all'),
      h('button', { class: 'btn ghost icon', 'aria-label': 'Close', onclick: () => close() }, '×'))),
    body);
  document.body.appendChild(el);
  const paint = () => {
    if (!el.classList.contains('open')) return;
    tabs.replaceChildren(
      h('button', { class: 'btn' + (tab === 'queue' ? ' active' : ''), title: 'Moves in progress', onclick: () => { tab = 'queue'; paint(); } }, h('span', { html: icon('queue', 14) }), `Moves ${txq.active.length || ''}`),
      h('button', { class: 'btn' + (tab === 'work' ? ' active' : ''), title: 'Proof puzzles', onclick: () => { tab = 'work'; paint(); } }, h('span', { html: icon('hash', 14) }), `Puzzles ${pow.active.length || ''}`));
    if (tab === 'queue') {
      const jobs = [...txq.jobs].reverse().slice(0, 40);
      body.replaceChildren(...kids(
        wallet.state !== 'unlocked' && txq.active.length ? h('div', { class: 'vault-alert', title: 'The vault is locked: queued moves wait until you unlock it.' }, h('span', { html: icon('lock', 14) }), h('span', { class: 't-tiny' }, 'Vault locked'), h('button', { class: 'btn mini', onclick: () => openVault() }, 'Unlock')) : null,
        ...(jobs.length ? jobs.map((j) => jobRow(j, true)) : [h('div', { class: 'pane-empty', title: 'Every move you make shows up here first.' }, 'No moves yet')]),
        h('div', { class: 'row' }, h('div', { class: 'grow' }), txq.jobs.some((j) => ['success', 'failed', 'cancelled'].includes(j.status)) ? h('button', { class: 'btn ghost mini', title: 'Clear finished moves', onclick: () => txq.clearDone() }, 'Clear') : null),
      ));
    } else {
      const tasks = [...pow.tasks.values()].sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || pow.required(a) - pow.required(b));
      body.replaceChildren(
        h('div', { class: 'spread t-tiny c-hint' },
          h('span', { class: 'row', style: 'gap:10px', title: `${pow.settings.threads} CPU threads${pow.gpu.available ? ' + GPU' : ''}` },
            h('span', { class: 'dc-num' }, h('span', { html: icon('chip', 14) }), `${pow.settings.threads}${pow.gpu.available ? ' + GPU' : ''}`), h('span', { class: 'dc-num' }, h('span', { html: icon('gauge', 14) }), fmtRate(pow.rate))),
          h('button', { class: 'btn ghost mini', onclick: () => { pow.save({ enabled: !pow.settings.enabled }); paint(); } }, pow.settings.enabled ? 'Pause' : 'Resume')),
        ...(tasks.length ? tasks.slice(0, 20).map(taskRow) : [h('div', { class: 'pane-empty', title: 'Build, mine or raid and your computer starts solving.' }, 'No puzzles')]),
      );
    }
  };
  const close = () => { el.classList.remove('open'); };
  const open = (t?: 'queue' | 'work') => { if (t) tab = t; el.classList.add('open'); paint(); };
  txq.onChange(() => paint());
  let powTimer = 0;
  pow.onChange(() => { if (tab === 'work' && !powTimer) powTimer = window.setTimeout(() => { powTimer = 0; paint(); }, 1000); });
  live.onBlock(() => { if (tab === 'work') paint(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  dock = { el, open, toggle: () => { if (el.classList.contains('open')) close(); else open(); audio.play('select'); } };
  return dock;
}

/** Narrate every landed or failed job once, reading what the chain says happened: the
 * commander should feel each move hit — a kill, a struct standing, ore lifted, a raid won. */
let narrated = false;
export function narrateJobs() {
  if (narrated) return;
  narrated = true;
  txq.onSettled((j) => {
    if (j.status === 'failed') { audio.play('deny'); toast(`${j.label}: ${j.error}`, 'enemy', 5200, { label: 'Queue', run: () => opsDock().open('queue') }); return; }
    if (j.status !== 'success') return;
    const ev = j.events || [];
    const get = (type: string) => ev.filter((e) => e.type === type).map((e) => {
      // A typed event's attribute is its one field (…Detail); some payloads arrive still wrapped.
      const d = (e.data || {}) as Record<string, any>;
      const k = Object.keys(d);
      return (k.length === 1 && /Detail$/.test(k[0]) && typeof d[k[0]] === 'object' ? d[k[0]] : d) as Record<string, any>;
    });
    const attacks = get('EventAttack');
    if (attacks.length) {
      const shots = attacks.flatMap((a) => a.eventAttackShotDetail || []);
      const kills = shots.filter((x: any) => x.targetDestroyed).length;
      const dmg = shots.reduce((n: number, x: any) => n + Number(x.damage || 0), 0);
      const evaded = shots.filter((x: any) => x.evaded || x.evadedByPlanetaryDefenses).length;
      const lost = attacks.some((a) => a.recoilDamageDestroyedAttacker || a.planetaryDefenseCannonDamageDestroyedAttacker) || shots.some((x: any) => x.targetCounterDestroyedAttacker || x.postDestructionDamageDestroyedAttacker);
      audio.play(kills ? 'explosion' : dmg ? 'impact' : 'evade');
      if (kills) banner(kills > 1 ? `${kills} KILLS` : 'TARGET DESTROYED', j.label.toUpperCase(), 'player', 1800);
      toast(`${kills ? `☠ ${kills} destroyed · ` : ''}${dmg} damage${evaded ? ` · ${evaded} evaded` : ''}${lost ? ' · your struct fell' : ''}`, kills ? 'player' : lost ? 'enemy' : 'warn', 6000,
        j.hash ? { label: 'Watch ▸', run: () => { goTo('/combat/' + j.hash); } } : undefined);
      return;
    }
    const raid = get('EventRaid')[0];
    if (raid && (raid.status === 'raidSuccessful' || raid.status === 3)) {
      const seized = get('EventOreTheft').reduce((n, x) => n + Number(x.amount || 0), 0);
      audio.stinger('alpha', 0.9); banner('RAID SUCCESSFUL', `${seized} ORE SEIZED`, 'player', 3200); return;
    }
    const mined = get('EventOreMine')[0];
    if (mined) { audio.play('charge'); toast(`⛏ +${mined.amount} ore mined — refine it before raiders come`, 'player', 4200); return; }
    const refined = get('EventAlphaRefine')[0];
    if (refined) { audio.stinger('alpha', 0.5); toast(`+${(Number(refined.amount) / 1e6).toFixed(2)} alpha refined`, 'player', 4200); return; }
    const hash = get('EventHashSuccess')[0];
    if (hash && hash.category === 'build') { audio.play('shield'); banner('ONLINE', `${j.label.replace(/ · proof.*$/, '').toUpperCase()}`, 'player', 1600); return; }
    audio.play('confirm');
    toast(j.source === 'pow' ? `Proof accepted · ${j.label}` : `✓ ${j.label}`, 'player', 2600);
  });
}
