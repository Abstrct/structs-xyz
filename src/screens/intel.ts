/* Intel: the data layer, explorable. GRASS (the guild stack's live NATS feed) streams the
 * galaxy as it changes; the Guild API (where a guild allows this site) adds rosters, ledgers, boards
 * and history for members; the LCD fills in everything public. Tabs:
 *   #/intel/guilds · #/intel/guild/<0-x> · #/intel/leaderboards[/<kind>] · #/intel/activity[/<filter>]
 *   #/intel/ledger[/<1-x>] · #/intel/stats · #/intel/raids
 * Everything that needs a guild session says so in one banner and keeps the public view. */
import '../styles/intel.css';
import '../styles/dc-trade.css';
import type { Engine } from '../core/engine';
import { h } from '../core/dom';
import { audio } from '../core/audio';
import { formatInt, sleep } from '../core/util';
import { PanelScreen } from './panelScreen';
import { grass, type GrassState } from '../grass/grass';
import { store } from '../chain/store';
import { DEFAULT_GUILD, guildLabel, guilds, onGuilds, type GuildEntry } from '../guild/directory';
import { guildApi } from '../guild/api';
import { receiving, type IntelCtx } from '../ui/intel/common';
import { sparkline, SERIES } from '../ui/intel/chart';
import { mountGuilds } from '../ui/intel/guilds';
import { mountActivity } from '../ui/intel/activity';
import { mountLeaderboards } from '../ui/intel/leaderboards';
import { mountLedger } from '../ui/intel/ledger';
import { mountStats } from '../ui/intel/stats';
import { mountRaids } from '../ui/intel/raids';
import { icon } from '../ui/icons';

type Tab = 'guilds' | 'leaderboards' | 'activity' | 'ledger' | 'stats' | 'raids';
/** `cta`: where the sign-in banner goes: on top where members' data is the point of the tab,
 * below where the public view carries it. */
const TABS: { id: Tab; label: string; short: string; icon: string; hint: string; cta: 'top' | 'bottom'; mount: (c: IntelCtx) => void }[] = [
  { id: 'activity', label: 'Activity', short: 'Live', icon: 'news', hint: 'The live GRASS feed', cta: 'bottom', mount: mountActivity },
  { id: 'guilds', label: 'Guilds', short: 'Guilds', icon: 'flag', hint: 'Every guild and its dossier', cta: 'bottom', mount: mountGuilds },
  { id: 'raids', label: 'Raids', short: 'Raids', icon: 'battle', hint: 'Who is raiding whom', cta: 'bottom', mount: mountRaids },
  { id: 'leaderboards', label: 'Boards', short: 'Boards', icon: 'record', hint: 'The galaxy’s rankings (leaderboards)', cta: 'top', mount: mountLeaderboards },
  { id: 'stats', label: 'Stats', short: 'Stats', icon: 'health', hint: 'Time series and census', cta: 'bottom', mount: mountStats },
  { id: 'ledger', label: 'Ledger', short: 'Ledger', icon: 'book', hint: 'Your commander’s books', cta: 'top', mount: mountLedger },
];

/** Each tab in one plain sentence: its pill's hover (and the guide's job), never a paragraph on screen. */
const PLAIN: Record<Tab, string> = {
  activity: 'Everything happening in the galaxy right now, the moment it happens: builds, mining, refining, raids.',
  guilds: 'Every guild (team) in the galaxy: who is in it, how much power it has, and its bank.',
  raids: 'Who is raiding whom: fleets that sailed to another planet to take its ore.',
  leaderboards: 'The galaxy’s top commanders, ranked. Can you get on the board?',
  stats: 'The galaxy in charts: how fast blocks land, what is happening most, alpha moved per day and every struct counted.',
  ledger: 'A commander’s books: balances, and every bit of ore and alpha mined, refined, sent or received, like a bank statement.',
};

export class IntelScreen extends PanelScreen {
  private tabCleanup: (() => void)[] = [];
  private generation = 0;

  constructor(engine: Engine, navigate: (hash: string) => void) { super(engine, navigate, 'intel', 5.1); }

