/* The Vault: enlist (a name and a guild — the key is made for you), import, unlock, manage
 * accounts, back up the recovery phrase, send alpha. One modal that changes shape with the
 * wallet's state. Every secret stays in this tab. */
import '../styles/deck.css';
import { canReach, reachableNow } from '../guild/transport';
import { h, toast, copyText, confirmBox, portrait } from '../core/dom';
import { audio } from '../core/audio';
import { wallet } from '../wallet/wallet';
import { insecurePage } from '../wallet/secure';
import { isValidMnemonic, normaliseMnemonic, isAddress } from '../wallet/keys';
import { balances } from '../wallet/tx';
import { txq } from '../wallet/queue';
import { formatAlpha } from '../core/util';
import { loadGuilds, type GuildEntry } from '../game/onboard';
import { enlist, enlisting, retryEnlist } from '../game/enlist';
import { store } from '../chain/store';
import { empire } from '../game/empire';
import { goTo } from '../core/nav';
import { icon } from './icons';

let open: HTMLElement | null = null;
let closeOpen: (() => void) | null = null;
/** Close the vault modal, releasing its listeners. */
export function closeVault() { closeOpen?.(); }

export function openVault(view?: 'send' | 'join') {
  if (open) closeOpen?.();
  const body = h('div', { class: 'panel-body col vault-body scroll' });
  const back = h('div', { class: 'modal-back vault-back', onclick: (e: Event) => { if (e.target === back) close(); } },
    h('div', { class: 'modal panel player vault' },
      h('div', { class: 'panel-head' }, h('span', { class: 't-label' }, 'Vault'), h('button', { class: 'btn ghost icon', 'aria-label': 'Close', onclick: () => close() }, '×')),
      body));
  const close = () => { off(); back.remove(); if (open === back) { open = null; closeOpen = null; } };
  closeOpen = close;
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && open === back) close(); };
  window.addEventListener('keydown', key);
  const offW = wallet.onChange(() => { if (!busy) render(); });
  const offE = enlisting.onChange(() => { if (!busy && showingProgress) render(); });
  const off = () => { offW(); offE(); window.removeEventListener('keydown', key); };
  document.body.appendChild(back);
  open = back;
  let busy = false;
  let showingProgress = false;
  const setBusy = (b: boolean) => { busy = b; };

  const render = () => {
    body.replaceChildren();
    showingProgress = false;
    const st = wallet.state;
    if (st === 'empty') return renderEnlist(body, 0, setBusy);
    if (st === 'locked') return renderUnlock(body, setBusy);
    if (view === 'send') { view = undefined; return renderSend(body, () => render()); }
    if (view === 'join') { view = undefined; return renderEnlist(body, wallet.activeIndex, setBusy); }
    const e = enlisting.current;
    if (e && e.status !== 'done' && e.index === wallet.activeIndex && !wallet.active?.playerId) { showingProgress = true; return renderProgress(body, setBusy); }
    if (!wallet.active?.playerId) return renderEnlist(body, wallet.activeIndex, setBusy);
    renderAccounts(body, render, setBusy);
  };
  render();
}

/* ── Import ──────────────────────────────────────────────────────────── */

function renderImport(body: HTMLElement, setBusy: (b: boolean) => void) {
  const ta = h('textarea', { class: 'input phrase-input', rows: 4, placeholder: 'twelve or twenty-four words…', spellcheck: false, autocomplete: 'off' }) as HTMLTextAreaElement;
  const st = h('div', { class: 't-tiny c-hint' }, 'Words are checked locally against the BIP-39 list.');
  const err = h('div', { class: 't-tiny c-enemy' });
  // Not on a page the browser doesn't trust: the box stays shut, so the phrase is never typed here.
  const insecure = insecurePage();
  if (insecure) { err.textContent = insecure; ta.disabled = true; ta.placeholder = 'Not on this page'; }
  ta.addEventListener('input', () => {
    const n = normaliseMnemonic(ta.value).split(' ').filter(Boolean).length;
    const ok = isValidMnemonic(ta.value);
    st.textContent = ok ? `${n} words · valid` : `${n} words${n >= 12 ? ' · checksum does not match' : ''}`;
    st.className = 't-tiny ' + (ok ? 'c-player' : 'c-hint');
  });
  const go = h('button', { class: 'btn solid', disabled: !!insecure }, 'Import') as HTMLButtonElement;
  go.addEventListener('click', async () => {
    if (insecure || !isValidMnemonic(ta.value)) { audio.play('deny'); return; }
    go.disabled = true;
    try {
      await wallet.createInstant(ta.value);
      wallet.markBackedUp();
      audio.play('confirm');
      toast('Commander imported. Welcome back.', 'player');
    } catch (e) { err.textContent = (e as Error).message; go.disabled = false; return; }
    // The modal redraws for the new vault (accounts, or the guild form when it has no player yet).
    openVault();
  });
  body.replaceChildren(
    h('div', { class: 't-label-lg' }, 'Import a recovery phrase'),
    h('div', { class: 't-tiny c-hint' }, 'Bring a commander from the Structs webapp, the desktop client or another browser. The phrase is sealed in this browser and never leaves this tab.'),
    ta, st, err,
    h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => { if (wallet.state === 'empty') renderEnlist(body, 0, setBusy); else closeVault(); } }, 'Back'), h('div', { class: 'grow' }), go),
  );
  if (!insecure) ta.focus();
}

