/* The sign-in card: what comms is, and the way in — the commander's wallet, on their guild's own
 * chat server. Comms signs in by itself, behind the scenes, as soon as it can (matrix.ts
 * autoSignIn: the guild API turns the wallet-signed login into the session); the card shows that
 * happening, and its one button tries again after a failure. When it can't run
 * yet, a few words say why (enlist, join a guild, unlock, the guild runs no chat server) with the
 * one button that fixes it. An access token from another Matrix client still works, folded behind
 * "Have a token?" (open at once in Expert mode). Dreamcast-style: a picture and a few words each,
 * the explanations on hover, and the safety lines plain and always on screen (its skin is at the
 * end of comms.css, which loads with the dock on every screen). */
import { h, toast } from '../../core/dom';
import { audio } from '../../core/audio';
import { comms, WALLET_BLOCK } from '../../chat/matrix';
import { hostOf } from '../../chat/format';
import { guildInfo, knownGuilds, onGuilds, loadGuilds } from '../../chat/guilds';
import { guildLabel } from '../../guild/directory';
import { store } from '../../chain/store';
import { icon } from '../icons';
import { type Nav } from './rich';
import { tokenProblem } from './tokenGuard';
import { looksLikePhrase } from '../../wallet/keys';
import { wallet } from '../../wallet/wallet';
import { openVault } from '../vault';

