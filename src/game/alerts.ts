/* Alerts for everyone you command: fire on your structs, raids on your worlds, ore stolen,
 * hostile fleets in orbit, a grid tipping offline. In-app always; a desktop notification
 * too when the tab is hidden and alerts are allowed (Settings → Raid alerts). */
import { live } from '../chain/live';
import { empire } from './empire';
import { commander } from '../chain/commander';
import { store } from '../chain/store';
import { toast, banner } from '../core/dom';
import { audio } from '../core/audio';
import { goTo } from '../core/nav';

export const ALERT_KINDS: [string, string][] = [['atk', 'Under attack'], ['raid', 'Raids on your planets'], ['theft', 'Ore stolen'], ['fleet', 'Enemy fleets nearby'], ['power', 'Running out of power']];
const MUTE_KEY = 'structs.alerts.muted';
export function mutedKinds(): Set<string> { try { return new Set(JSON.parse(localStorage.getItem(MUTE_KEY) || '[]')); } catch { return new Set(); } }
export function setMuted(kind: string, muted: boolean) {
  const m = mutedKinds();
  if (muted) m.add(kind); else m.delete(kind);
  try { localStorage.setItem(MUTE_KEY, JSON.stringify([...m])); } catch { /* ignore */ }
}

const seen = new Map<string, number>();
function fire(key: string, title: string, body: string, tone: 'enemy' | 'warn' = 'enemy', big = false, go?: string) {
  const now = Date.now();
  if (mutedKinds().has(key.split(':')[0])) return;
  if (now - (seen.get(key) || 0) < 30_000) return;
  seen.set(key, now);
  if (big) { banner(title.toUpperCase(), body.toUpperCase(), 'enemy', 2600); audio.stinger('vulnerable', 0.7); } else audio.play('alert');
  toast(`${title} — ${body}`, tone, 7000, go ? { label: 'Go ▸', run: () => { goTo(go); } } : undefined);
  if (commander.desktopAlerts && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, tag: 'structs-' + key }); } catch { /* ignore */ }
  }
}

const unwrap = (d: any, k: string) => (d && typeof d[k] === 'object' ? d[k] : d) || {};

let started = false;
export function startAlerts() {
  if (started) return;
  started = true;
  live.onTx((tx) => {
    const mine = (pid?: string) => !!pid && empire.players.has(pid) && empire.commands(pid);
    for (const e of tx.events) {
      if (e.type === 'EventAttack') {
        const a = unwrap(e.data, 'eventAttackDetail');
        if (empire.isMine(a.attackerStructId)) continue;      // our own shot; the queue narrates it
        const hits = (a.eventAttackShotDetail || []).filter((s: any) => mine(s.targetPlayerId));
        if (!hits.length) continue;
        const p = empire.players.get(hits[0].targetPlayerId)!;
        const kills = hits.filter((s: any) => s.targetDestroyed).length;
        fire('atk:' + p.playerId, `${p.name} under fire`, `${a.attackerStructType || 'A struct'} hit ${hits.length} of your structs${kills ? `, ${kills} destroyed` : ''}`, 'enemy', kills > 0, tx.hash ? '/combat/' + tx.hash : '/command/' + p.playerId);
      } else if (e.type === 'EventRaid') {
        const r = unwrap(e.data, 'eventRaidDetail');
        const owner = [...empire.players.values()].find((p) => p.planetId === r.planetId && empire.commands(p.playerId));
        if (!owner) continue;
        const status = String(r.status);
        const lost = status === 'raidSuccessful';
        // The chain's raid event carries no amount; the ore is in the same tx's theft events.
        const taken = tx.events.filter((x) => x.type === 'EventOreTheft').reduce((n, x) => n + Number(unwrap(x.data, 'eventOreTheftDetail').amount || 0), 0);
        fire('raid:' + r.planetId + status, lost ? 'Raid lost' : 'Raid on your world', `${owner.name}: ${status.replace(/([A-Z])/g, ' $1').toLowerCase()}${lost ? ` · ${taken} ore taken` : ''}`, 'enemy', status === 'initiated' || lost, '/command/' + owner.playerId);
      } else if (e.type === 'EventOreTheft') {
        const t = unwrap(e.data, 'eventOreTheftDetail');
        if (mine(t.victimPlayerId)) fire('theft:' + t.victimPlayerId, 'Ore stolen', `${t.amount} ore taken from ${store.playerName(t.victimPlayerId)} by ${store.playerName(t.thiefPlayerId)}`, 'enemy', true);
      } else if (e.type === 'EventFleet') {
        const f = unwrap(e.data, 'fleet');
        if (!f.locationId || empire.isMine(f.id) || f.status !== 'away') continue;
        const host = [...empire.players.values()].find((p) => p.planetId === f.locationId && empire.commands(p.playerId));
        if (host) fire('fleet:' + f.id + host.planetId, 'Hostile fleet in orbit', `${store.playerName(f.owner)}’s fleet arrived at ${host.name}’s world`, 'enemy', true, '/planet/' + host.planetId);
      }
    }
  });
  // Grids tipping offline: compare each refresh with the last.
  const wasOnline = new Map<string, boolean>();
  empire.onChange(() => {
    for (const p of empire.players.values()) {
      if (!empire.commands(p.playerId)) continue;
      const before = wasOnline.get(p.playerId);
      if (before === true && !p.online) fire('power:' + p.playerId, 'Power overload', `${p.name}’s grid went offline — load exceeds capacity; nothing can act`, 'warn', false, '/economy');
      wasOnline.set(p.playerId, p.online);
    }
  });
}