/* ── Locked ──────────────────────────────────────────────────────────── */

function renderUnlock(body: HTMLElement, setBusy: (b: boolean) => void) {
  if (wallet.deviceSealed) {
    body.replaceChildren(
      h('div', { class: 't-label-lg' }, 'Your vault will not open'),
      h('div', { class: 't-tiny c-hint' }, 'This browser lost the device key that seals your commander (site data was cleared, or storage is blocked). Import your recovery phrase to bring it back.'),
      h('div', { class: 'row wrap' }, h('button', { class: 'btn ghost', onclick: () => { void wallet.restore().catch((e) => toast((e as Error).message, 'enemy')); } }, 'Try again'),
        h('button', { class: 'btn danger', onclick: async () => {
          if (await confirmBox('Forget this vault and start over?', 'This removes the sealed vault from this browser. Without your recovery phrase the commander is gone for good.', 'Forget it')) wallet.forget();
        } }, 'Forget and start over'), h('div', { class: 'grow' }),
        h('button', { class: 'btn solid', onclick: () => renderImport(body, setBusy) }, 'Import phrase')));
    return;
  }
  const p = h('input', { class: 'input', type: 'password', placeholder: 'passphrase', autocomplete: 'current-password' }) as HTMLInputElement;
  const err = h('div', { class: 't-tiny c-enemy' });
  const go = h('button', { class: 'btn solid', type: 'submit' }, 'Unlock') as HTMLButtonElement;
  const acct = wallet.primary;
  const pl = acct?.playerId ? store.players.get(acct.playerId) : undefined;
  const form = h('form', { class: 'col', onsubmit: async (e: Event) => {
    e.preventDefault();
    go.disabled = true; go.textContent = 'Unlocking…';
    try { await wallet.unlock(p.value); audio.play('confirm'); } catch (x) { err.textContent = (x as Error).message; audio.play('deny'); go.disabled = false; go.textContent = 'Unlock'; p.select(); }
  } }, p, err, h('div', { class: 'row' },
    h('button', { class: 'btn ghost', type: 'button', onclick: async () => {
      if (await confirmBox('Forget this vault?', 'This removes the sealed phrase from this browser. Without your written recovery phrase the commander is gone for good.', 'Forget it')) wallet.forget();
    } }, 'Forget vault'), h('div', { class: 'grow' }), go));
  body.replaceChildren(
    h('div', { class: 'row vault-who' }, portrait(pl?.pfpClientRenderAttributes, 'sm player', acct?.address || ''),
      h('div', { class: 'col', style: 'gap:2px' }, h('div', { class: 't-label-lg c-player' }, pl?.name || acct?.label || 'Commander'), h('div', { class: 't-tiny c-hint mono' }, acct?.address || ''))),
    h('div', { class: 't-tiny c-hint' }, `Locked. ${txq.active.length ? txq.active.length + ' queued transaction(s) wait for you.' : 'Unlock to sign.'}`),
    form,
  );
  p.focus();
}

/* ── Unlocked: accounts ──────────────────────────────────────────────── */