export function signInCard(nav: Nav): { el: HTMLElement; destroy(): void } {
  const offs: (() => void)[] = [];
  const errBox = h('div', { class: 'cp-si-err' });
  const servers = h('div', { class: 'cp-si-servers' });

  const hsInput = h('input', { class: 'input', placeholder: 'https://matrix.example.org', spellcheck: false, autocomplete: 'off', 'aria-label': 'Homeserver URL' }) as HTMLInputElement;
  const tokInput = h('input', { class: 'input', type: 'password', placeholder: 'syt_… or mat_…', spellcheck: false, autocomplete: 'off', 'aria-label': 'Access token' }) as HTMLInputElement;
  const tokBtn = h('button', { type: 'submit', class: 'btn solid' }, 'Connect') as HTMLButtonElement;
  const form = h('form', { class: 'col', onsubmit: async (e: Event) => {
    e.preventDefault();
    // First, before anything else: never let a recovery phrase (or anything with spaces) leave as a
    // token, nor a phrase as a server address. Clear it and say why.
    const bad = tokInput.value.trim() ? tokenProblem(tokInput.value) : null;
    if (bad) { tokInput.value = ''; audio.play('deny'); toast(bad, 'enemy', 8000); tokInput.focus(); return; }
    if (looksLikePhrase(hsInput.value)) { hsInput.value = ''; audio.play('deny'); toast('That is a recovery phrase. Never paste it anywhere: the server box takes a web address.', 'enemy', 8000); hsInput.focus(); return; }
    if (!hsInput.value.trim() || !tokInput.value.trim()) { toast('Homeserver and token, both', 'warn'); return; }
    tokBtn.disabled = true;
    try { await comms.signInWithToken(hsInput.value, tokInput.value); audio.play('confirm'); } catch (x) { audio.play('deny'); toast(String((x as Error).message), 'enemy', 5000); } finally { tokBtn.disabled = false; }
  } },
    h('label', { class: 'cp-si-field', title: 'Homeserver: your guild’s chat server. Tap a guild above to fill it in.' }, h('span', { class: 't-label c-hint' }, 'Server'), hsInput),
    h('label', { class: 'cp-si-field', title: 'Already signed in with another Matrix app (Element, or your guild’s website)? Paste its access token. It is kept in this browser only; tokens from this route do not refresh.' },
      h('span', { class: 't-label c-hint' }, 'Access token'), tokInput,
      // What goes in this box, said plainly: a token, never the words that guard your commander.
      h('span', { class: 'cp-si-safe' }, h('span', { html: icon('lock', 14) }), 'A token from another Matrix app, never your recovery phrase.')),
    h('div', { class: 'row' }, tokBtn));

  // The guilds' chat servers as pills, so a player knows which homeserver to use: a tap fills it in.
  const paintServers = () => {
    const list = knownGuilds().filter((g) => g.services?.matrix);
    servers.replaceChildren(...list.map((g) => {
      const url = g.services!.matrix!;
      const name = g.meta?.name || guildLabel(g.id).name;
      return h('button', { type: 'button', class: 'cp-si-server', title: `${name} · ${hostOf(url)}: use this chat server`, onclick: () => { hsInput.value = url; audio.play('select'); tokInput.focus(); } },
        h('span', { class: 'dct-gdot', style: `--gc:#${store.guildColor(g.id).toString(16).padStart(6, '0')}` }), g.meta?.tag || guildLabel(g.id).tag);
    }));
  };
  const paintErr = () => {
    const why = comms.state === 'expired' ? (comms.lastError || 'Your comms session expired') : comms.lastError;
    errBox.style.display = why ? '' : 'none';
    errBox.textContent = why;
  };

  // No commander yet: a lock, five words and Enlist. The token sign-in waits behind a small toggle.
  const hasCommander = () => wallet.accounts.some((a) => !!a.playerId);
  let tokenOpen = document.body.classList.contains('expert');
  const lockCard = h('div', { class: 'cp-si-lock', title: 'Chat needs a commander: enlisting is free and takes a few seconds. Your guild’s channels open once you have joined one.' },
    h('span', { class: 'cp-si-lock-ico', html: icon('lock', 24) }),
    h('span', { class: 'cp-si-lock-words' }, 'Chat opens when you enlist'),
    h('button', { type: 'button', class: 'btn solid', onclick: () => { audio.play('select'); openVault(wallet.state === 'empty' ? undefined : 'join'); } }, 'Enlist'));
  const tokenToggle = h('button', { type: 'button', class: 'btn ghost mini cp-si-more', 'aria-expanded': 'false', title: 'Already chat in another Matrix app? Sign in with its access token.', onclick: () => {
    tokenOpen = !tokenOpen; audio.play('select'); paintMode();
    if (tokenOpen) hsInput.focus();
  } }, h('span', { html: icon('key', 14) }), 'Have a token?') as HTMLButtonElement;
  // The way in: the commander's wallet on their guild's own chat server. One button, or why not yet.
  const goWords = h('span', { class: 'cp-si-go-words' });
  const goSub = h('span', { class: 'cp-si-go-sub' });
  const goBtn = h('button', { type: 'button', class: 'btn solid cp-si-go' }) as HTMLButtonElement;
  const cancelBtn = h('button', { type: 'button', class: 'btn ghost mini', title: 'Stop signing in', onclick: () => { audio.play('select'); comms.cancelSignIn(); } }, 'Cancel') as HTMLButtonElement;
  const goIco = h('span', { class: 'cp-si-go-ico' });
  const walletRow = h('div', { class: 'cp-si-walletrow', title: 'Sign in with your commander: your wallet signs once for your guild, and its chat server opens. No chat password.' },
    goIco, h('span', { class: 'cp-si-go-text' }, goWords, goSub), goBtn, cancelBtn);
  const paintWallet = () => {
    const r = comms.walletRoute();
    const busy = comms.signingIn;
    cancelBtn.hidden = !busy;
    if ('block' in r) {
      goIco.innerHTML = icon(r.block === 'locked' ? 'lock' : 'team', 22);
      goWords.textContent = WALLET_BLOCK[r.block];
      goSub.textContent = '';
      goBtn.hidden = r.block !== 'locked' && r.block !== 'guild';
      goBtn.replaceChildren(r.block === 'locked' ? 'Unlock' : 'Guilds');
      goBtn.onclick = r.block === 'locked' ? () => { audio.play('select'); openVault(); } : () => { audio.play('select'); nav('/guild'); };
      return;
    }
    const g = guildInfo(r.guildId);
    goIco.innerHTML = '';
    goIco.append(h('span', { class: 'dct-gdot', style: `--gc:#${store.guildColor(r.guildId).toString(16).padStart(6, '0')}` }));
    goWords.textContent = busy ? 'Signing in…' : `${g?.meta?.tag || guildLabel(r.guildId).tag} chat`;
    goSub.textContent = hostOf(r.homeserver);
    goBtn.hidden = busy;
    goBtn.replaceChildren(h('span', { class: 'dc-face a' }, 'A'), comms.state === 'expired' ? 'Reconnect' : 'Connect');
    goBtn.onclick = () => { audio.play('select'); void comms.signInWithWallet().then(() => audio.play('confirm'), () => audio.play('deny')); };
  };
  // The token box and its safety line travel together: wherever the box shows, the line does.
  const tokenSection = h('div', { class: 'cp-si-wallet col' },
    h('div', { class: 'cp-si-sub', title: 'Sign in with an access token from another Matrix app (Element, or your guild’s website): pick your guild’s server, paste the token.' }, h('span', { html: icon('key', 18) }), h('span', { class: 't-label' }, 'Token sign-in')),
    servers,
    form);
  const paintMode = () => {
    const cmd = hasCommander();
    lockCard.hidden = cmd;
    walletRow.hidden = !cmd;
    tokenToggle.setAttribute('aria-expanded', tokenOpen ? 'true' : 'false');
    tokenToggle.lastChild!.textContent = tokenOpen ? 'Hide token' : 'Have a token?';
    tokenSection.hidden = !tokenOpen;
    paintWallet();
  };

  const el = h('div', { class: 'cp-signin panel player dct-signin' },
    h('div', { class: 'cp-si-head' },
      h('div', { class: 'cp-si-top', title: 'Chat · not signed in. Talk with your guild, ask questions in #help, and message other commanders.' },
        h('span', { class: 'dct-title-ico', html: icon('chat', 24) }),
        h('div', { class: 'cp-si-title' }, 'Open a channel')),
      h('div', { class: 't-body c-hint x-only' }, 'Guilds run the chat servers (Matrix). Talk in your guild’s channels, the Structs-wide ', h('b', null, '#sn-corp'), ', ', h('b', null, '#help'), ' and ', h('b', null, '#infrastructure'), ', direct-message any commander, and open the channel of any planet or fleet.'),
      // The chat rule, plain and always on screen.
      h('div', { class: 'cp-si-rule' }, h('span', { html: icon('lock', 16) }), 'Be kind. Never share your recovery phrase.')),
    errBox,
    lockCard, walletRow, tokenToggle, tokenSection);

  offs.push(comms.onState(() => { paintErr(); paintWallet(); }));
  offs.push(comms.onChange(() => paintErr()));
  offs.push(store.onCore(() => paintWallet()));
  offs.push(wallet.onChange(() => paintMode()));
  paintMode();
  offs.push(onGuilds(() => { paintServers(); paintWallet(); }) as () => void);
  void loadGuilds().then(paintServers, () => { /* the list is a convenience */ });
  paintServers();
  paintErr();
  return { el, destroy: () => offs.splice(0).forEach((f) => f()) };
}
