/* The economy's live picture, read from the LCD: every reactor (with its validator), substation,
 * allocation, provider, agreement, infusion and guild bank on chain — small sets on this
 * testnet, so we read them whole — plus, for the players this wallet controls, their grid,
 * balances and defusing stake. One shared snapshot; tabs render from it and ask for a reload
 * after their own transactions land or when the chain says something economic moved. */
import { LCD_URL, lcd, type Grid, type PlayerFull, type RawAllocation, type RawGuild, type RawInfusion, type RawPlayer, type RawProvider, type RawReactor, type RawSubstation } from '../../chain/lcd';
import { live } from '../../chain/live';
import { store } from '../../chain/store';
import { guilds, guildsNow, onGuilds, guildLabel, type GuildEntry } from '../../guild/directory';
import { wallet } from '../../wallet/wallet';
import { txq } from '../../wallet/queue';
import { safeEach } from '../../core/util';
import { big0, decOf, defusions, type BankPool, type Defusion, type GridIn } from '../../game/economy';

export interface Coin { denom: string; amount: string }
export interface Validator { address: string; moniker: string; status: string; jailed: boolean; tokens: bigint; commission: bigint; website: string }
export interface ReactorRow { id: string; validator: string; guildId: string; owner: string; defaultCommission: bigint; fuel: bigint; capacity: bigint; val: Validator | null }
export interface SubRow { id: string; owner: string; name: string; capacity: bigint; load: bigint; connections: bigint; share: bigint }
export interface AllocRow { id: string; type: string; sourceObjectId: string; destinationId: string; controller: string; creator: string; power: bigint }
export interface ProviderRow {
  id: string; substationId: string; rate: Coin; accessPolicy: string; owner: string; creator: string;
  capacityMinimum: string; capacityMaximum: string; durationMinimum: string; durationMaximum: string;
  providerPenalty: bigint; consumerPenalty: bigint; load: bigint;
}
export interface AgreementRow { id: string; providerId: string; allocationId: string; capacity: bigint; startBlock: bigint; endBlock: bigint; creator: string; owner: string }
export interface BankRow extends BankPool { guildId: string; address: string; denom: string; name: string; tag: string; unit: string; owner: string }

export interface Galaxy {
  reactors: ReactorRow[]; validators: Map<string, Validator>; subs: Map<string, SubRow>; allocs: AllocRow[];
  providers: ProviderRow[]; agreements: AgreementRow[]; infusions: RawInfusion[]; banks: BankRow[]; guilds: Map<string, RawGuild>;
  blockSeconds: number; height: number; loadedAt: number;
  /** Staking's unbonding time: how long a defusion takes. */
  unbondingSeconds: number;
}

/** One wallet account that has a player. Several accounts may share a player, so this is keyed
 * by address. `balances` are the signing account's; `primary` are the player's primary address's,
 * which is what the chain debits for bank trades and agreement collateral (GetPrimaryAccount). */
export interface Mine {
  playerId: string; account: number; address: string; label: string;
  player: RawPlayer; grid: GridIn; raw: Grid; balances: Coin[]; defusions: Defusion[]; loadedAt: number;
  primaryAddress: string; primary: Coin[];
}

async function getJson<T>(path: string, timeoutMs = 20000): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(LCD_URL + path, { signal: ctl.signal });
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new Error((body as { message?: string } | null)?.message || `LCD ${r.status}`);
    return body as T;
  } finally { clearTimeout(t); }
}

/** Up to `n` reads at once. */
async function pooled<T, R>(items: T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await f(items[k]); } }));
  return out;
}

const gridOf = (kind: string, id: string) => lcd.entity<{ gridAttributes?: Grid }>(kind, id).then((r) => r.gridAttributes || {}).catch(() => ({} as Grid));

export async function balancesOf(address: string): Promise<Coin[]> {
  const r = await getJson<{ balances: Coin[] }>(`/cosmos/bank/v1beta1/balances/${encodeURIComponent(address)}?pagination.limit=200`);
  return r.balances || [];
}
export const amountOf = (coins: Coin[] | undefined, denom: string) => big0(coins?.find((c) => c.denom === denom)?.amount);