function renderAccounts(body: HTMLElement, rerender: () => void, setBusy: (b: boolean) => void) {
  const list = h('div', { class: 'col acct-list' });
  for (const a of wallet.accounts) {
    const p = a.playerId ? empire.players.get(a.playerId) : undefined;
    const sp = a.playerId ? store.players.get(a.playerId) : undefined;
    const bal = h('span', { class: 'num c-player' }, p ? formatAlpha(p.alpha.toString()) : '…');
    if (!p) void balances(a.address).then((b) => { const x = b.find((c) => c.denom === 'ualpha'); bal.textContent = formatAlpha(x?.amount || '0'); }).catch(() => { bal.textContent = '—'; });
    const active = a.index === wallet.activeIndex;
    list.appendChild(h('div', { class: 'acct' + (active ? ' on' : '') },
      portrait(p?.pfp || sp?.pfpClientRenderAttributes, 'sm ' + (active ? 'player' : ''), a.address),
      h('div', { class: 'col grow', style: 'gap:2px' },
        h('div', { class: 'row' }, h('span', { class: 't-label-lg ' + (active ? 'c-player' : '') }, p?.name || a.label), h('span', { class: 'chip ' + (a.index === 0 ? 'player' : 'neutral') }, a.index === 0 ? 'commander' : a.role === 'key' ? 'key' : (a.role || 'replicant')), a.playerId ? h('span', { class: 'chip' }, a.playerId) : a.role === 'key' ? h('span', { class: 'chip neutral' }, 'field key') : h('span', { class: 'chip warn' }, 'no player')),
        h('button', { class: 'addr mono t-tiny c-hint', title: 'Copy this address (others can send you alpha with it)', onclick: () => copyText(a.address, 'Address copied') }, a.address),
        h('div', { class: 'row t-tiny' }, h('span', { class: 'c-hint' }, 'Alpha'), bal, h('span', { class: 'c-hint x-only' }, `· HD #${a.index}`))),
      h('div', { class: 'col', style: 'gap:4px' },
        active ? h('span', { class: 't-label c-player' }, 'Active') : h('button', { class: 'btn ghost mini', onclick: () => { wallet.setActive(a.index); audio.play('select'); } }, 'Act as'),
        !a.playerId && a.role !== 'key' ? h('button', { class: 'btn mini', onclick: () => { wallet.setActive(a.index); renderEnlist(body, a.index, setBusy); } }, 'Join guild') : null)));
  }
  const lockSel = h('select', { class: 'input mini-select' }, ...[5, 15, 45, 120, 0].map((m) => h('option', { value: String(m), selected: wallet.autoLockMinutes === m }, m ? `${m} min` : 'never'))) as HTMLSelectElement;
  lockSel.addEventListener('change', () => { wallet.autoLockMinutes = Number(lockSel.value); });
  const device = wallet.deviceSealed;
  body.replaceChildren(...[
    wallet.backedUp ? null : h('div', { class: 'vault-alert' }, h('span', { class: 't-label c-warn' }, 'Save your recovery phrase'),
      h('span', { class: 't-tiny' }, device ? 'Your commander lives only in this browser. Its 24 words are the only way to bring it back anywhere else.' : 'This phrase was never confirmed. Reveal it and keep a copy.'),
      h('button', { class: 'btn mini', onclick: () => revealFlow(body, rerender) }, 'Save it')),
    h('div', { class: 'spread' }, h('div', { class: 't-label-lg' }, 'Accounts'), h('div', { class: 'row' },
      h('button', { class: 'btn mini', onclick: () => openVault('send') }, 'Send alpha'),
      h('button', { class: 'btn ghost mini', onclick: () => { goTo('/ops/replicants'); closeVault(); } }, 'Robot helpers'),
      h('button', { class: 'btn ghost mini x-only', title: 'A new key from your phrase, to link as a limited field key (Guild Hall → Permissions)', onclick: () => { const i = wallet.nextIndex(); wallet.addAccount(i, `Field key ${i}`, 'key'); toast(`Key #${i} derived — link it in Guild Hall → Permissions`, 'player', 4000); rerender(); } }, 'New key'))),
    list,
    h('div', { class: 'divider' }),
    h('div', { class: 'spread' }, h('div', { class: 'col', style: 'gap:2px' }, h('span', { class: 't-label' }, 'Recovery phrase'),
      h('span', { class: 't-tiny c-hint' }, device ? 'Sealed in this browser, no passphrase. Anyone using this browser profile can play as you.' : 'Sealed in this browser under your passphrase.')),
      h('button', { class: 'btn mini', onclick: () => revealFlow(body, rerender) }, 'Show phrase')),
    device ? null : h('div', { class: 'spread' }, h('span', { class: 't-label c-hint' }, 'Auto-lock after'), lockSel),
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn ghost mini', onclick: () => changePassFlow(body, rerender) }, device ? 'Protect with a passphrase' : 'Change passphrase'),
      h('div', { class: 'grow' }),
      device ? null : h('button', { class: 'btn danger mini', onclick: () => { wallet.lock(); audio.play('select'); } }, 'Lock now')),
  ].filter((x): x is HTMLDivElement => !!x));
}

