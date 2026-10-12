/* The galaxy store: every player, fleet and guild (one request each), every
 * planet ever discovered (streamed in pages), kept current by the live feed
 * and re-read on reconnect. Also turns raw chain events into feed items a
 * person can read. */
import { LCD_URL, lcd, type RawFleet, type RawGuild, type RawPlanet, type RawPlayer } from './lcd';
import { live, type ChainTxEvent, type LiveTx } from './live';
import { idIndex, safeEach } from '../core/util';
import { typeOf } from '../data/catalogue';

export interface PlanetLite { id: string; index: number; owner: string; active: boolean; structs: number; maxOre: number; name: string }

export type FeedKind = 'attack' | 'raid' | 'build' | 'mine' | 'refine' | 'explore' | 'fleet' | 'player' | 'theft' | 'infuse' | 'guild' | 'other';
export interface FeedItem {
  kind: FeedKind; text: string; planetId?: string; toPlanetId?: string; playerId?: string; height: number; at: number;
  tone: 'player' | 'enemy' | 'neutral' | 'warn' | 'hint'; hash?: string;
  /** Backfilled from recent history rather than seen live. */
  replay?: boolean;
}

type Fn<T> = (v: T) => void;

/** Guild display names. Guild metadata lives off-chain (guild.json) behind
 * no CORS, so known guilds are named here and the rest fall back to id. */
const KNOWN_GUILDS: Record<string, { name: string; tag: string }> = {
  '0-1': { name: 'Orbital Hydro', tag: 'OH' },
};
export const GUILD_COLORS = [0x43cdb6, 0xebaa49, 0x94a4e4, 0xee7d69, 0x86dfc6, 0xf3c878, 0xbbcaef, 0xf4a990];

class Store {
  players = new Map<string, RawPlayer>();
  byAddress = new Map<string, string>();
  fleets = new Map<string, RawFleet>();
  guilds = new Map<string, RawGuild>();
  planets = new Map<string, PlanetLite>();
  /** Planet id → player id living there (from player.planetId). */
  homeOf = new Map<string, string>();
  maxPlanetIndex = 0;
  coreLoaded = false;
  planetsLoaded = false;
  planetsProgress = 0;
  feed: FeedItem[] = [];
  /** Struct id → type id, learned from EventStruct payloads as they pass. */
  private structTypes = new Map<string, number>();
  private coreP: Promise<void> | null = null;
  /** Transactions already narrated live (backfill skips them). */
  private liveSeen = new Set<string>();
  private planetsP: Promise<void> | null = null;
  private coreL = new Set<Fn<void>>();
  private planetL = new Set<Fn<PlanetLite[]>>();
  private feedL = new Set<Fn<FeedItem>>();
  private changeL = new Set<Fn<{ kind: 'player' | 'fleet' | 'planet'; id: string }>>();

  constructor() {
    live.onTx((tx) => { if (tx.hash) { this.liveSeen.add(tx.hash); if (this.liveSeen.size > 2000) this.liveSeen.delete(this.liveSeen.values().next().value!); } this.ingest(tx); });
    live.onReconnect(() => { void this.refreshCore(); });
  }

  onCore(f: Fn<void>) { this.coreL.add(f); if (this.coreLoaded) f(); return () => this.coreL.delete(f); }
  onPlanets(f: Fn<PlanetLite[]>) { this.planetL.add(f); return () => this.planetL.delete(f); }
  onFeed(f: Fn<FeedItem>) { this.feedL.add(f); return () => this.feedL.delete(f); }
  onChange(f: Fn<{ kind: 'player' | 'fleet' | 'planet'; id: string }>) { this.changeL.add(f); return () => this.changeL.delete(f); }

  guildName(id: string) { return this.guildNames.get(id)?.name || KNOWN_GUILDS[id]?.name || (id ? `Guild ${id}` : 'Independent'); }
  guildTag(id: string) { return this.guildNames.get(id)?.tag || KNOWN_GUILDS[id]?.tag || (id ? 'G' + idIndex(id) : '—'); }
  /** Names and tags from each guild's own guild.json (fed in by the app once the directory loads). */
  guildNames = new Map<string, { name: string; tag: string }>();
  setGuildNames(list: { id: string; name?: string; tag?: string }[]) {
    for (const g of list) if (g.name) this.guildNames.set(g.id, { name: g.name, tag: g.tag || this.guildTag(g.id) });
  }