  protected mount(params: Record<string, string>) {
    const tab: Tab = params.tab === 'guild' ? 'guilds' : (TABS.find((t) => t.id === params.tab)?.id || 'activity');
    const arg = params.arg;

    const body = h('div', { class: 'intel-body' });
    const ctaHost = h('div', { class: 'intel-ctahost' + (TABS.find((t) => t.id === tab)!.cta === 'bottom' ? ' bottom' : '') });
    // Each tab's plain sentence is its pill's hover; the screen itself shows pictures and numbers.
    const scroller = TABS.find((t) => t.id === tab)!.cta === 'bottom' ? h('div', { class: 'intel-scroll scroll' }, body, ctaHost) : h('div', { class: 'intel-scroll scroll' }, ctaHost, body);
    const uplink = h('div', { class: 'uplink x-only' });
    // The screen's one live region (visually hidden): the feed's state, said once per change. The
    // tabs' waiting pills and wells are rebuilt as data lands, so none of them is a live region.
    const live = h('span');
    let wasLive = false;
    const sayState = () => {
      const st: GrassState = grass.state;
      const said = st === 'live' ? (wasLive ? live.textContent || '' : 'Live news connected') : st === 'down' ? 'Live news lost, retrying' : 'Tuning in to the live news';
      wasLive = st === 'live';
      if (live.textContent !== said) live.textContent = said;
    };
    const source = h('select', { class: 'input source', 'aria-label': 'Read intel from guild', title: 'Whose GRASS and Guild API Intel reads from' }) as HTMLSelectElement;
    const tabs = h('nav', { class: 'intel-tabs dct-tabs', role: 'tablist' }, ...TABS.map((t, i) => h('button', {
      class: 'itab dct-tab' + (t.id === tab ? ' on' : ''), role: 'tab', 'aria-selected': t.id === tab ? 'true' : 'false', title: `${PLAIN[t.id]}\n${t.hint} (${i + 1})`,
      onclick: () => { if (t.id !== tab || arg) { audio.play('select'); this.navigate('/intel/' + t.id); } },
    }, h('span', { class: 'dct-tab-ico', html: icon(t.icon, 18) }), h('span', { class: 'dct-word' }, t.label), t.id === 'activity' ? h('span', { class: 'itab-live dot pulse' }) : null)));

    this.root.appendChild(h('div', { class: 'intel-frame dct-frame', style: '--hub:#94A4E4' },
      h('header', { class: 'intel-head' },
        h('div', { class: 'intel-title dct-title', title: 'News & Rankings: what is happening in the galaxy right now' },
          h('span', { class: 'dct-title-ico', html: icon('news', 26) }), h('span', { class: 'intel-mark' }, 'News'), h('span', { class: 't-label c-hint intel-sub x-only' }, 'GRASS stream · Guild indexer')),
        uplink,
        h('label', { class: 'source-box x-only' }, h('span', { class: 't-label' }, 'Source'), source)),
      tabs, scroller, h('span', { class: 'dcp-sr', role: 'status' }, live)));

    // Number keys switch tabs (not while typing).
    const keys = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
      const i = Number(e.key) - 1;
      if (i >= 0 && i < TABS.length) this.navigate('/intel/' + TABS[i].id);
    };
    window.addEventListener('keydown', keys);
    this.cleanup.push(() => window.removeEventListener('keydown', keys));

    // Uplink: the GRASS link at a glance.
    const paintUplink = () => {
      const st: GrassState = grass.state;
      const per = grass.perMinute(undefined, 20);
      uplink.className = 'uplink x-only ' + (st === 'live' ? 'ok' : st === 'down' ? 'bad' : 'warn');
      uplink.replaceChildren(
        h('span', { class: 'dot' + (st === 'live' ? ' pulse' : '') }),
        h('div', { class: 'col', style: 'gap:0' },
          h('span', { class: 't-label' }, st === 'live' ? 'GRASS live' : st === 'connecting' ? 'Tuning in' : st === 'down' ? 'Signal lost · retrying' : 'Idle'),
          h('span', { class: 't-tiny c-hint' }, `${grass.guildId ? guildLabel(grass.guildId).name : '…'} · #${grass.height ? formatInt(grass.height) : '…'}`)),
        sparkline(per, SERIES[0], 80, 22),
        h('span', { class: 'num t-tiny' }, formatInt(per[per.length - 1] || 0) + '/m'));
    };
    paintUplink();
    const uplinkTimer = setInterval(paintUplink, 5000);
    this.cleanup.push(grass.onState(paintUplink), grass.onBlock(paintUplink), () => clearInterval(uplinkTimer), grass.onState(sayState));
    sayState();