function revealFlow(body: HTMLElement, back: () => void) {
  const out = h('div', { class: 'col' });
  const show = (phrase: string) => {
    const addr = wallet.primary?.address || '';
    out.replaceChildren(
      h('div', { class: 'phrase-grid' }, ...phrase.split(' ').map((w, i) => h('div', { class: 'phrase-word' }, h('span', { class: 'n' }, String(i + 1)), h('span', null, w)))),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn mini', onclick: () => copyText(phrase, 'Phrase copied — paste it somewhere safe, then clear your clipboard') }, 'Copy'),
        h('button', { class: 'btn mini', onclick: () => { downloadPhrase(phrase, addr); wallet.markBackedUp(); } }, 'Download .txt'),
        h('div', { class: 'grow' }),
        h('button', { class: 'btn solid mini', onclick: () => { wallet.markBackedUp(); toast('Marked as saved', 'player'); back(); } }, 'I saved it')));
  };
  const head = [h('div', { class: 't-label-lg' }, 'Recovery phrase'),
    h('div', { class: 't-tiny c-warn' }, 'Anyone with these words controls your commander and everything it owns. Make sure nobody can see your screen, and keep the copy offline.'),
    h('div', { class: 't-tiny c-warn' }, 'Never share them: not in chat, not with friends, not with anyone who says they are from Structs. Nobody honest will ever ask for them.')];
  if (wallet.deviceSealed) {
    body.replaceChildren(...head, out, h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: back }, 'Back')));
    void wallet.revealPhrase().then(show).catch((e) => out.replaceChildren(h('div', { class: 't-tiny c-enemy' }, (e as Error).message)));
    return;
  }
  const p = h('input', { class: 'input', type: 'password', placeholder: 'passphrase' }) as HTMLInputElement;
  body.replaceChildren(...head, p, out,
    h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: back }, 'Back'), h('div', { class: 'grow' }), h('button', { class: 'btn solid', onclick: async () => {
      try { show(await wallet.revealPhrase(p.value)); p.remove(); } catch (e) { out.replaceChildren(h('div', { class: 't-tiny c-enemy' }, (e as Error).message)); }
    } }, 'Reveal')));
  p.focus();
}

function downloadPhrase(phrase: string, address: string) {
  const text = `Structs recovery phrase\n\n${phrase}\n\nCommander address: ${address}\nAnyone with these words controls this commander. Keep this file offline.\n`;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = h('a', { href: url, download: `structs-recovery-${address.slice(-6) || 'phrase'}.txt` }) as HTMLAnchorElement;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Saved to your downloads — move it somewhere offline', 'player', 4000);
}

function changePassFlow(body: HTMLElement, back: () => void) {
  const device = wallet.deviceSealed;
  const a = h('input', { class: 'input', type: 'password', placeholder: 'current passphrase' }) as HTMLInputElement;
  const b = h('input', { class: 'input', type: 'password', placeholder: 'new passphrase (8+)', autocomplete: 'new-password' }) as HTMLInputElement;
  const c = h('input', { class: 'input', type: 'password', placeholder: 'again', autocomplete: 'new-password' }) as HTMLInputElement;
  const err = h('div', { class: 't-tiny c-enemy' });
  body.replaceChildren(h('div', { class: 't-label-lg' }, device ? 'Protect with a passphrase' : 'Change passphrase'),
    device ? h('div', { class: 't-tiny c-hint' }, 'The vault will ask for it when you come back and lock itself after a quiet spell. It is not your recovery phrase: forget it and only the phrase brings the commander back.') : a,
    b, c, err,
    h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: back }, 'Back'), h('div', { class: 'grow' }), h('button', { class: 'btn solid', onclick: async () => {
      if (b.value.length < 8) { err.textContent = 'Use at least 8 characters.'; return; }
      if (b.value !== c.value) { err.textContent = 'The passphrases differ.'; return; }
      try { await wallet.changePassphrase(a.value, b.value); toast(device ? 'Vault protected' : 'Passphrase changed', 'player'); back(); } catch (e) { err.textContent = (e as Error).message; }
    } }, device ? 'Protect' : 'Change')));
  (device ? b : a).focus();
}