/** Seconds per block over the last 1,000 blocks (≈5.3 s on this testnet); 6 if unreadable. */
async function measureBlockTime(): Promise<{ seconds: number; height: number }> {
  try {
    const top = await lcd.latestHeight();
    const back = await getJson<{ block: { header: { time: string } } }>(`/cosmos/base/tendermint/v1beta1/blocks/${top.height - 1000}`);
    const s = (Date.parse(top.time) - Date.parse(back.block.header.time)) / 1000 / 1000;
    return { seconds: s > 0.5 && s < 60 ? s : 6, height: top.height };
  } catch { return { seconds: 6, height: live.height || 0 }; }
}

/** A guild bank's name, tag and token unit: from the guild's own guild.json when it is known, else the chain's. */
function bankLabels(guildId: string, directory: GuildEntry[]): Pick<BankRow, 'name' | 'tag' | 'unit'> {
  const entry = directory.find((d) => d.id === guildId);
  const label = guildLabel(guildId);
  const unitName = entry?.meta?.denom?.['6'] || entry?.meta?.denom?.['0'] || '';
  return { name: entry?.meta?.name || label.name, tag: entry?.meta?.tag || label.tag, unit: unitName ? unitName.toUpperCase() : (entry?.meta?.tag || label.tag) };
}

