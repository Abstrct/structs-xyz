/* GRASS events in words: a line a person can read, with the ids in it marked so the UI can
 * link them (players and planets open their screens, guilds open Intel). Pure apart from
 * the name lookups, which callers can replace (tests do). */
import type { GrassEvent } from './grass';
import { formatAlpha, formatPower, humanize } from '../core/util';

export type Tone = 'player' | 'enemy' | 'neutral' | 'warn' | 'hint';
export type Group = 'combat' | 'fleet' | 'struct' | 'grid' | 'economy' | 'people' | 'market' | 'block' | 'other';
export interface Part { text: string; id?: string }
export interface Described { group: Group; tone: Tone; tag: string; parts: Part[]; stub: boolean }
export interface Names { player(id: string): string; fleetOwner?(fleetId: string): string | undefined }

export const GROUPS: { id: Group; label: string }[] = [
  { id: 'combat', label: 'Combat' }, { id: 'fleet', label: 'Fleets' }, { id: 'struct', label: 'Structs' },
  { id: 'grid', label: 'Grid' }, { id: 'economy', label: 'Economy' }, { id: 'people', label: 'People' }, { id: 'market', label: 'Market' },
];

const COMBAT = new Set(['struct_attack', 'struct_health', 'raid_status', 'block_raid_start', 'shield_change', 'struct_defense_add', 'struct_defense_remove']);
const FLEET = new Set(['fleet_arrive', 'fleet_depart', 'fleet_advance']);

export function groupOf(e: Pick<GrassEvent, 'kind' | 'category'>): Group {
  if (e.kind === 'block') return 'block';
  if (e.kind === 'grid') return 'grid';
  if (e.kind === 'inventory') return 'economy';
  if (e.kind === 'player' || e.kind === 'guild' || e.kind === 'address') return 'people';
  if (e.kind === 'provider' || e.kind === 'agreement') return 'market';
  if (COMBAT.has(e.category)) return 'combat';
  if (FLEET.has(e.category)) return 'fleet';
  if (e.kind === 'planet') return 'struct';
  return 'other';
}

/** Where an id leads in the app, if anywhere. */
export function hrefFor(id: string): string | null {
  if (/^1-\d+$/.test(id)) return '/player/' + id;
  if (/^2-\d+$/.test(id)) return '/planet/' + id;
  if (/^0-\d+$/.test(id)) return '/intel/guild/' + id;
  return null;
}

const STATUS_BITS: [number, string][] = [[1, 'materialized'], [2, 'built'], [4, 'online'], [8, 'stored'], [16, 'hidden'], [32, 'destroyed'], [64, 'locked']];

/** What changed between two struct status masks, as a verb phrase. */
export function statusChange(now: number, old: number): { text: string; tone: Tone } {
  const gained = now & ~old, lost = old & ~now;
  if (gained & 32) return { text: 'was destroyed', tone: 'enemy' };
  if (gained & 2 && gained & 4) return { text: 'finished building and came online', tone: 'player' };
  if (gained & 2) return { text: 'finished building', tone: 'player' };
  if (gained & 4) return { text: 'came online', tone: 'player' };
  if (lost & 4) return { text: 'went offline', tone: 'warn' };
  if (gained & 16) return { text: 'went into stealth', tone: 'hint' };
  if (lost & 16) return { text: 'dropped stealth', tone: 'warn' };
  if (gained & 1) return { text: 'materialized', tone: 'hint' };
  if (gained & 8) return { text: 'was stored', tone: 'hint' };
  if (gained & 64) return { text: 'was locked', tone: 'warn' };
  const flags = STATUS_BITS.filter(([b]) => now & b).map(([, n]) => n).join(', ');
  return { text: `status ${flags || 'none'}`, tone: 'hint' };
}

const RAID: Record<string, [string, Tone]> = {
  initiated: ['began a raid on', 'enemy'], ongoing: ['is raiding', 'enemy'], shieldsVulnerable: ['broke the shields of', 'enemy'],
  raidSuccessful: ['breached', 'enemy'], attackerDefeated: ['was repelled from', 'player'], attackerRetreated: ['retreated from', 'warn'], demilitarized: ['demilitarized', 'warn'],
};

const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0));
const fmt = (v: number) => (Number.isFinite(v) ? v.toLocaleString('en-US') : '?');

/** An amount in its denom's units: ualpha on the gram ladder, ore in grams, guild tokens raw. */
export function amountText(amountP: unknown, denom: string): string {
  const raw = String(amountP ?? '0');
  if (denom === 'ualpha') return formatAlpha(raw) + ' Alpha';
  if (denom === 'ore') return fmt(n(raw)) + ' ore';
  if (denom.startsWith('uguild.')) return `${fmt(n(raw) / 1e6)} ${denom.slice(7)} tokens`;
  return `${fmt(n(raw))} ${denom}`;
}