/* ── Send alpha ──────────────────────────────────────────────────────── */

function renderSend(body: HTMLElement, back: () => void) {
  const from = wallet.active!;
  const to = h('input', { class: 'input', placeholder: 'to whom? player name, id (1-…) or structs1… address', spellcheck: false }) as HTMLInputElement;
  const amt = h('input', { class: 'input', placeholder: 'amount in alpha (e.g. 2.5)', inputmode: 'decimal' }) as HTMLInputElement;
  const who = h('div', { class: 't-tiny c-hint' }, '');
  const err = h('div', { class: 't-tiny c-enemy' });
  let resolved = '';
  const resolve = async () => {
    const q = to.value.trim();
    resolved = '';
    if (isAddress(q)) { resolved = q; const pid = store.byAddress.get(q); who.textContent = pid ? `→ ${store.playerName(pid)} (${pid})` : '→ external address'; return; }
    let pid = /^1-\d+$/.test(q) ? q : '';
    if (!pid && q.length > 1) for (const p of store.players.values()) if (p.name && p.name.toLowerCase() === q.toLowerCase()) { pid = p.id; break; }
    const p = pid ? store.players.get(pid) || (await import('../chain/lcd').then((m) => m.lcd.player(pid)).then((r) => r.Player).catch(() => undefined)) : undefined;
    if (p?.primaryAddress) { resolved = p.primaryAddress; who.textContent = `→ ${p.name || pid} (${pid}) · ${p.primaryAddress.slice(0, 14)}…`; }
    else who.textContent = q ? 'Unknown recipient' : '';
  };
  to.addEventListener('change', () => void resolve());
  to.addEventListener('blur', () => void resolve());
  body.replaceChildren(
    h('div', { class: 't-label-lg' }, 'Send alpha'),
    h('div', { class: 't-tiny c-hint' }, `From ${from.label}`, h('span', { class: 'x-only' }, ` · ${from.address}`)),
    h('div', { class: 't-tiny c-warn' }, 'A send can’t be undone. Only send alpha to players you trust, and check the name before you press Send.'),
    to, who, amt, err,
    h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: back }, 'Back'), h('div', { class: 'grow' }), h('button', { class: 'btn solid', onclick: async () => {
      await resolve();
      const n = Number(amt.value);
      if (!resolved) { err.textContent = 'Pick a recipient.'; return; }
      if (!(n > 0)) { err.textContent = 'Enter an amount.'; return; }
      const ualpha = BigInt(Math.round(n * 1e6)).toString();
      if (!(await confirmBox('Send alpha', `Send ${n} alpha to ${who.textContent?.replace(/^→ /, '') || resolved}? Transfers cannot be undone.`, 'Send', 'player'))) return;
      try {
        txq.enqueue({ typeUrl: '/structs.structs.MsgPlayerSend', value: { from_address: from.address, to_address: resolved, amount: [{ denom: 'ualpha', amount: ualpha }] } }, { account: from.index, label: `Send ${n} alpha`, source: 'you' });
        toast('Transfer queued', 'player');
        back();
      } catch (e) { err.textContent = (e as Error).message; }
    } }, 'Send')),
  );
  to.focus();
}

/* ── Enlist: a name and a guild ─────────────────────────────────────── */

/** The whole of joining: no phrase ceremony. With no vault, one is made (and sealed in this
 * browser) on Enlist; the guild finishes creating the player in the background while you play. */