  /** Fill the roster from a cached snapshot so the first paint needn't wait for the LCD. The live
   * read replaces it moments later. */
  hydrate(snap: { players: RawPlayer[]; fleets: RawFleet[]; guilds: RawGuild[] }) {
    if (this.coreLoaded) return;
    for (const p of snap.players) this.putPlayer(p);
    for (const f of snap.fleets) this.fleets.set(f.id, f);
    for (const g of snap.guilds) this.guilds.set(g.id, g);
    this.coreLoaded = true;
    safeEach(this.coreL, (f) => f());
  }
  /** Set by the app: persists each fresh roster (the cache lives outside the chain layer). */
  onRosterRead: ((snap: { players: RawPlayer[]; fleets: RawFleet[]; guilds: RawGuild[] }) => void) | null = null;
  guildColor(id: string) {
    if (!id) return 0x7394a5;
    const ids = [...this.guilds.keys()].sort((a, b) => idIndex(a) - idIndex(b));
    const i = ids.indexOf(id);
    return GUILD_COLORS[(i < 0 ? idIndex(id) : i) % GUILD_COLORS.length];
  }
  playerName(id: string) {
    const p = this.players.get(id);
    return p?.name ? p.name : id || 'unknown';
  }
  members(guildId: string) { let n = 0; for (const p of this.players.values()) if (p.guildId === guildId) n++; return n; }

  loadCore(): Promise<void> {
    // A failed load is forgotten, so the next caller retries instead of inheriting the failure.
    if (!this.coreP) this.coreP = this.refreshCore().catch((e) => { this.coreP = null; throw e; });
    return this.coreP;
  }

  private async refreshCore() {
    const [players, fleets, guilds] = await Promise.all([
      lcd.list<RawPlayer>('player', 'Player'),
      lcd.list<RawFleet>('fleet', 'Fleet'),
      lcd.list<RawGuild>('guild', 'Guild'),
    ]);
    this.players.clear(); this.byAddress.clear(); this.homeOf.clear();
    for (const p of players) this.putPlayer(p);
    this.fleets.clear();
    for (const f of fleets) this.fleets.set(f.id, f);
    this.guilds.clear();
    for (const g of guilds) this.guilds.set(g.id, g);
    this.coreLoaded = true;
    safeEach(this.coreL, (f) => f());
    try { this.onRosterRead?.({ players, fleets, guilds }); } catch { /* caching is best effort */ }
  }

  private putPlayer(p: RawPlayer) {
    this.players.set(p.id, p);
    if (p.primaryAddress) this.byAddress.set(p.primaryAddress, p.id);
    if (p.creator) this.byAddress.set(p.creator, p.id);
    if (p.planetId) {
      this.homeOf.set(p.planetId, p.id);
      const idx = idIndex(p.planetId);
      if (idx > this.maxPlanetIndex) this.maxPlanetIndex = idx;
    }
  }

  loadPlanets(): Promise<void> {
    if (!this.planetsP) {
      this.planetsProgress = 0;
      this.planetsP = lcd.list<RawPlanet>('planet', 'Planet', {
        limit: 10000,
        onPage: (rows) => {
          const lite = rows.map((r) => this.putPlanet(r));
          this.planetsProgress += rows.length;
          safeEach(this.planetL, (f) => f(lite));
        },
      }).then(() => { this.planetsLoaded = true; }, (e) => { this.planetsP = null; throw e; });
    }
    return this.planetsP;
  }

  private putPlanet(r: RawPlanet): PlanetLite {
    const structs = [...(r.space || []), ...(r.air || []), ...(r.land || []), ...(r.water || [])].filter(Boolean).length;
    const p: PlanetLite = { id: r.id, index: idIndex(r.id), owner: r.owner, active: r.status === 'active' || r.status === '0', structs, maxOre: Number(r.maxOre || 0), name: r.name || '' };
    this.planets.set(r.id, p);
    if (p.index > this.maxPlanetIndex) this.maxPlanetIndex = p.index;
    return p;
  }

  /** Where a struct/fleet location resolves to, as a planet id. */
  planetOfLocation(locationId: string | undefined): string | undefined {
    if (!locationId) return undefined;
    if (locationId.startsWith('2-')) return locationId;
    if (locationId.startsWith('9-')) return this.fleets.get(locationId)?.locationId;
    if (locationId.startsWith('1-')) return this.players.get(locationId)?.planetId;
    return undefined;
  }

  playerPlanet(playerId: string | undefined) { return playerId ? this.players.get(playerId)?.planetId : undefined; }

  private replayAt = 0;
  private backfilled = false;