async function loadGalaxy(): Promise<Galaxy> {
  type RawProviderFull = RawProvider & { creator: string; providerCancellationPenalty: string; consumerCancellationPenalty: string };
  type RawAgreement = { id: string; providerId: string; allocationId: string; capacity: string; startBlock: string; endBlock: string; creator: string; owner: string };
  type RawVal = { operator_address: string; jailed: boolean; status: string; tokens: string; description: { moniker: string; website: string }; commission: { commission_rates: { rate: string } } };
  type RawGuildFull = RawGuild & { bankConvertInFee?: string; bankConvertOutFee?: string };

  // The guild directory (each guild's own guild.json: names, tags, token units) is never waited on:
  // one slow host would hold the whole screen. What is already known labels the banks now; the
  // rest fills in when it arrives (EconomyData.relabel).
  const directory = guildsNow() || [];
  void guilds().catch(() => { /* the chain's names stand */ });
  const [reactors, subs, allocs, providers, agreements, infusions, guildList, vals, bankAddrs, clock, staking] = await Promise.all([
    lcd.list<RawReactor>('reactor', 'Reactor'),
    lcd.list<RawSubstation>('substation', 'Substation'),
    lcd.list<RawAllocation & { creator: string }>('allocation', 'Allocation'),
    lcd.list<RawProviderFull>('provider', 'Provider'),
    lcd.list<RawAgreement>('agreement', 'Agreement'),
    lcd.list<RawInfusion>('infusion', 'Infusion'),
    lcd.list<RawGuildFull>('guild', 'Guild'),
    getJson<{ validators: RawVal[] }>('/cosmos/staking/v1beta1/validators?pagination.limit=500').then((r) => r.validators || []).catch(() => [] as RawVal[]),
    getJson<{ internalAddressAssociation: { address: string; objectId: string }[] }>('/structs/guild_bank_collateral_address?pagination.limit=500').then((r) => r.internalAddressAssociation || []).catch(() => []),
    measureBlockTime(),
    getJson<{ params: { unbonding_time: string } }>('/cosmos/staking/v1beta1/params').then((r) => parseInt(r.params?.unbonding_time || '', 10) || 345_600).catch(() => 345_600),
  ]);

  const validators = new Map<string, Validator>();
  for (const v of vals) validators.set(v.operator_address, {
    address: v.operator_address, moniker: v.description?.moniker || v.operator_address.slice(0, 16), status: v.status, jailed: !!v.jailed,
    tokens: big0(v.tokens), commission: decOf(v.commission?.commission_rates?.rate), website: v.description?.website || '',
  });

  // Grid attributes come per entity; a few dozen reads, six at a time.
  const [rGrids, sGrids, aGrids, pGrids] = await Promise.all([
    pooled(reactors, 6, (r) => gridOf('reactor', r.id)),
    pooled(subs, 6, (s) => gridOf('substation', s.id)),
    pooled(allocs, 6, (a) => gridOf('allocation', a.id)),
    pooled(providers, 6, (p) => gridOf('provider', p.id)),
  ]);

  const subMap = new Map<string, SubRow>();
  subs.forEach((s, i) => {
    const g = sGrids[i];
    subMap.set(s.id, { id: s.id, owner: s.owner, name: s.name, capacity: big0(g.capacity), load: big0(g.load), connections: big0(g.connectionCount), share: big0(g.connectionCapacity) });
  });

  const guildMap = new Map<string, RawGuild>(guildList.map((g) => [g.id, g]));
  const supplies = await pooled(bankAddrs, 4, async (b) => {
    const denom = `uguild.${b.objectId}`;
    const [supply, coll] = await Promise.all([
      getJson<{ amount: Coin }>(`/cosmos/bank/v1beta1/supply/by_denom?denom=${encodeURIComponent(denom)}`).then((r) => big0(r.amount?.amount)).catch(() => 0n),
      balancesOf(b.address).then((c) => amountOf(c, 'ualpha')).catch(() => 0n),
    ]);
    return { supply, coll };
  });
  const banks: BankRow[] = bankAddrs.map((b, i) => {
    const g = guildList.find((x) => x.id === b.objectId);
    return {
      guildId: b.objectId, address: b.address, denom: `uguild.${b.objectId}`, ...bankLabels(b.objectId, directory), owner: g?.owner || '',
      collateral: supplies[i].coll, supply: supplies[i].supply, inFee: decOf(g?.bankConvertInFee), outFee: decOf(g?.bankConvertOutFee),
    };
  });

  return {
    reactors: reactors.map((r, i) => ({
      id: r.id, validator: r.validator, guildId: r.guildId, owner: r.owner, defaultCommission: decOf(r.defaultCommission),
      fuel: big0(rGrids[i].fuel), capacity: big0(rGrids[i].capacity), val: validators.get(r.validator) ?? null,
    })).sort((a, b) => (b.fuel > a.fuel ? 1 : b.fuel < a.fuel ? -1 : 0)),
    validators, subs: subMap,
    allocs: allocs.map((a, i) => ({ id: a.id, type: a.type, sourceObjectId: a.sourceObjectId, destinationId: a.destinationId, controller: a.controller, creator: a.creator, power: big0(aGrids[i].power) })),
    providers: providers.map((p, i) => ({
      id: p.id, substationId: p.substationId, rate: p.rate, accessPolicy: p.accessPolicy, owner: p.owner, creator: p.creator,
      capacityMinimum: p.capacityMinimum, capacityMaximum: p.capacityMaximum, durationMinimum: p.durationMinimum, durationMaximum: p.durationMaximum,
      providerPenalty: decOf(p.providerCancellationPenalty), consumerPenalty: decOf(p.consumerCancellationPenalty), load: big0(pGrids[i].load),
    })),
    agreements: agreements.map((a) => ({ id: a.id, providerId: a.providerId, allocationId: a.allocationId, capacity: big0(a.capacity), startBlock: big0(a.startBlock), endBlock: big0(a.endBlock), creator: a.creator, owner: a.owner })),
    infusions, banks, guilds: guildMap,
    blockSeconds: clock.seconds, height: clock.height, loadedAt: Date.now(), unbondingSeconds: staking,
  };
}

async function loadMine(playerId: string, account: number, address: string, label: string): Promise<Mine> {
  const [pf, bals, unb] = await Promise.all([
    lcd.player(playerId) as Promise<PlayerFull>,
    balancesOf(address).catch(() => [] as Coin[]),
    getJson<Parameters<typeof defusions>[0]>(`/cosmos/staking/v1beta1/delegators/${encodeURIComponent(address)}/unbonding_delegations`).catch(() => ({})),
  ]);
  const g = pf.gridAttributes || {};
  // The chain's online test adds the substation's per-connection share (capacitySecondary), not
  // the player's own connectionCapacity record (which stays 0): read it from the substation.
  const primaryAddress = pf.Player.primaryAddress || address;
  const [sub, primary] = await Promise.all([
    pf.Player.substationId ? gridOf('substation', pf.Player.substationId) : Promise.resolve({} as Grid),
    primaryAddress === address ? Promise.resolve(bals) : balancesOf(primaryAddress).catch(() => [] as Coin[]),
  ]);
  return {
    playerId, account, address, label, player: pf.Player, raw: g, balances: bals, defusions: defusions(unb), loadedAt: Date.now(), primaryAddress, primary,
    grid: { capacity: big0(g.capacity), load: big0(g.load), structsLoad: big0(g.structsLoad), connectionCapacity: big0(sub.connectionCapacity) },
  };
}