    // The chain's recent history (fights, builds, mining) and the roster's names start loading now,
    // while the live feed dials, so the Activity tab has news to show the moment it mounts.
    if (tab === 'activity') { void store.loadCore().catch(() => { /* names fall back to ids */ }); void store.backfill(); }
    // Which guild Intel reads from: GRASS's guild (the commander's by default). Dialling it can take
    // a few seconds: the tab's place shows a dish tuning in meanwhile, never an empty frame.
    let alive = true;
    this.cleanup.push(() => { alive = false; });
    // Activity draws at once (the chain's history and the last visit need no feed); it is drawn again
    // only if the feed turns out to be another guild's. The other tabs wait for the feed's guild.
    const early = tab === 'activity';
    let earlyGuild = '';
    this.cleanup.push(() => this.unmountTab());
    if (early) { this.mountTab(tab, arg, body, ctaHost); earlyGuild = this.mounted; }
    else if (grass.state !== 'live') body.replaceChildren(receiving('Tuning in', 'Dialling the guild’s live news feed…', TABS.find((t) => t.id === tab)!.icon));
    // The rest waits for the feed, but the screen doesn't: entering returns now (the router holds
    // its loading screen until enter() resolves, so an await here kept NOW LOADING up for seconds).
    void (async () => {
      await Promise.race([grass.start(), sleep(4000)]);
      // Left while GRASS was dialling: cleanup has already run, so add nothing it would miss.
      if (!alive) return;
      const paintSource = (list: GuildEntry[]) => {
        const current = grass.guildId || DEFAULT_GUILD;
        const usable = list.filter((g) => g.services?.guild_api || g.services?.grass);
        source.replaceChildren(...(usable.length ? usable : [{ id: current } as GuildEntry]).map((g) =>
          h('option', { value: g.id, selected: g.id === current }, `${guildLabel(g.id).name} (${guildLabel(g.id).tag})`)));
      };
      this.cleanup.push(onGuilds(paintSource));
      void guilds().catch(() => { /* fallback list painted by onGuilds */ });
      // Only the latest pick, and only while this screen is up, re-mounts the tab.
      let picks = 0;
      source.addEventListener('change', async () => {
        audio.play('select');
        const pick = ++picks;
        try { await grass.switchGuild(source.value); } catch (e) { console.error(e); }
        if (!alive || pick !== picks) return;
        this.mountTab(tab, arg, body, ctaHost);
        paintUplink();
      });

      if (!early || (grass.guildId || grass.preferred() || DEFAULT_GUILD) !== earlyGuild) this.mountTab(tab, arg, body, ctaHost);
    })();
  }
  /** The guild the tab on screen was drawn for. */
  private mounted = '';

  private unmountTab() {
    this.generation++;
    for (const f of this.tabCleanup.splice(0)) { try { f(); } catch (e) { console.error(e); } }
  }

  private mountTab(tab: Tab, arg: string | undefined, body: HTMLElement, ctaHost: HTMLElement) {
    this.unmountTab();
    const gen = this.generation;
    const guildId = grass.guildId || grass.preferred() || DEFAULT_GUILD;
    this.mounted = guildId;
    const api = guildApi(guildId);
    body.replaceChildren();
    ctaHost.replaceChildren();
    const ctx: IntelCtx = {
      body, arg, guildId, api,
      navigate: (hash) => this.navigate(hash),
      cleanup: this.tabCleanup,
      alive: () => this.generation === gen,
      refresh: () => { if (this.generation === gen) this.mountTab(tab, arg, body, ctaHost); },
    };
    try { TABS.find((t) => t.id === tab)!.mount(ctx); } catch (e) { console.error(e); body.appendChild(h('div', { class: 'ierror' }, String((e as Error).message || e))); }
  }
}