  /** Recent history from the LCD's tx search, narrated like live events. */
  async backfill(blocks = 400) {
    if (this.backfilled) return;
    this.backfilled = true;
    try {
      const latest = live.height || (await lcd.latestHeight()).height;
      const res = await fetch(`${LCD_URL}/cosmos/tx/v1beta1/txs?query=${encodeURIComponent(`tx.height>${latest - blocks}`)}&order_by=ORDER_BY_DESC&limit=100`);
      if (!res.ok) { this.backfilled = false; return; }
      const body = await res.json() as { tx_responses?: { height: string; txhash: string; timestamp: string; code: number; events: { type: string; attributes: { key: string; value: string }[] }[] }[] };
      const txs = (body.tx_responses || []).filter((t) => !t.code).sort((a, b) => Number(a.height) - Number(b.height));
      // Name what was built: completions of structs started before this window need one lookup each (capped).
      const built = new Set<string>(), seen = new Set<string>();
      for (const t of txs) for (const e of t.events || []) {
        const a = e.attributes.find((x) => x.key !== 'msg_index');
        if (!a) continue;
        if (e.type === 'structs.structs.EventStruct') { try { seen.add(JSON.parse(a.value).id); } catch { /* skip */ } }
        if (e.type === 'structs.structs.EventHashSuccess') { try { const d = JSON.parse(a.value); if (d.category === 'build') built.add(d.objectId); } catch { /* skip */ } }
      }
      // Newest first: those land at the top of the feed.
      const unknown = [...built].filter((id) => !seen.has(id) && !this.structTypes.has(id)).reverse().slice(0, 30);
      await Promise.all(unknown.map((id) => lcd.struct(id).then((r) => { this.structTypes.set(id, Number(r.Struct.type)); }).catch(() => { /* leave it unnamed */ })));
      for (const t of txs) {
        if (this.liveSeen.has(t.txhash)) continue;
        const events: ChainTxEvent[] = [];
        let signer: string | undefined, action: string | undefined;
        for (const e of t.events || []) {
          if (e.type === 'message') {
            for (const a of e.attributes) { if (a.key === 'sender' && !signer) signer = a.value; if (a.key === 'action' && !action) action = a.value; }
            continue;
          }
          if (!e.type.startsWith('structs.structs.')) continue;
          const attr = e.attributes.find((a) => a.key !== 'msg_index');
          let data: unknown = null;
          if (attr) { try { data = JSON.parse(attr.value); } catch { data = attr.value; } }
          events.push({ type: e.type.slice('structs.structs.'.length), data });
        }
        this.replayAt = Date.parse(t.timestamp) || Date.now();
        this.ingest({ height: Number(t.height), hash: t.txhash, events, signer, action, time: this.replayAt });
      }
    } catch (e) {
      console.warn('[store] backfill failed', e);
      this.backfilled = false;     // a later visit may try again
    } finally {
      this.replayAt = 0;
    }
  }

  private push(item: Omit<FeedItem, 'at'>) {
    const full: FeedItem = { ...item, at: this.replayAt || Date.now(), replay: this.replayAt ? true : undefined };
    // History lands in block order, behind anything newer that already arrived live.
    let i = this.feed.length;
    if (full.replay) while (i > 0 && this.feed[i - 1].height > full.height) i--;
    this.feed.splice(i, 0, full);
    if (this.feed.length > 300) this.feed.splice(0, this.feed.length - 300);
    safeEach(this.feedL, (f) => f(full));
  }

