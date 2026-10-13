/* Player setup, before the lobby: the lobby is players only, so a new commander builds a droid,
 * names it, picks a guild and launches the signup (which carries the droid, so it's on chain from
 * the first block). Then the arrival bay: the guild's steps tick by while you can practise or read
 * a lesson, and the lift lights up when your commander lands. Side doors stay open the whole way:
 * restore an old commander, a training battle, or just watch the galaxy. */
import { h, portrait, toast } from '../../core/dom';
import { audio } from '../../core/audio';
import { wallet } from '../../wallet/wallet';
import { insecurePage } from '../../wallet/secure';
import { openVault, randomName } from '../../ui/vault';
import { enlist, enlisting, retryEnlist } from '../../game/enlist';
import { loadGuilds, type GuildEntry } from '../../game/onboard';
import { canReach, reachableNow } from '../../guild/transport';
import { store } from '../../chain/store';
import { rollAttrs, type PfpAttrs } from '../../data/droidParts';
import { partRows } from './menus';

export type SetupStep = 'droid' | 'name' | 'guild' | 'arrival' | 'locked';

export interface SetupHooks {
  /** The droid on the lift changed. */
  preview(a: PfpAttrs): void;
  /** The commander landed: up the lift. */
  rise(): void;
  navigate(path: string): void;
}

const DRAFT = 'structs.lobby.draft';
interface Draft { attrs: PfpAttrs; name: string; guildId?: string }
function readDraft(): Draft {
  try { const d = JSON.parse(sessionStorage.getItem(DRAFT) || 'null'); if (d?.attrs) return d; } catch { /* ignore */ }
  return { attrs: rollAttrs(), name: '' };
}
function saveDraft(d: Draft) { try { sessionStorage.setItem(DRAFT, JSON.stringify(d)); } catch { /* ignore */ } }

const STEPS: [SetupStep, string][] = [['droid', 'Droid'], ['name', 'Name'], ['guild', 'Guild'], ['arrival', 'Launch']];

export class Setup {
  readonly el = h('div', { class: 'su' });
  private step: SetupStep = 'droid';
  private draft = readDraft();
  private guilds: GuildEntry[] = [];
  private stop: (() => void)[] = [];
  private announced = false;

  constructor(private hooks: SetupHooks) {}

  get attrs() { return this.draft.attrs; }

  /** Which step fits who you are right now. */
  static stepFor(): SetupStep | null {
    const acct = wallet.active;
    if (acct?.playerId) return wallet.state === 'locked' && !wallet.deviceSealed ? 'locked' : null;
    if (enlisting.current && enlisting.current.status !== 'done') return 'arrival';
    return 'droid';
  }

  start(step: SetupStep) {
    this.step = step;
    this.stop.push(enlisting.onChange(() => { if (this.step === 'arrival') this.paint(); }));
    this.stop.push(wallet.onChange(() => {
      if (this.step === 'locked' && wallet.unlocked) {
        // Open: up the lift if there's a commander, else whatever step fits this account.
        const next = Setup.stepFor();
        if (next === null) this.hooks.rise(); else if (next !== 'locked') this.go(next);
      } else if (this.step === 'arrival') this.paint();
    }));
    this.hooks.preview(this.draft.attrs);
    this.paint();
  }

  dispose() { for (const f of this.stop.splice(0)) f(); this.el.replaceChildren(); }

  private go(step: SetupStep) { this.step = step; audio.play('select', 0.6); this.paint(); }

  private paint() {
    this.el.className = `su su-${this.step}`;
    const rail = h('ol', { class: 'su-rail', 'aria-label': 'Setup steps' }, ...STEPS.map(([k, label], i) => {
      const at = STEPS.findIndex(([s]) => s === this.step);
      const done = this.step !== 'locked' && i < at;
      return h('li', { class: `su-pill${k === this.step ? ' on' : ''}${done ? ' done' : ''}` }, done ? '✓ ' : `${i + 1} `, label);
    }));
    const body = this.step === 'droid' ? this.droid() : this.step === 'name' ? this.name() : this.step === 'guild' ? this.guild() : this.step === 'locked' ? this.locked() : this.arrival();
    this.el.replaceChildren(this.step === 'locked' ? h('span') : rail, ...body);
    requestAnimationFrame(() => this.el.querySelector<HTMLElement>('[data-first]')?.focus({ focusVisible: true } as FocusOptions));
  }

  private side(): HTMLElement {
    return h('div', { class: 'su-side' },
      h('button', { type: 'button', class: 'cw-btn ghost', onclick: () => openVault(), title: 'Already a commander? Bring it back with your recovery phrase' }, 'Restore'),
      h('button', { type: 'button', class: 'cw-btn ghost', onclick: () => this.hooks.navigate('/sim'), title: 'A training battle: no account needed' }, 'Practice'),
      h('button', { type: 'button', class: 'cw-btn ghost', onclick: () => this.hooks.navigate('/galaxy'), title: 'Watch the live galaxy' }, 'Watch'));
  }

