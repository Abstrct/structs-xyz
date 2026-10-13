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
import { alphaNum, alphaText, amount, blank, lockedNote, powerText, section, tile, type EcoCtx } from '../ui/economy/kit';
import { cache } from '../cache/idb';
import { icon } from '../ui/icons';
import { keepFocus } from '../ui/keepFocus';
import { amountOf } from '../ui/economy/data';
import { mountPower } from '../ui/economy/power';
import { mountFuel } from '../ui/economy/fuel';
import { mountMarket } from '../ui/economy/market';
import { mountBanks } from '../ui/economy/banks';
import { mountTransfers } from '../ui/economy/transfers';

type Tab = 'power' | 'fuel' | 'market' | 'banks' | 'transfers';
/** A tab's top row of tiles as it last showed them, kept (IndexedDB) so the next visit can show
 * them at once, dimmed and marked as the last visit's, while the testnet is read again. */
interface TileSnap { label: string; value: string; ico: string; tone: string }
interface TabSnap { at: number; height: number; tiles: TileSnap[] }
const SNAP_NS = 'economy';
const SNAP_TTL = 7 * 86_400_000;
const TONES = ['', 'player', 'enemy', 'warn', 'neutral'] as const;
/** A signal meter where a number is about to land (dc-polish.css). */
const bars = () => h('span', { class: 'dcp-bars', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'));
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
  /** The screen's one live region (visually hidden): it says when a read starts and how it ended,
   * so the waiting pills and wells can be rebuilt on every repaint without being announced. */
  private live!: HTMLElement;
  /** Form drafts per acting account address ('' while read-only). */
  private drafts = new Map<string, Map<string, string>>();
  /** Wallet address this screen acts as (an account with a player); defaults to the active one. */
  private actor = '';
  private timer = 0;
  private deferred = false;
  /** A pointer is pressed inside the body: a repaint now would swap the button under it. */
  private pressing = false;
  private gen = 0;
  /** The tab (and whether the galaxy was in) on screen at the last paint. */
  private painted = '';
  /** The last visit's tiles per tab (undefined: not asked yet; null: none kept). */
  private last = new Map<string, TabSnap | null>();
  /** What was last written per key, so an unchanged repaint writes nothing. */
  private saved = new Map<string, string>();

  constructor(engine: Engine, navigate: (hash: string) => void) { super(engine, navigate, 'economy', 7.7); }

  protected mount(params: Record<string, string>) {
    // A visitor (no commander) starts in the Market, which is open to everyone; Power is one pill away.
    this.tab = TABS.find((t) => t.id === params.tab)?.id || (wallet.accounts.some((a) => a.playerId) ? 'power' : 'market');
    this.arg = params.arg;
    this.nav = h('nav', { class: 'eco-tabs dct-tabs', role: 'tablist' });
    this.status = h('span', { class: 't-tiny c-hint eco-status' });
    this.live = h('span');
    this.actorBox = h('div', { class: 'eco-actor' });
    this.alert = h('div', { class: 'eco-alerthost' });
    this.body = h('div', { class: 'eco-body' });
    this.scroller = h('div', { class: 'eco-scroll scroll' }, this.alert, this.body);
    this.root.appendChild(h('div', { class: 'eco-frame dct-frame', style: '--hub:#EBAA49' },
      h('header', { class: 'eco-head' },
        h('div', { class: 'eco-title dct-title', title: 'Economy: power, fuel, the energy market, guild banks and sending alpha' },
          h('span', { class: 'dct-title-ico', html: icon('trade', 26) }), h('span', { class: 'eco-mark' }, 'Trade')),
        this.actorBox,
        h('div', { class: 'row eco-headtools' }, this.status, h('button', { class: 'btn ghost dct-iconbtn', title: 'Refresh: read everything again', 'aria-label': 'Refresh', html: icon('replay', 18), onclick: () => this.reread() }))),
      this.nav, this.scroller, h('span', { class: 'dcp-sr', role: 'status' }, this.live)));

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

  protected unmount() { clearTimeout(this.timer); this.timer = 0; this.painted = ''; dismissConfirms(); }

  private go(tab: Tab, arg?: string) {
    if (tab === this.tab && arg === this.arg) return;
    this.tab = tab; this.arg = arg;
    replaceRoute('/economy/' + tab + (arg ? '/' + arg : ''));
    dismissConfirms();
    audio.play('select');
    this.scroller.scrollTop = 0;
    this.paint();
  }

  /** Read everything again (Refresh, Retry): the screen shows the read at once, not when it ends. */
  private reread() {
    audio.play('select');
    void eco.refresh();
    this.paintStatus();
    this.schedule(0);
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
    if (eco.loading) this.status.replaceChildren(bars(), 'Reading');
    else this.status.textContent = eco.galaxyError ? (expert ? `LCD: ${eco.galaxyError}` : g ? `Galaxy not answering · ${ago(Date.now() - g.loadedAt)} old` : 'Galaxy not answering')
      : g ? `read ${ago(Date.now() - g.loadedAt)} ago · block ${g.height.toLocaleString()}` : '';
    this.status.title = eco.loading ? 'Reading the chain…'
      : eco.galaxyError ? (g ? `Couldn’t reach the game · showing what was read ${ago(Date.now() - g.loadedAt)} ago (${eco.galaxyError})` : `Couldn’t reach the game (${eco.galaxyError})`) : '';
    this.status.classList.toggle('c-enemy', !!eco.galaxyError && !eco.loading);
    // The everyday read-out is an expert's detail; a re-read and trouble always show. The first
    // read has the body's receiving state, so the head stays quiet.
    this.status.classList.toggle('x-only', (!eco.loading && !eco.galaxyError) || (eco.loading && !g && !eco.galaxyError));
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
    // The tab fades in when it is new on screen (a switch, the first read landing), never on a
    // repaint of the same tab (the chain repaints it every few seconds).
    const fresh = `${this.tab}:${!!eco.galaxy}` !== this.painted;
    this.painted = `${this.tab}:${!!eco.galaxy}`;
    const host = h('div', { class: 'eco-tab tab-' + this.tab + (fresh ? ' enter' : '') });
    host.dataset.gen = String(++this.gen);
    // Said once per change, never per repaint.
    const said = !eco.galaxy && eco.loading ? 'Reading the testnet…' : !eco.galaxy && eco.galaxyError ? 'Galaxy not answering' : '';
    if (this.live.textContent !== said) this.live.textContent = said;
    if (!eco.galaxy) {
      host.append(...this.waiting(tab));
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
    if (eco.galaxy) this.saveSnap(host);
  }

  private snapKey() { return `tiles:${this.tab}:${this.actor || '-'}`; }

  /** The last visit's tiles for the tab on show; the first ask reads them (and repaints if the
   * galaxy is still on its way). */
  private snap(): TabSnap | null {
    // Someone else's grid (#/economy/power/<1-x>) is read on demand: no last visit is kept for it.
    if (this.arg) return null;
    const key = this.snapKey();
    if (!this.last.has(key)) {
      this.last.set(key, null);
      void cache.entry<TabSnap>(key, SNAP_NS).then((e) => {
        const v = e?.v;
        if (!v || !Array.isArray(v.tiles) || !v.tiles.length) return;
        this.last.set(key, v);
        if (!eco.galaxy && this.root?.isConnected) this.schedule();
      }, () => { /* no cache: the receiving state stands alone */ });
    }
    return this.last.get(key) ?? null;
  }

  /** Keep the tab's top tiles as they are now, for the next visit's first paint. Only a live read
   * is kept (never one shown after a failed re-read, never a peeked grid), and it is dated by when
   * the testnet was read (the older of the galaxy's and the commander's read), not when it was saved. */
  private saveSnap(host: HTMLElement) {
    const row = host.querySelector('.eco-tiles');
    const g = eco.galaxy;
    if (!row || !g || eco.galaxyError || this.arg) return;
    const me = this.me();
    const at = Math.min(g.loadedAt, me?.loadedAt ?? Infinity);
    const tiles: TileSnap[] = [...row.querySelectorAll<HTMLElement>(':scope > .eco-tile:not(.x-only)')].map((el) => ({
      label: el.querySelector('.t-label')?.textContent?.trim() || '',
      value: el.querySelector('.eco-big')?.textContent?.trim() || '',
      ico: /\bk-([\w-]+)/.exec(el.querySelector('.eco-tile-ico')?.className || '')?.[1] || '',
      tone: TONES.find((t) => t && el.classList.contains(t)) || '',
    })).filter((t) => t.label && t.value && !t.value.includes('…'));
    if (!tiles.length) return;
    const key = this.snapKey(), json = JSON.stringify(tiles);
    if (this.saved.get(key) === json) return;
    this.saved.set(key, json);
    void cache.set<TabSnap>(key, { at, height: g.height, tiles }, SNAP_TTL, SNAP_NS).catch(() => { /* best effort */ });
  }

  /** While the galaxy is read (6–15 s on a busy testnet): the receiving pill, the last visit's
   * tiles dimmed under a clock (never passed off as live) or a signal meter where each number
   * will land, and the tab's shape under a scan line. A failed read keeps the last visit too. */
  private waiting(tab: (typeof TABS)[number]): Node[] {
    const snap = this.snap();
    const age = snap ? ago(Date.now() - snap.at) : '';
    // A read under way (Retry, coming back after a failed visit) shows as one, not as the last failure.
    const err = eco.loading ? '' : eco.galaxyError;
    const row = h('div', { class: 'dcp-wait-row' },
      // Decorative: the screen's live region says it once (this pill is rebuilt on every repaint).
      err ? null : h('span', { class: 'dcp-rx', 'aria-hidden': 'true', title: 'Receiving: reading reactors, substations, providers and banks from the testnet…' },
        h('span', { class: 'dcp-dish', html: icon(tab.icon, 16) }), bars(), 'Receiving'),
      snap ? h('span', { class: 'dcp-last', title: `Read from the testnet ${age} ago (block ${snap.height.toLocaleString()}). Not live: the numbers update when the testnet answers.` },
        h('span', { html: icon('clock', 14) }), 'Last visit', h('b', null, age)) : null);
    const tiles = snap
      ? h('div', { class: 'eco-tiles' }, ...snap.tiles.map((t) => {
        const el = tile(t.label, t.value, null, TONES.find((x) => x === t.tone) || '', t.ico || undefined);
        el.classList.add('dcp-stale');
        el.title = `${t.label}: ${t.value}, read ${age} ago. Not live yet.`;
        return el;
      }))
      // The Market's tiles are known by heart: a meter stands where each number will land.
      : tab.id === 'market' ? h('div', { class: 'eco-tiles' },
        tile('Best price', bars(), null, 'player', 'alpha'), tile('Sellers', bars(), null, '', 'market'), tile('Rented', bars(), null, '', 'queue'))
      : null;
    const body = err
      ? blank('health', 'Galaxy not answering', `Couldn’t reach the game right now (${err}).${snap ? ' The dim numbers are from your last visit.' : ''} Try again in a moment.`, ['Retry', () => this.reread()])
      : tab.id === 'market'
        // The shop's shape: placeholder cards under a scan line.
        ? section('Power shop', null, [h('div', { class: 'eco-cards dcp-sweep', 'aria-hidden': 'true' }, ...Array.from({ length: 4 }, () =>
          h('div', { class: 'eco-card offer dct-skel' }, h('i', { class: 'w60' }), h('i', { class: 'big w40' }), h('i', { class: 'w30' }))))], { tone: 'player', icon: 'market' })
        : h('div', { class: 'dcp-scan', title: 'Reading the testnet…', 'aria-hidden': 'true' }, h('span', { class: 'dcp-dish big', html: icon(tab.icon, 34) }));
    return [row, tiles, body].filter((x): x is HTMLElement => !!x);
  }
}