  /* ── Live events → state + feed ──────────────────────────────────────── */
  private ingest(tx: LiveTx) {
    const h = tx.height;
    // The frontier as it stood before this tx: an exploration's EventPlayer (carrying the new
    // planetId) comes before its EventPlanet and would otherwise hide the discovery.
    const frontier = this.maxPlanetIndex;
    const signerPlayer = tx.signer ? this.byAddress.get(tx.signer) : undefined;
    const seenStructs = new Set<string>();
    for (const e of tx.events) {
      const d = e.data;
      if (!d || typeof d !== 'object') continue;
      switch (e.type) {
        case 'EventPlayer': {
          const p = d as RawPlayer;
          // History is older than the roster just read: it neither overwrites state nor counts as new.
          if (!p.id || this.replayAt) break;
          // Before the roster loads every commander looks new; only after it do arrivals count.
          const isNew = this.coreLoaded && !this.players.has(p.id);
          this.putPlayer(p);
          safeEach(this.changeL, (f) => f({ kind: 'player', id: p.id }));
          if (isNew) this.push({ kind: 'player', text: `New commander ${p.name || p.id} came online`, playerId: p.id, planetId: p.planetId || undefined, height: h, tone: 'player' });
          break;
        }
        case 'EventPlanet': {
          const r = d as RawPlanet;
          if (!r.id) break;
          if (this.replayAt) {
            // History: narrate a world that has since been spent, change nothing.
            if (!(r.status === 'active' || r.status === '0')) this.push({ kind: 'other', text: `Planet ${r.id} is spent: ore exhausted, the world is lost`, planetId: r.id, height: h, tone: 'warn' });
            break;
          }
          const isNew = (this.coreLoaded || this.planetsLoaded) && !this.planets.has(r.id) && idIndex(r.id) > frontier;
          const lite = this.putPlanet(r);
          safeEach(this.planetL, (f) => f([lite]));
          safeEach(this.changeL, (f) => f({ kind: 'planet', id: r.id }));
          if (isNew) this.push({ kind: 'explore', text: `${this.playerName(r.owner)} discovered planet ${r.id}`, planetId: r.id, playerId: r.owner, height: h, tone: 'neutral' });
          else if (!lite.active) this.push({ kind: 'other', text: `Planet ${r.id} is spent: ore exhausted, the world is lost`, planetId: r.id, height: h, tone: 'warn' });
          break;
        }
        case 'EventFleet': {
          const f = d as RawFleet;
          // History can't be compared with today's fleet state: skip it rather than invent moves.
          if (!f.id || this.replayAt) break;
          const prev = this.fleets.get(f.id);
          this.fleets.set(f.id, f);
          safeEach(this.changeL, (fn) => fn({ kind: 'fleet', id: f.id }));
          if (prev && (prev.status !== f.status || prev.locationId !== f.locationId)) {
            const home = this.playerPlanet(f.owner);
            if (f.status === 'away') this.push({ kind: 'fleet', text: `${this.playerName(f.owner)}'s fleet jumped to ${f.locationId}`, planetId: f.locationId, toPlanetId: f.locationId, playerId: f.owner, height: h, tone: 'enemy' });
            else this.push({ kind: 'fleet', text: `${this.playerName(f.owner)}'s fleet returned home`, planetId: home || f.locationId, playerId: f.owner, height: h, tone: 'player' });
          }
          break;
        }
        case 'EventStruct': {
          const s = d as { id: string; type: string; owner: string; locationType: string; locationId: string; operatingAmbit: string };
          if (!s.id || seenStructs.has(s.id)) break;
          seenStructs.add(s.id);
          this.structTypes.set(s.id, Number(s.type));
          if (this.structTypes.size > 5000) this.structTypes.delete(this.structTypes.keys().next().value!);
          // A build initiation emits the struct with a fresh id; moves re-emit it.
          if (tx.action?.includes('StructBuildInitiate')) {
            const t = typeOf(s.type);
            this.push({ kind: 'build', text: `${this.playerName(s.owner)} began building ${t ? t.type : 'a struct'} (${s.operatingAmbit})`, planetId: this.planetOfLocation(s.locationId), playerId: s.owner, height: h, tone: 'hint' });
          } else if (tx.action?.includes('StructMove')) {
            this.push({ kind: 'fleet', text: `${this.playerName(s.owner)} moved ${typeOf(s.type)?.type || 'a struct'} to ${s.operatingAmbit}`, planetId: this.planetOfLocation(s.locationId), playerId: s.owner, height: h, tone: 'hint' });
          }
          break;
        }
        case 'EventAttack': {
          const a = d.eventAttackDetail || d;
          const shots: any[] = a.eventAttackShotDetail || [];
          let dmg = 0, destroyed = 0, evaded = 0, blocked = 0;
          for (const s of shots) {
            dmg += Number(s.damage || 0);
            if (s.targetDestroyed) destroyed++;
            if (s.evaded) evaded++;
            if (s.blocked) blocked++;
          }
          const target = shots[0];
          const planet = this.planetOfLocation(a.attackerStructLocationId) || this.planetOfLocation(target?.targetStructLocationId);
          const who = this.playerName(a.attackerPlayerId);
          const tgt = target ? `${target.targetStructType || 'struct'} of ${this.playerName(target.targetPlayerId)}` : 'a target';
          let text = `${who}'s ${a.attackerStructType || 'struct'} fired on ${tgt}`;
          if (dmg) text += `: ${dmg} dmg`;
          if (evaded) text += ', evaded';
          if (blocked) text += ', blocked';
          if (destroyed) text += ' — DESTROYED';
          this.push({ kind: 'attack', text, planetId: planet, playerId: a.attackerPlayerId, height: h, tone: 'enemy', hash: tx.hash });
          break;
        }
        case 'EventRaid': {
          const r = d.eventRaidDetail || d;
          const fleet = this.fleets.get(r.fleetId);
          const owner = fleet?.owner;
          const status = String(r.status || '');
          const label: Record<string, string> = {
            initiated: 'began a raid on', ongoing: 'is raiding', raidSuccessful: 'breached', attackerDefeated: 'was repelled from',
            demilitarized: 'demilitarized', attackerRetreated: 'retreated from', shieldsVulnerable: 'broke the shields of',
          };
          this.push({ kind: 'raid', text: `${owner ? this.playerName(owner) : r.fleetId} ${label[status] || status} planet ${r.planetId}`, planetId: r.planetId, playerId: owner, height: h, tone: status === 'attackerDefeated' ? 'player' : 'enemy' });
          break;
        }
        case 'EventOreTheft': {
          const t = d.eventOreTheftDetail || d;
          this.push({ kind: 'theft', text: `${this.playerName(t.thiefPlayerId)} stole ${t.amount} ore from ${this.playerName(t.victimPlayerId)}`, planetId: this.playerPlanet(t.victimPlayerId), playerId: t.thiefPlayerId, height: h, tone: 'enemy' });
          break;
        }
        case 'EventOreMine': {
          const m = d.eventOreMineDetail || d;
          this.push({ kind: 'mine', text: `${this.playerName(m.playerId)} mined ${m.amount || 1} ore`, planetId: this.playerPlanet(m.playerId), playerId: m.playerId, height: h, tone: 'neutral' });
          break;
        }
        case 'EventAlphaRefine': {
          const m = d.eventAlphaRefineDetail || d;
          this.push({ kind: 'refine', text: `${this.playerName(m.playerId)} refined Alpha Matter`, planetId: this.playerPlanet(m.playerId), playerId: m.playerId, height: h, tone: 'player' });
          break;
        }
        case 'EventAlphaInfuse': {
          const m = d.eventAlphaInfuseDetail || d;
          this.push({ kind: 'infuse', text: `${this.playerName(m.playerId)} infused Alpha into a generator`, planetId: this.playerPlanet(m.playerId), playerId: m.playerId, height: h, tone: 'neutral' });
          break;
        }
        case 'EventHashSuccess': {
          const x = d.eventHashSuccessDetail || d;
          const player = signerPlayer || (x.callerAddress ? this.byAddress.get(x.callerAddress) : undefined);
          const name = player ? this.playerName(player) : 'A commander';
          const planet = x.planetId || (player ? this.playerPlanet(player) : undefined);
          if (x.category === 'build') {
            const say = (typeId?: number) => {
              const tn = typeId && typeOf(typeId) ? typeOf(typeId).type : '';
              const what = tn ? `${/^[AEIOU]/.test(tn) ? 'an' : 'a'} ${tn}` : `struct ${x.objectId}`;
              this.push({ kind: 'build', text: `${name} completed ${what}`, planetId: planet, playerId: player, height: h, tone: 'player' });
            };
            const known = this.structTypes.get(x.objectId);
            // Live and unknown: one lookup names it (history replays stay offline).
            if (!known && !this.replayAt && x.objectId) {
              lcd.struct(x.objectId).then((r) => { this.structTypes.set(x.objectId, Number(r.Struct.type)); say(Number(r.Struct.type)); }).catch(() => say());
            } else say(known);
          }
          else if (x.category === 'raid') this.push({ kind: 'raid', text: `${name} breached planet ${x.planetId}`, planetId: x.planetId, playerId: player, height: h, tone: 'enemy' });
          else if (x.category === 'mine' || x.category === 'refine') { /* EventOreMine / EventAlphaRefine narrate these */ }
          break;
        }
        case 'EventGuild': {
          // A guild founded or updated: the registry is small and rarely changes, so tell everyone.
          const g = ((d as { guild?: RawGuild }).guild ?? d) as RawGuild;
          if (!g.id || this.replayAt) break;
          const isNew = this.coreLoaded && !this.guilds.has(g.id);
          this.guilds.set(g.id, g);
          if (isNew) this.push({ kind: 'guild', text: `A new guild is founded: ${g.id}`, height: h, tone: 'neutral' });
          if (this.coreLoaded) safeEach(this.coreL, (f) => f());
          break;
        }
        case 'EventGuildBankMint':
          this.push({ kind: 'guild', text: `Guild ${d.guildId || ''} minted tokens against Alpha collateral`, height: h, tone: 'neutral' });
          break;
        default: break;
      }
    }
  }
}

export const store = new Store();
