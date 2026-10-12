/* Economy: power, fuel, the energy market, guild banks and transfers as one console.
 *   #/economy/power[/<1-x>]   the acting commander's grid (or anyone's, read-only), substation, allocations, brownout
 *   #/economy/fuel            reactors, infusions, defusions
 *   #/economy/market          providers and agreements, buying and selling power
 *   #/economy/banks           guild tokens: convert, redeem, swap, mint
 *   #/economy/transfers       balances of every account, send, the unit ladder
 * Reads are live and public, so everything shows without a wallet; actions confirm exactly what
 * they will do and go through the transaction queue as the chosen account. */
import '../styles/economy.css';
import '../styles/dc-trade.css';
import type { Engine } from '../core/engine';
import { h, dismissConfirms } from '../core/dom';
import { audio } from '../core/audio';
import { ago } from '../core/util';
import { replaceRoute } from '../core/nav';
import { PanelScreen } from './panelScreen';
import { store } from '../chain/store';
import { wallet } from '../wallet/wallet';
import { empire } from '../game/empire';
import { gridHealth } from '../game/economy';
import { eco } from '../ui/economy/data';
import { alphaNum, alphaText, amount, blank, lockedNote, powerText, type EcoCtx } from '../ui/economy/kit';
import { icon } from '../ui/icons';
import { keepFocus } from '../ui/keepFocus';
import { amountOf } from '../ui/economy/data';
import { mountPower } from '../ui/economy/power';
import { mountFuel } from '../ui/economy/fuel';
import { marketSkeleton, mountMarket } from '../ui/economy/market';
import { mountBanks } from '../ui/economy/banks';
import { mountTransfers } from '../ui/economy/transfers';

type Tab = 'power' | 'fuel' | 'market' | 'banks' | 'transfers';
/* Tabs are icon pills, one word each. `plain` is the tab in one sentence for someone new: it is
 * the tab's hover and the Learn pill's; `lesson` the Academy lesson that teaches it. */
const TABS: { id: Tab; label: string; icon: string; hint: string; plain: string; lesson?: string; mount: (c: EcoCtx) => void }[] = [
  { id: 'power', label: 'Power', icon: 'power', hint: 'Your grid, substation, allocations and brownout risk', plain: 'How much energy you make versus how much you use. Keep use below supply, or you go offline.', lesson: 'power', mount: mountPower },
  { id: 'fuel', label: 'Fuel', icon: 'fuel', hint: 'Reactors and infused alpha', plain: 'Reactors turn alpha into power. Put alpha in (infuse) and get energy back.', lesson: 'grid', mount: mountFuel },
  { id: 'market', label: 'Market', icon: 'market', hint: 'Rent or sell power', plain: 'Buy or sell energy for alpha. Compare the price per kilowatt per day to find a good deal.', lesson: 'market', mount: mountMarket },
  { id: 'banks', label: 'Banks', icon: 'bank', hint: 'Guild tokens and their collateral', plain: 'Each guild token is backed by alpha in its bank. Convert alpha in, redeem tokens out, or swap.', lesson: 'banks', mount: mountBanks },
  { id: 'transfers', label: 'Send', icon: 'send', hint: 'Balances and transfers', plain: 'What you own, and sending alpha to another player.', mount: mountTransfers },
];

export class EconomyScreen extends PanelScreen {
  private tab: Tab = 'power';
  private arg: string | undefined;
  private body!: HTMLElement;
  private scroller!: HTMLElement;
  private nav!: HTMLElement;
  private status!: HTMLElement;
  private actorBox!: HTMLElement;
  private alert!: HTMLElement;
  /** Form drafts per acting account address ('' while read-only). */
  private drafts = new Map<string, Map<string, string>>();
  /** Wallet address this screen acts as (an account with a player); defaults to the active one. */
  private actor = '';
  private timer = 0;
  private deferred = false;
  /** A pointer is pressed inside the body: a repaint now would swap the button under it. */
  private pressing = false;
  private gen = 0;

  constructor(engine: Engine, navigate: (hash: string) => void) { super(engine, navigate, 'economy', 7.7); }