type Fn = () => void;

/** Events that can move the economy; their payloads are checked for reactor (3-), substation (4-),
 * allocation (6-), infusion (7-), provider (10-) or agreement (11-) ids, or grid records of those. */
const ECON_EVENTS = /Grid|Allocation|Substation|Provider|Agreement|Infusion|Reactor|GuildBank|Delegat|Bank/i;

class EconomyData {
  galaxy: Galaxy | null = null;
  galaxyError = '';
  /** Per wallet address (not per player: accounts can share one). */
  mine = new Map<string, Mine>();
  /** Balances of every wallet address (incl. accounts without a player yet). */
  wallets = new Map<string, Coin[]>();
  loading = false;
  private listeners = new Set<Fn>();
  private gp: Promise<void> | null = null;
  private mp = new Map<string, Promise<void>>();
  /** Unbinds the live triggers; set while anyone listens. */
  private unbind: Fn | null = null;

  /** Listening keeps the snapshot fresh from the chain; the last listener leaving stops all reads. */
  onChange(f: Fn) {
    this.listeners.add(f);
    this.bind();
    return () => { if (this.listeners.delete(f) && !this.listeners.size) { this.unbind?.(); this.unbind = null; } };
  }
  private emit() { safeEach(this.listeners, (f) => f()); }
  /** The directory arrived (or changed): the banks take its names and units; nothing is re-read. */
  private relabel = (list: GuildEntry[]) => {
    const g = this.galaxy;
    if (!g || !list.length) return;
    let changed = false;
    for (const b of g.banks) {
      const l = bankLabels(b.guildId, list);
      if (l.name !== b.name || l.tag !== b.tag || l.unit !== b.unit) { Object.assign(b, l); changed = true; }
    }
    if (changed) this.emit();
  };
  private unGuilds: Fn | null = null;

  /** Live triggers, bound while a screen listens (the full economy is a dozen LCD lists: not for nobody). */
  private bind() {
    if (this.unbind || typeof window === 'undefined') return;
    let timer = 0;
    // Someone else's change waits until the last read is 20 s old (busy blocks would otherwise
    // keep us reading); our own lands after a short beat.
    const soon = (urgent = false) => {
      if (timer) return;
      const age = this.galaxy ? Date.now() - this.galaxy.loadedAt : Infinity;
      timer = window.setTimeout(() => { timer = 0; void this.refresh(); }, urgent ? 2500 : Math.max(2500, 20_000 - age));
    };
    const offs: Fn[] = [];
    offs.push(live.onTx((tx) => {
      const mine = new Set(wallet.accounts.map((a) => a.address));
      if (tx.signer && mine.has(tx.signer)) { soon(true); return; }
      for (const e of tx.events) {
        if (!ECON_EVENTS.test(e.type)) continue;
        const s = JSON.stringify(e.data ?? '');
        if (/"(3|4|6|7|10|11)-\d+"/.test(s) || /"\d+-(3|4|6|10|11)-\d+"/.test(s)) { soon(); return; }
      }
    }));
    offs.push(txq.onSettled(() => soon(true)), wallet.onChange(() => { void this.loadMine(); }));
    // Backstops: our players' grids every dozen blocks, the whole economy every sixty.
    let mineAt = 0;
    offs.push(live.onBlock((b) => {
      if (this.galaxy && b.height - this.galaxy.height > 60) soon();
      else if (b.height - mineAt >= 12) { mineAt = b.height; void this.loadMine(); }
    }));
    this.unbind = () => { offs.splice(0).forEach((f) => f()); clearTimeout(timer); timer = 0; };
  }