function renderEnlist(body: HTMLElement, index: number, setBusy: (b: boolean) => void) {
  const acct = wallet.account(index);
  const fresh = !acct;
  const name = h('input', { class: 'input', placeholder: 'commander name', maxlength: 20, spellcheck: false, autocomplete: 'off', value: acct && acct.index !== 0 ? acct.label : '' }) as HTMLInputElement;
  const list = h('div', { class: 'guild-pick col' }, h('div', { class: 't-tiny c-hint' }, 'Reading the guild registry…'));
  const err = h('div', { class: 't-tiny c-enemy' });
  let pick: GuildEntry | null = null;
  const go = h('button', { class: 'btn solid big', disabled: true }, 'Enlist') as HTMLButtonElement;
  // A page the browser doesn't trust can't hold a vault: said before anyone fills the form in.
  const insecure = insecurePage();
  if (insecure) err.textContent = insecure;
  const ready = () => { go.disabled = !!insecure || !pick || name.value.trim().length < 2; };
  name.addEventListener('input', ready);
  // Drawn again once member counts arrive (the roster can load after the registry): the
  // biggest guild leads, and stays picked unless the player chose another.
  let chosen = false;
  // The biggest guild is picked already; the why is in the label's title.
  const pickHint = h('span', { hidden: true });
  const paintGuilds = (gs: GuildEntry[]) => {
    // A guild whose API refuses this site is left out: it would fail only after signing.
    const usable = gs.filter((g) => g.services?.guild_api && reachableNow(g.id) !== false).sort((a, b) => store.members(b.id) - store.members(a.id));
    pickHint.hidden = !usable.length;
    list.replaceChildren(...usable.map((g) => {
      const el = h('button', { class: 'guild-opt' },
        h('div', { class: 'row' }, h('span', { class: 't-label-lg c-player' }, g.meta?.name || g.id), g.meta?.tag ? h('span', { class: 'chip neutral' }, g.meta.tag) : null, h('span', { class: 'chip' }, `${store.members(g.id)} members`), g.services?.matrix ? h('span', { class: 'chip player', title: 'This guild has a chat server' }, 'chat') : null),
        g.meta?.description ? h('div', { class: 't-tiny c-hint clamp2' }, g.meta.description) : null);
      el.addEventListener('click', () => { pick = g; chosen = true; for (const x of list.children) x.classList.remove('on'); el.classList.add('on'); ready(); audio.play('select'); });
      if (pick && pick.id === g.id) el.classList.add('on');
      return el;
    }));
    // One less decision: the biggest guild (most people to help) starts picked; any other is a click away.
    if (usable.length && !chosen) { pick = usable[0]; for (const x of list.children) x.classList.remove('on'); list.firstElementChild?.classList.add('on'); ready(); }
    if (!usable.length) list.replaceChildren(gs.length
      // The page reads guilds directly, and none has opened its door to this site.
      ? h('div', { class: 't-tiny c-enemy' }, 'Enlisting isn’t open on this website yet. Training battles and the Academy work without it.', h('span', { class: 'x-only' }, ' (No guild serves its guild.json and Guild API with CORS for this site yet.)'))
      : h('div', { class: 't-tiny c-enemy' }, 'No guild is taking new players right now. Try again soon.', h('span', { class: 'x-only' }, ' (No guild with an open API answered.)')));
  };
  void loadGuilds().then(async (gs) => {
    await Promise.all(gs.filter((g) => g.services?.guild_api).map((g) => canReach(g.id)));
    paintGuilds(gs);
    if (!store.coreLoaded) { const off = store.onCore(() => { off(); if (list.isConnected) paintGuilds(gs); }); }
  }).catch(() => list.replaceChildren(h('div', { class: 't-tiny c-enemy' }, 'Can’t reach the guilds right now, so you can’t enlist yet. Try again in a minute. Training battles and the Academy work without it.',
    h('span', { class: 'x-only' }, ' (The guild list could not be read from the chain.)'))));
  const submit = async () => {
    if (!pick) return;
    const nm = name.value.trim();
    if (!/^[A-Za-z0-9 _.-]{2,20}$/.test(nm)) { err.textContent = 'Names are 2–20 letters, digits, spaces, _ . -'; audio.play('deny'); return; }
    go.disabled = true; go.textContent = 'Enlisting…'; setBusy(true);
    try {
      await enlist(nm, pick.id, pick.meta?.name || pick.id, index);
      audio.play('confirm');
      setBusy(false);
      closeVault();
      goTo('/command');
    } catch (e) {
      err.textContent = (e as Error).message;
      go.disabled = false; go.textContent = 'Enlist'; setBusy(false);
    }
  };
  go.addEventListener('click', () => void submit());
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !go.disabled) void submit(); });
  body.replaceChildren(...[
    h('div', { class: 'vault-hero' },
      h('div', { class: 't-display c-player' }, fresh ? 'Enlist' : 'Join a guild'),
      h('div', { class: 't-body c-hint x-only' }, 'Pick a name and a guild (a team to play with). You’re in right away: your guild creates your commander in a few seconds, then you claim a planet.')),
    h('label', { class: 'col' }, h('span', { class: 't-label c-hint' }, 'Name'), h('div', { class: 'row' }, name,
      h('button', { type: 'button', class: 'btn ghost', title: 'Pick a random game name', onclick: (e: Event) => { e.preventDefault(); name.value = randomName(); ready(); audio.play('select'); name.focus(); } }, h('span', { html: icon('replay', 16) }), 'Random')),
      // Safety stays on screen, in plain words.
      h('span', { class: 't-tiny c-warn', title: 'Everyone in the galaxy will see it.' }, 'A game name, never your real name.')),
    h('span', { class: 't-label c-hint', title: 'Your guild is your team. The biggest one is picked for you: more people to help. Tap another to choose it instead. You can switch later.' }, 'Team'), pickHint, list, err,
    h('div', { class: 'row' },
      fresh ? h('button', { class: 'btn ghost', title: 'I already have a recovery phrase', onclick: () => renderImport(body, setBusy) }, h('span', { html: icon('lock', 16) }), 'Import')
        : h('button', { class: 'btn ghost', onclick: () => { if (wallet.accounts.some((a) => a.playerId)) openVault(); else closeVault(); } }, 'Later'),
      h('div', { class: 'grow' }), go),
    fresh ? h('div', { class: 't-tiny c-warn', title: 'Your secret key is made and sealed in this browser. Its recovery phrase (24 secret words) is in the vault whenever you want a copy.' }, 'Never share your recovery phrase with anyone.') : null,
  ].filter(Boolean) as Node[]);
  // On a touch screen the keyboard would cover the teams and Enlist at once: the field waits for a tap.
  if (!matchMedia('(hover: none) and (pointer: coarse)').matches) name.focus();
}