  protected mount(params: Record<string, string>) {
    // A visitor (no commander) starts in the Market, which is open to everyone; Power is one pill away.
    this.tab = TABS.find((t) => t.id === params.tab)?.id || (wallet.accounts.some((a) => a.playerId) ? 'power' : 'market');
    this.arg = params.arg;
    this.nav = h('nav', { class: 'eco-tabs dct-tabs', role: 'tablist' });
    this.status = h('span', { class: 't-tiny c-hint eco-status' });
    this.actorBox = h('div', { class: 'eco-actor' });
    this.alert = h('div', { class: 'eco-alerthost' });
    this.body = h('div', { class: 'eco-body' });
    this.scroller = h('div', { class: 'eco-scroll scroll' }, this.alert, this.body);
    this.root.appendChild(h('div', { class: 'eco-frame dct-frame', style: '--hub:#EBAA49' },
      h('header', { class: 'eco-head' },
        h('div', { class: 'eco-title dct-title', title: 'Economy: power, fuel, the energy market, guild banks and sending alpha' },
          h('span', { class: 'dct-title-ico', html: icon('trade', 26) }), h('span', { class: 'eco-mark' }, 'Trade')),
        this.actorBox,
        h('div', { class: 'row eco-headtools' }, this.status, h('button', { class: 'btn ghost dct-iconbtn', title: 'Refresh: read everything again', 'aria-label': 'Refresh', html: icon('replay', 18), onclick: () => { audio.play('select'); void eco.refresh(); this.paintStatus(); } }))),
      this.nav, this.scroller));

    // A repaint while typing would steal the caret, and one between mousedown and mouseup would
    // swap the button being clicked (blurring a field is what releases the first): hold both,
    // then repaint a beat after the click has had its turn.
    const out = () => { if (this.deferred && !this.pressing) { this.deferred = false; this.schedule(500); } };
    this.root.addEventListener('focusout', () => setTimeout(out, 0));
    this.body.addEventListener('pointerdown', () => { this.pressing = true; });
    const up = () => { if (!this.pressing) return; this.pressing = false; setTimeout(out, 0); };
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    this.cleanup.push(() => window.removeEventListener('pointerup', up, true), () => window.removeEventListener('pointercancel', up, true));
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) return;
      const i = Number(e.key) - 1;
      if (i >= 0 && i < TABS.length) { this.go(TABS[i].id); e.preventDefault(); }
    };
    window.addEventListener('keydown', key);
    const tick = window.setInterval(() => this.paintStatus(), 5000);
    this.cleanup.push(() => window.removeEventListener('keydown', key), () => clearInterval(tick),
      eco.onChange(() => this.schedule()), wallet.onChange(() => this.schedule()), store.onCore(() => this.schedule()),
      empire.onChange(() => this.schedule()));

    void store.loadCore().catch(() => { /* names fall back to ids */ });
    const g = eco.galaxy;
    if (!g || Date.now() - g.loadedAt > 30_000) void eco.loadGalaxy();
    void eco.loadMine();
    this.paint();
  }

  protected unmount() { clearTimeout(this.timer); this.timer = 0; dismissConfirms(); }

  private go(tab: Tab, arg?: string) {
    if (tab === this.tab && arg === this.arg) return;
    this.tab = tab; this.arg = arg;
    replaceRoute('/economy/' + tab + (arg ? '/' + arg : ''));
    dismissConfirms();
    audio.play('select');
    this.scroller.scrollTop = 0;
    this.paint();
  }

  private schedule(ms = 120) {
    if (this.timer) return;
    this.timer = window.setTimeout(() => { this.timer = 0; this.paint(); }, ms);
  }

  /** The acting account's snapshot, if this wallet controls a player. */
  private me() {
    const addrs = wallet.accounts.filter((a) => a.playerId).map((a) => a.address);
    if (!addrs.includes(this.actor)) this.actor = wallet.active?.playerId && addrs.includes(wallet.active.address) ? wallet.active.address : addrs[0] || '';
    return this.actor ? eco.mine.get(this.actor) ?? null : null;
  }

  private draftsFor(actor: string) {
    let d = this.drafts.get(actor);
    if (!d) this.drafts.set(actor, (d = new Map()));
    return d;
  }

  private paintStatus() {
    if (!this.status?.isConnected) return;
    const g = eco.galaxy;
    const expert = document.body.classList.contains('expert');
    // A word or two on screen; the whole story on hover.
    this.status.textContent = eco.loading ? 'Reading…'
      : eco.galaxyError ? (expert ? `LCD: ${eco.galaxyError}` : g ? `Galaxy not answering · ${ago(Date.now() - g.loadedAt)} old` : 'Galaxy not answering')
      : g ? `read ${ago(Date.now() - g.loadedAt)} ago · block ${g.height.toLocaleString()}` : '';
    this.status.title = eco.loading ? 'Reading the chain…'
      : eco.galaxyError ? (g ? `Couldn’t reach the game · showing what was read ${ago(Date.now() - g.loadedAt)} ago (${eco.galaxyError})` : `Couldn’t reach the game (${eco.galaxyError})`) : '';
    this.status.classList.toggle('c-enemy', !!eco.galaxyError && !eco.loading);
    // The everyday read-out is an expert's detail; reading and trouble always show.
    this.status.classList.toggle('x-only', !eco.loading && !eco.galaxyError);
  }

  private paintActor() {
    const players = wallet.accounts.filter((a) => a.playerId);
    const me = this.me();
    if (!players.length) {
      const [ico, words, title] = wallet.state === 'empty' ? ['find', 'Just looking', 'Just looking · no commander yet'] : wallet.state === 'locked' ? ['lock', 'Vault locked', 'Vault locked'] : ['lock', 'No commander', 'No commander yet'];
      this.actorBox.replaceChildren(h('span', { class: 'dct-chip', title }, h('span', { html: icon(ico, 15) }), words));
      return;
    }
    const sel = h('select', { class: 'input eco-select', 'aria-label': 'Act as', title: 'Acting as' }, ...players.map((a) => h('option', { value: a.address, selected: a.address === this.actor }, `${a.label} · ${a.playerId}`))) as HTMLSelectElement;
    sel.addEventListener('change', () => { this.actor = sel.value; audio.play('select'); this.paint(); });
    const gh = me ? gridHealth(me.grid) : null;
    const alpha = me ? amountOf(me.primary, 'ualpha') : 0n;
    this.actorBox.replaceChildren(...[
      h('span', { class: 'dct-chip-ico', title: 'Acting as', html: icon('base', 18) }), sel,
      me && gh ? h('span', { class: 'eco-actor-sum t-tiny', title: `${powerText(gh.headroom)} free · ${alphaText(alpha, 1)}` },
        h('span', { class: 'dot ' + (gh.state === 'dark' ? 'c-enemy' : gh.state === 'thin' ? 'c-warn' : 'c-player') }),
        amount('power', powerText(gh.headroom)), amount('alpha', alphaNum(alpha, 1))) : null].filter((x): x is HTMLElement => !!x));
  }

  private paint() {
    if (!this.root?.isConnected) return;
    const a = document.activeElement as HTMLElement | null;
    if (this.pressing || (a && this.body.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName))) { this.deferred = true; return; }
    // A keyboard or pad cursor stays on the same control (data-k) across the repaint.
    keepFocus(this.root, () => this.paintNow());
  }

  private paintNow() {
    this.paintStatus();
    this.paintActor();
    const tab = TABS.find((t) => t.id === this.tab)!;
    this.nav.replaceChildren(...TABS.map((t, i) => h('button', {
      class: 'etab dct-tab' + (t.id === this.tab ? ' on' : ''), role: 'tab', 'aria-selected': t.id === this.tab ? 'true' : 'false', title: `${t.plain}\n${t.hint} (${i + 1})`, 'data-k': 'tab:' + t.id,
      onclick: () => this.go(t.id),
    }, h('span', { class: 'dct-tab-ico', html: icon(t.icon, 18) }), h('span', { class: 'dct-word' }, t.label))));
    // The tab's sentence lives on its hover; the lesson that teaches it is one pill away.
    if (tab.lesson) this.nav.appendChild(h('a', { class: 'dct-learn', 'data-k': 'learn', href: '/academy/economics/' + tab.lesson, title: `${tab.plain} Learn it in the Academy.` }, h('span', { html: icon('academy', 18) }), h('span', null, 'Learn')));
    this.alert.replaceChildren(...[lockedNote()].filter((x): x is HTMLElement => !!x));
    const top = this.scroller.scrollTop;
    const host = h('div', { class: 'eco-tab tab-' + this.tab });
    host.dataset.gen = String(++this.gen);
    if (!eco.galaxy) {
      host.appendChild(eco.galaxyError
        ? blank('health', 'Galaxy not answering', `Couldn’t reach the game right now (${eco.galaxyError}). Try again in a moment.`, ['Retry', () => { audio.play('select'); void eco.refresh(); this.paintStatus(); }])
        // The Market's shape shows at once while the galaxy is read (it can take a while).
        : this.tab === 'market' ? marketSkeleton()
        : h('div', { class: 'eco-loading', title: 'Reading reactors, substations, providers and banks…' }, h('span', { class: 'dot pulse c-player' }), 'Reading…'));
    } else {
      const me = this.me();
      const ctx: EcoCtx = {
        host, me, arg: this.arg, drafts: this.draftsFor(this.actor),
        navigate: (hash) => { const m = /^#?\/economy\/(\w+)(?:\/(.+))?$/.exec(hash); if (m && TABS.some((t) => t.id === m[1])) this.go(m[1] as Tab, m[2]); else this.navigate(hash); },
        repaint: () => this.schedule(),
      };
      try { TABS.find((t) => t.id === this.tab)!.mount(ctx); }
      catch (e) { console.error(e); host.replaceChildren(blank('health', 'Tab failed to draw', (e as Error).message)); }
    }
    this.body.replaceChildren(host);
    this.scroller.scrollTop = top;
  }
}