  private droid(): Node[] {
    const card = portrait(this.draft.attrs, 'su-pfp');
    const rows = partRows(this.draft.attrs, (a) => {
      this.draft.attrs = a; saveDraft(this.draft);
      this.hooks.preview(a);
      this.paintCard();
    });
    rows.el.querySelector('.pr-step')?.setAttribute('data-first', '');
    return [
      h('div', { class: 'cw su-parts' }, h('span', { class: 'cw-tab' }, 'Parts'), rows.el),
      h('div', { class: 'su-right' },
        h('div', { class: 'cw su-card' }, h('span', { class: 'cw-tab' }, 'Your PFP'), h('div', { class: 'su-card-in' }, card, h('span', { class: 'su-cap' }, 'The same droid on every card'))),
      ),
      h('div', { class: 'su-foot' }, this.side(), h('button', { type: 'button', class: 'cw-btn primary', onclick: () => this.go('name') }, h('span', { class: 'dc-face a' }, 'A'), 'Next: Name')),
    ];
  }

  /** The 2D PFP beside the lift follows every change. */
  private paintCard() {
    const card = this.el.querySelector('.su-card-in .pfp');
    if (card) card.replaceWith(portrait(this.draft.attrs, 'su-pfp'));
  }

  private name(): Node[] {
    const input = h('input', { id: 'su-name', class: 'su-input', maxlength: 20, spellcheck: false, autocomplete: 'off', value: this.draft.name, placeholder: 'commander name', 'data-first': '' }) as HTMLInputElement;
    const err = h('div', { class: 'su-err', role: 'alert' });
    const next = h('button', { type: 'button', class: 'cw-btn primary', onclick: () => submit() }, h('span', { class: 'dc-face a' }, 'A'), 'Next: Guild') as HTMLButtonElement;
    const submit = () => {
      const nm = input.value.trim();
      if (!/^[A-Za-z0-9 _.-]{2,20}$/.test(nm)) { err.textContent = 'Names are 2–20 letters, digits, spaces, _ . -'; audio.play('deny'); return; }
      this.draft.name = nm; saveDraft(this.draft);
      this.go('guild');
    };
    input.addEventListener('input', () => { err.textContent = ''; this.draft.name = input.value; saveDraft(this.draft); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    return [
      h('div', { class: 'cw su-namewin' }, h('span', { class: 'cw-tab' }, 'Name'),
        h('label', { class: 'su-label', for: 'su-name', title: 'Everyone in the galaxy will see it' }, 'A game name, never your real name'),
        h('div', { class: 'su-namerow' }, input, h('button', { type: 'button', class: 'cw-btn', onclick: () => { input.value = randomName(); input.dispatchEvent(new Event('input')); audio.play('tick'); } }, 'Random')),
        err),
      h('div', { class: 'su-foot' }, this.side(), h('div', { class: 'su-go' }, h('button', { type: 'button', class: 'cw-btn', onclick: () => this.go('droid') }, h('span', { class: 'dc-face b' }, 'B'), 'Back'), next)),
    ];
  }

  private guild(): Node[] {
    const list = h('div', { class: 'cw-list su-guilds', role: 'radiogroup', 'aria-label': 'Guild' }, h('div', { class: 'su-wait' }, 'Reading the guilds…'));
    const err = h('div', { class: 'su-err', role: 'alert' });
    const insecure = insecurePage();
    if (insecure) err.textContent = insecure;
    const launch = h('button', { type: 'button', class: 'cw-btn primary', disabled: true, onclick: () => void go() }, h('span', { class: 'dc-face a' }, 'A'), 'Launch') as HTMLButtonElement;
    const paint = () => {
      const usable = this.guilds.filter((g) => g.services?.guild_api && reachableNow(g.id) !== false).sort((a, b) => store.members(b.id) - store.members(a.id));
      if (!usable.length) { list.replaceChildren(h('div', { class: 'su-err' }, this.guilds.length ? 'No guild is taking new players on this site yet. Practice and the Academy work without one.' : 'Reading the guilds…')); return; }
      if (!this.draft.guildId || !usable.some((g) => g.id === this.draft.guildId)) this.draft.guildId = usable[0].id;
      list.replaceChildren(...usable.map((g, i) => h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(g.id === this.draft.guildId), class: `cw-row su-guild${g.id === this.draft.guildId ? ' on' : ''}`,
        title: g.meta?.description || '', ...(i === 0 ? { 'data-first': '' } : {}),
        onclick: () => { this.draft.guildId = g.id; saveDraft(this.draft); audio.play('select'); paint(); },
      }, h('span', { class: 'cw-label' }, g.meta?.name || g.id), g.meta?.tag ? h('span', { class: 'cw-key' }, g.meta.tag) : null, h('span', { class: 'cw-count', title: 'Members' }, String(store.members(g.id))))));
      launch.disabled = !!insecure;
    };
    const go = async () => {
      const g = this.guilds.find((x) => x.id === this.draft.guildId);
      if (!g) return;
      launch.disabled = true;
      try {
        await enlist(this.draft.name, g.id, g.meta?.name || g.id, wallet.activeIndex, this.draft.attrs);
        audio.play('confirm');
        this.go('arrival');
      } catch (e) {
        err.textContent = (e as Error).message;
        launch.disabled = false;
        audio.play('deny');
        if (/unlock/i.test(err.textContent)) openVault();
      }
    };
    void loadGuilds().then(async (gs) => {
      await Promise.all(gs.filter((g) => g.services?.guild_api).map((g) => canReach(g.id)));
      this.guilds = gs;
      if (list.isConnected) paint();
      if (!store.coreLoaded) { const off = store.onCore(() => { off(); if (list.isConnected) paint(); }); }
    }).catch(() => list.replaceChildren(h('div', { class: 'su-err' }, 'Can’t reach the guilds right now. Try again in a minute.')));
    if (this.guilds.length) queueMicrotask(paint);
    return [
      h('div', { class: 'cw su-guildwin' }, h('span', { class: 'cw-tab' }, 'Guild'), list, err),
      h('div', { class: 'su-foot' }, this.side(), h('div', { class: 'su-go' }, h('button', { type: 'button', class: 'cw-btn', onclick: () => this.go('name') }, h('span', { class: 'dc-face b' }, 'B'), 'Back'), launch)),
    ];
  }