/** Enlisting, still waiting on the guild. */
function renderProgress(body: HTMLElement, setBusy: (b: boolean) => void) {
  const e = enlisting.current!;
  body.replaceChildren(...[
    h('div', { class: 't-display c-player' }, e.status === 'failed' ? 'Enlisting stalled' : `Enlisting ${e.name}`),
    h('div', { class: 't-tiny c-hint' }, e.status === 'failed' ? 'The guild did not finish creating your commander.' : `${e.guildName} is creating your commander on chain. Keep exploring; this finishes by itself.`),
    h('div', { class: 'col join-log' }, ...e.steps.map((s) => h('div', { class: 't-tiny c-player-hi join-step' }, '▸ ' + s))),
    e.error ? h('div', { class: 't-tiny c-enemy' }, e.error) : null,
    h('div', { class: 'row' }, h('div', { class: 'grow' }),
      e.status === 'failed' ? h('button', { class: 'btn ghost', onclick: () => renderEnlist(body, e.index, setBusy) }, 'Another guild') : null,
      e.status === 'failed' ? h('button', { class: 'btn solid', onclick: () => retryEnlist() }, 'Retry') : null,
      h('button', { class: 'btn ghost', onclick: () => closeVault() }, 'Keep playing')),
  ].filter(Boolean) as Node[]);
}

/** A game name for a commander who can't think of one (letters and a dash: always valid). */
function randomName(): string {
  const a = ['Nova', 'Quasar', 'Comet', 'Orbit', 'Pulsar', 'Rocket', 'Nebula', 'Photon', 'Zenith', 'Vortex', 'Echo', 'Atlas', 'Cobalt', 'Ion', 'Flux', 'Astro'];
  const b = ['Falcon', 'Fox', 'Otter', 'Lynx', 'Raven', 'Badger', 'Panda', 'Wolf', 'Hawk', 'Gecko', 'Moth', 'Yak', 'Koala', 'Squid', 'Tiger', 'Bison'];
  const r = (xs: string[]) => xs[Math.floor(Math.random() * xs.length)];
  return `${r(a)}-${r(b)}`;
}