  /** Reload the galaxy and our players; callers render from the fields. */
  async refresh() { await Promise.all([this.loadGalaxy(), this.loadMine()]); }

  loadGalaxy(): Promise<void> {
    if (this.gp) return this.gp;
    this.loading = true;
    this.gp = (async () => {
      // The directory may have changed while the chain was read: label the new banks from the latest.
      try { this.galaxy = await loadGalaxy(); this.galaxyError = ''; this.relabel(guildsNow() || []); this.unGuilds ??= onGuilds(this.relabel); }
      catch (e) { this.galaxyError = (e as Error).message || 'LCD unreachable'; }
      finally { this.loading = false; this.gp = null; this.emit(); }
    })();
    return this.gp;
  }

  /** Every account in the wallet: balances for all, grid and defusions for those with a player. */
  async loadMine() {
    const accts = wallet.accounts;
    for (const k of [...this.mine.keys()]) if (!accts.some((a) => a.address === k && a.playerId)) this.mine.delete(k);
    await Promise.all(accts.map(async (a) => {
      const key = a.address;
      if (this.mp.has(key)) return this.mp.get(key);
      const p = (async () => {
        try {
          if (a.playerId) {
            const m = await loadMine(a.playerId, a.index, a.address, a.label);
            this.mine.set(a.address, m);
            this.wallets.set(a.address, m.balances);
          } else { this.mine.delete(a.address); this.wallets.set(a.address, await balancesOf(a.address)); }
        } catch (e) { console.warn('[economy] read failed', key, e); }
        finally { this.mp.delete(key); }
      })();
      this.mp.set(key, p);
      return p;
    }));
    this.emit();
  }

  /** A player's view for anyone (read-only for players we don't control). */
  async peek(playerId: string): Promise<Mine | null> {
    const own = wallet.byPlayer(playerId);
    if (own) { if (!this.minePlayer(playerId)) await this.loadMine(); return this.minePlayer(playerId); }
    try {
      const pf = await lcd.player(playerId);
      return await loadMine(playerId, -1, pf.Player.primaryAddress, pf.Player.name || playerId);
    } catch { return null; }
  }

  /* ── Lookups ─────────────────────────────────────────────────────────── */
  /** A player's snapshot through any of our accounts, preferring the one that is its primary address. */
  minePlayer(playerId: string): Mine | null {
    let best: Mine | null = null;
    for (const m of this.mine.values()) if (m.playerId === playerId && (!best || m.address === m.primaryAddress)) best = m;
    return best;
  }
  /** One snapshot per player we control (the primary-address account where we hold it). */
  minePlayers(): Mine[] {
    const out = new Map<string, Mine>();
    for (const m of this.mine.values()) { const b = out.get(m.playerId); if (!b || m.address === m.primaryAddress) out.set(m.playerId, m); }
    return [...out.values()];
  }
  reactorByValidator(v: string) { return this.galaxy?.reactors.find((r) => r.validator === v) ?? null; }
  reactor(id: string) { return this.galaxy?.reactors.find((r) => r.id === id) ?? null; }
  bank(guildId: string) { return this.galaxy?.banks.find((b) => b.guildId === guildId) ?? null; }
  provider(id: string) { return this.galaxy?.providers.find((p) => p.id === id) ?? null; }
  /** Outgoing allocations of an object, in the chain's cascade order. */
  allocsFrom(id: string) { return (this.galaxy?.allocs ?? []).filter((a) => a.sourceObjectId === id); }
  allocsInto(id: string) { return (this.galaxy?.allocs ?? []).filter((a) => a.destinationId === id); }
  infusionsOf(address: string) { return (this.galaxy?.infusions ?? []).filter((i) => i.address === address); }
  /** Players connected to a substation (needs the store's player roster). */
  connected(subId: string): RawPlayer[] { const out: RawPlayer[] = []; for (const p of store.players.values()) if (p.substationId === subId) out.push(p); return out; }
  /** Display name for a denom: alpha, a guild's token, or the raw denom. */
  denomLabel(denom: string): string {
    if (denom === 'ualpha') return 'alpha';
    const b = this.galaxy?.banks.find((x) => x.denom === denom);
    return b ? b.unit : denom;
  }
}

export const eco = new EconomyData();