  private arrival(): Node[] {
    const e = enlisting.current;
    const landed = !!wallet.active?.playerId;
    const steps = ['Checking the game', 'Asking your guild to let you in', 'Your guild is creating your commander'];
    const seen = e?.steps ?? [];
    const failed = e?.status === 'failed';
    const reached = Math.max(-1, ...steps.map((s, i) => (seen.includes(s) ? i : -1)));
    const items = steps.map((s, i) => {
      const done = landed || i < reached;
      const now = !landed && !failed && i === reached;
      return h('li', { class: `su-step${done ? ' done' : ''}${now ? ' now' : ''}` }, h('span', { class: 'su-dot', 'aria-hidden': 'true' }, done ? '✓' : ''), s);
    });
    items.push(h('li', { class: `su-step${landed ? ' now' : ''}` }, h('span', { class: 'su-dot', 'aria-hidden': 'true' }), 'Up the lift'));
    const rise = h('button', { type: 'button', class: 'cw-btn primary su-rise', disabled: !landed, 'data-first': '', onclick: () => this.hooks.rise() }, h('span', { class: 'dc-face a' }, 'A'), landed ? 'Rise to the Concourse' : 'Ready soon') as HTMLButtonElement;
    if (landed && !this.announced) { this.announced = true; audio.play('confirm'); toast('Your commander is in. The lift is ready.', 'player', 4000); }
    return [
      h('div', { class: 'cw su-arrive' }, h('span', { class: 'cw-tab' }, failed ? 'Stalled' : 'Arriving'),
        h('ol', { class: 'su-steps' }, ...items),
        failed ? h('div', { class: 'su-err' }, e?.error ?? 'The guild did not answer.') : h('div', { class: 'su-cap' }, 'Usually a few blocks. Closing the page is fine: it picks up again.'),
        failed ? h('div', { class: 'su-go' }, h('button', { type: 'button', class: 'cw-btn', onclick: () => this.go('guild') }, 'Another guild'), h('button', { type: 'button', class: 'cw-btn primary', onclick: () => retryEnlist() }, 'Retry')) : null),
      h('div', { class: 'su-right' },
        h('div', { class: 'cw su-wait-win' }, h('span', { class: 'cw-tab' }, 'While you wait'),
          h('div', { class: 'cw-list' },
            h('button', { type: 'button', class: 'cw-row', onclick: () => this.hooks.navigate('/sim') }, h('span', { class: 'cw-label' }, 'Practice battle')),
            h('button', { type: 'button', class: 'cw-row', onclick: () => this.hooks.navigate('/academy') }, h('span', { class: 'cw-label' }, 'A first lesson'))),
          h('div', { class: 'su-cap' }, 'Come back here when the lift is ready.'))),
      h('div', { class: 'su-foot su-foot-mid' }, rise),
    ];
  }

  private locked(): Node[] {
    return [
      h('div', { class: 'cw su-namewin' }, h('span', { class: 'cw-tab' }, 'Vault'),
        h('p', { class: 'su-label' }, 'Your vault is locked. Open it to walk in.'),
        h('button', { type: 'button', class: 'cw-btn primary', 'data-first': '', onclick: () => openVault() }, h('span', { class: 'dc-face a' }, 'A'), 'Open vault')),
      h('div', { class: 'su-foot' }, this.side()),
    ];
  }
}