const POWER_ATTRS = new Set(['fuel', 'capacity', 'load', 'structsLoad', 'power', 'connectionCapacity']);

export function describe(e: GrassEvent, names: Names): Described {
  const d = e.detail, data = e.data;
  const group = groupOf(e);
  const who = (id?: string): Part[] => (id ? [{ text: names.player(id), id }] : [{ text: 'Someone' }]);
  const id = (x: unknown): Part => ({ text: String(x ?? '?'), id: typeof x === 'string' ? x : undefined });
  const t = (text: string): Part => ({ text });
  const out = (tone: Tone, tag: string, parts: Part[]): Described => ({ group, tone, tag, parts, stub: e.stub });
  if (e.stub) return out('hint', humanize(e.category), [t('Large update for '), ...(e.planetId ? [id(e.planetId)] : e.playerId ? who(e.playerId) : [t(e.subject)]), t(' (details withheld; re-read)')]);

  switch (e.category) {
    case 'struct_status': {
      const c = statusChange(n(d.status), n(d.status_old));
      return out(c.tone, 'Struct', [...who(e.playerId), t('’s struct '), id(d.struct_id), t(' ' + c.text + ' on '), id(e.planetId)]);
    }
    case 'struct_health': {
      const h = n(d.health), o = n(d.health_old);
      if (o === 0 && h > 0) return out('hint', 'Struct', [...who(e.playerId), t('’s struct '), id(d.struct_id), t(` assembled at ${h} health`)]);
      if (h < o) return out(h === 0 ? 'enemy' : 'warn', 'Hit', [...who(e.playerId), t('’s struct '), id(d.struct_id), t(` took ${o - h} damage (${h} left) on `), id(e.planetId)]);
      return out('player', 'Repair', [...who(e.playerId), t('’s struct '), id(d.struct_id), t(` repaired ${o} → ${h}`)]);
    }
    case 'struct_block_build_start':
      return out('hint', 'Build', [...who(e.playerId), t(' began building struct '), id(d.struct_id), t(' on '), id(e.planetId)]);
    case 'struct_block_ore_mine_start':
      return out('neutral', 'Mine', [...who(e.playerId), t(' started a mining cycle on '), id(d.planet_id || e.planetId)]);
    case 'struct_block_ore_refine_start':
      return out('neutral', 'Refine', [...who(e.playerId), t(' started a refining cycle on '), id(d.planet_id || e.planetId)]);
    case 'struct_move':
      return out('hint', 'Move', [...who(e.playerId), t(' moved struct '), id(d.struct_id), t(` to ${d.ambit || '?'} slot ${d.slot ?? '?'}`)]);
    case 'struct_defense_add':
      return out('player', 'Guard', [...who(e.playerId), t('’s struct '), id(d.defender_struct_id), t(' now guards '), id(d.protected_struct_id)]);
    case 'struct_defense_remove':
      return out('warn', 'Guard', [...who(e.playerId), t('’s struct '), id(d.defender_struct_id), t(' stopped guarding '), id(d.protected_struct_id)]);
    case 'shield_change': {
      const s = n(d.planetary_shield), o = n(d.planetary_shield_old);
      return out(s < o ? 'warn' : 'player', 'Shield', [t('Planetary shield on '), id(e.planetId), t(` ${s < o ? 'fell' : 'rose'} ${fmt(o)} → ${fmt(s)}`)]);
    }
    case 'block_raid_start':
      return out('enemy', 'Raid', [t('Raid clock started on '), id(e.planetId), t(` at block ${fmt(n(d.block_start_raid))}`)]);
    case 'raid_status': {
      const [verb, tone] = RAID[String(d.status)] || [`raid ${humanize(String(d.status))} on`, 'enemy' as Tone];
      const owner = names.fleetOwner?.(String(d.fleet_id || ''));
      const seized = n(d.seized_ore) ? ` — ${fmt(n(d.seized_ore))} ore seized` : '';
      return out(tone, 'Raid', [...(owner ? who(owner) : [t('Fleet '), id(d.fleet_id)]), t(` ${verb} `), id(d.planet_id || e.planetId), t(seized)]);
    }
    case 'struct_attack': {
      const a = (d.eventAttackDetail || d) as Record<string, any>;
      const shots: Record<string, any>[] = Array.isArray(a.eventAttackShotDetail) ? a.eventAttackShotDetail : [];
      let dmg = 0, kills = 0;
      for (const s of shots) { dmg += n(s.damage); if (s.targetDestroyed) kills++; }
      const attacker = a.attackerPlayerId as string | undefined;
      return out('enemy', 'Attack', [...who(attacker || e.playerId), t(`’s ${a.attackerStructType || 'struct'} fired ${shots.length || ''} ${shots.length === 1 ? 'shot' : 'shots'}`.replace('  ', ' ')),
        t(dmg ? `: ${dmg} dmg` : ''), t(kills ? `, ${kills} destroyed` : ''), t(' on '), id(e.planetId)]);
    }
    case 'fleet_arrive':
      return out('enemy', 'Fleet', [t('Fleet '), id(d.fleet_id), ...(names.fleetOwner?.(String(d.fleet_id)) ? [t(' ('), ...who(names.fleetOwner!(String(d.fleet_id))), t(')')] : []), t(' arrived at '), id(e.planetId)]);
    case 'fleet_depart':
      return out('hint', 'Fleet', [t('Fleet '), id(d.fleet_id), t(' left '), id(e.planetId)]);
    case 'fleet_advance':
      return out('warn', 'Fleet', [t('Fleet '), id(d.fleet_id), t(' advanced in the queue at '), id(e.planetId)]);
  }

  switch (e.kind) {
    case 'grid': {
      const attr = String(data.attribute_type || e.category);
      const obj = e.objectId || '?';
      const owner = e.playerId && e.playerId !== obj ? [t(' ('), ...who(e.playerId), t(')')] : [];
      const subj: Part[] = obj.startsWith('1-') ? who(obj) : [t(String(data.object_type || 'object') + ' '), id(obj), ...owner];
      if (attr === 'lastAction') return out('hint', 'Charge', [...subj, t(' spent their charge')]);
      if (attr === 'ore') {
        const v = n(data.value_p ?? data.value), o = n(data.value_old_p ?? data.value_old);
        return out(v > o ? 'neutral' : 'warn', 'Ore', [...subj, t(` ore ${fmt(o)} → ${fmt(v)}`)]);
      }
      if (POWER_ATTRS.has(attr)) {
        const v = data.value_p ?? data.value, o = data.value_old_p ?? data.value_old;
        return out('hint', 'Power', [...subj, t(` ${humanize(attr).toLowerCase()} ${formatPower(String(o ?? 0))} → ${formatPower(String(v ?? 0))}`)]);
      }
      return out('hint', 'Grid', [...subj, t(` ${humanize(attr).toLowerCase()} ${data.value_old ?? '?'} → ${data.value ?? '?'}`)]);
    }
    case 'inventory': {
      const action = String(data.action || e.category);
      const amount = amountText(data.amount_p ?? data.amount, String(data.denom || ''));
      const cp = data.counterparty_player_id && data.counterparty_player_id !== 'noPlayer' ? String(data.counterparty_player_id) : null;
      const verb: Record<string, string> = { sent: 'sent', received: 'received', mined: 'mined', refined: 'refined', seized: 'seized', forfeited: 'lost', infused: 'infused', minted: 'minted', burned: 'burned',
        defusion_started: 'began defusing', defusion_completed: 'finished defusing', defusion_cancelled: 'cancelled defusing', migrated: 'migrated', genesis: 'started with', diversion_started: 'began diverting', diversion_completed: 'diverted' };
      const tone: Tone = action === 'seized' ? 'enemy' : action === 'forfeited' ? 'warn' : action === 'refined' || action === 'received' ? 'player' : 'neutral';
      const tail: Part[] = cp ? [t(action === 'received' ? ' from ' : action === 'sent' ? ' to ' : ' · '), ...who(cp)] : [];
      return out(tone, humanize(action), [...who(e.playerId), t(` ${verb[action] || humanize(action).toLowerCase()} ${amount}`), ...tail]);
    }
    case 'player': {
      if (e.category === 'player_address') return out('hint', 'Address', [...who(e.playerId), t(` address ${String(data.status || 'updated')}`)]);
      const fresh = data.created_at && data.created_at === data.updated_at;
      return out(fresh ? 'player' : 'hint', fresh ? 'Joined' : 'Player', fresh
        ? [t('New commander '), ...who(e.playerId), t(' joined '), id(e.guildId)]
        : [...who(e.playerId), t(' updated'), ...(data.username ? [t(` (“${String(data.username).slice(0, 40)}”)`)] : [])]);
    }
    case 'guild':
      if (e.category === 'guild_membership') return out('neutral', 'Guild', [...who(e.playerId), t(` membership ${humanize(String(data.status || data.join_type || 'changed')).toLowerCase()} in `), id(e.guildId)]);
      return out('neutral', 'Guild', [t('Guild '), id(e.guildId), t(e.category === 'guild_meta' ? ' updated its profile' : ' changed on chain')]);
    case 'address': return out('hint', 'Device', [t('A device asked to join an account')]);
    case 'provider': return out('neutral', 'Market', [t('Energy provider '), id(data.id), t(' updated')]);
    case 'agreement': return out('neutral', 'Market', [t('Energy agreement '), id(data.id), t(' updated')]);
    case 'block': return out('hint', 'Block', [t(`Block ${fmt(n(e.height))}`)]);
  }
  return out('hint', humanize(e.category), [t(e.subject)]);
}
