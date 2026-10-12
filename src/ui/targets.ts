/* The target board as a modal: the galaxy's fattest, softest worlds, one click to sail. */
import { h, toast } from '../core/dom';
import { audio } from '../core/audio';
import { targets, type Target } from '../game/targets';
import { store } from '../chain/store';
import { empire } from '../game/empire';
import { wallet } from '../wallet/wallet';
import { act } from '../game/actions';
import { openVault } from './vault';
import { blocksToDuration } from '../core/util';

export function openTargets(navigate: (hash: string) => void) {
  document.querySelector('.targets-back')?.remove();
  const body = h('div', { class: 'panel-body col scroll tg-body' }, h('div', { class: 't-label c-hint cd-loading' }, 'Scanning every hold in the galaxy…'));
  const back = h('div', { class: 'modal-back targets-back', onclick: (e: Event) => { if (e.target === back) back.remove(); } },
    h('div', { class: 'modal panel enemy tg' },
      h('div', { class: 'panel-head' }, h('span', { class: 't-label' }, 'Targets: planets worth raiding'), h('button', { class: 'btn ghost icon', 'aria-label': 'Close', onclick: () => back.remove() }, '×')),
      body));
  document.body.appendChild(back);
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { back.remove(); window.removeEventListener('keydown', key); } };
  window.addEventListener('keydown', key);
  const me = wallet.active?.playerId ? empire.players.get(wallet.active.playerId) : undefined;
  const row = (t: Target, i: number) => h('div', { class: 'tg-row' },
    h('span', { class: 'tg-rank t-label-lg ' + (i < 3 ? 'c-enemy' : 'c-hint') }, String(i + 1)),
    h('div', { class: 'col grow', style: 'gap:2px; min-width:0' },
      h('div', { class: 'row' }, h('span', { class: 't-label-lg c-enemy' }, t.name), h('span', { class: 'chip' }, store.guildTag(t.guildId))),
      h('div', { class: 'row t-tiny c-hint wrap' },
        h('span', { class: 'c-warn' }, `${t.ore} ore in hold`), h('span', null, `shield ${t.shield}`), h('span', null, `${t.structs} machines`),
        t.idle ? h('span', null, t.idle > 600 ? `away for ${blocksToDuration(t.idle)}` : 'playing now') : null)),
    h('div', { class: 'row' },
      h('button', { class: 'btn ghost mini', title: 'Look at the planet first', onclick: () => { back.remove(); navigate('/planet/' + t.planetId); } }, 'Look'),
      me ? h('button', { class: 'btn danger mini', onclick: () => {
        if (wallet.state !== 'unlocked') { openVault(); return; }
        try { act.fleetMove(me, t.planetId); audio.play('warp'); toast(`Fleet sails for ${t.name}`, 'enemy'); back.remove(); } catch (e) { toast((e as Error).message, 'enemy'); }
      } }, 'Sail') : null));
  targets(true).then((list) => {
    body.replaceChildren(
      h('div', { class: 't-tiny c-hint x-only' }, 'Raids seize every ore in the defender’s hold. Ranked by prize against the work (shield = raid proof range) and the risk (defenders, an owner at the guns). Your guildmates are left out.'),
      h('div', { class: 't-tiny c-hint s-only' }, 'A raid takes all the ore a player is holding. The best targets have lots of ore, a weak shield (an easier raid puzzle) and few defenders. Your own guild is left off the list.'),
      ...(list.length ? list.slice(0, 40).map(row) : [h('div', { class: 'pane-empty' }, 'No ore sitting in anyone’s hold right now.')]));
  }).catch((e) => body.replaceChildren(h('div', { class: 't-tiny c-enemy' }, 'Could not read the galaxy: ' + (e as Error).message)));
}
