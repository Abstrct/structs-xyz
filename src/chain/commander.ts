/* "My commander": a pinned player whose vitals ride in the top bar — the
 * battery (charge), whether the grid has them online, and ore sitting in the
 * hold where a raid can take it. Read from the LCD every few blocks. */
import { lcd, big, num, type PlayerFull } from './lcd';
import { safeEach } from '../core/util';
import { live } from './live';
import { toast } from '../core/dom';
import { audio } from '../core/audio';

const KEY = 'structs.commander';
type Fn = (s: CommanderState | null) => void;

export interface CommanderState {
  id: string; name: string; pfp: string; planetId: string;
  charge: number; online: boolean; storedOre: number; lastAction: number;
}

class Commander {
  state: CommanderState | null = null;
  private listeners = new Set<Fn>();
  private lastRead = 0;
  private reading = false;

  private lastAlert: Record<string, number> = {};
  /** Set by the app: true for players this browser commands (their alerts come from elsewhere). */
  owned: ((playerId: string) => boolean) | null = null;

  /** Desktop notifications for the pinned commander (needs permission). */
  get desktopAlerts() { try { return localStorage.getItem('structs.alerts') === '1'; } catch { return false; } }
  async setDesktopAlerts(on: boolean) {
    if (on && 'Notification' in window && Notification.permission !== 'granted') {
      const p = await Notification.requestPermission().catch(() => 'denied');
      if (p !== 'granted') { toast('Notifications were not allowed by the browser', 'warn'); on = false; }
    }
    try { localStorage.setItem('structs.alerts', on ? '1' : '0'); } catch { /* ignore */ }
    return on;
  }

  private alert(kind: string, title: string, body: string) {
    // Players your vault commands are covered by game/alerts.ts, with more detail.
    if (this.owned?.(this.id || '')) return;
    const now = Date.now();
    if (now - (this.lastAlert[kind] || 0) < 20000) return;
    this.lastAlert[kind] = now;
    toast(title + ' — ' + body, 'enemy', 6000);
    audio.stinger('vulnerable', 0.6);
    if (this.desktopAlerts && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
      try { new Notification(title, { body, tag: 'structs-' + kind }); } catch { /* ignore */ }
    }
  }

  constructor() {
    live.onTx((tx) => {
      const st = this.state;
      if (!st) return;
      for (const e of tx.events) {
        const d = e.data || {};
        if (e.type === 'EventRaid') {
          const r = d.eventRaidDetail || d;
          if (r.planetId === st.planetId && r.status !== 'attackerDefeated' && r.status !== 'attackerRetreated') this.alert('raid', 'Raid on your world', `${st.name}: raid ${r.status} on ${r.planetId}`);
        } else if (e.type === 'EventAttack') {
          const a = d.eventAttackDetail || d;
          if ((a.eventAttackShotDetail || []).some((x: { targetPlayerId?: string }) => x.targetPlayerId === st.id)) this.alert('attack', 'Under fire', `${a.attackerStructType || 'A struct'} attacked ${st.name}’s structs`);
        } else if (e.type === 'EventOreTheft') {
          const t = d.eventOreTheftDetail || d;
          if (t.victimPlayerId === st.id) this.alert('theft', 'Ore stolen', `${t.amount} ore taken from ${st.name}`);
        }
      }
    });
    live.onBlock((b) => {
      if (!this.id) return;
      if (this.state) { this.state.charge = b.height - this.state.lastAction; this.emit(); }
      if (b.height - this.lastRead >= 10) void this.read();
    });
  }

  get id(): string | null { try { return localStorage.getItem(KEY); } catch { return null; } }

  pin(id: string | null) {
    try { if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
    this.state = null;
    this.emit();
    if (id) void this.read();
  }

  onChange(f: Fn) { this.listeners.add(f); f(this.state); if (this.id && !this.state) void this.read(); return () => this.listeners.delete(f); }
  private emit() { safeEach(this.listeners, (f) => f(this.state)); }

  async read() {
    const id = this.id;
    if (!id || this.reading) return;
    this.reading = true;
    try {
      const p: PlayerFull = await lcd.player(id);
      // Secondary capacity: the substation's per-connection share (the chain's GetCapacitySecondary).
      const sub = p.Player.substationId ? await lcd.entity<{ gridAttributes?: { connectionCapacity?: string } }>('substation', p.Player.substationId).catch(() => null) : null;
      const g = p.gridAttributes || {};
      const height = live.height || (await lcd.latestHeight()).height;
      this.lastRead = height;
      if (this.id !== id) return;          // pinned someone else mid-read
      const lastAction = num(g.lastAction);
      this.state = {
        id, name: p.Player.name || id, pfp: p.Player.pfpClientRenderAttributes, planetId: p.Player.planetId,
        charge: height - lastAction, lastAction,
        online: big(g.load) + big(g.structsLoad) <= big(g.capacity) + big(sub?.gridAttributes?.connectionCapacity),
        storedOre: num(g.ore),
      };
      this.emit();
    } catch { /* keep the last reading */ } finally {
      this.reading = false;
      if (this.id && this.id !== id) void this.read();   // a new pin arrived mid-read
    }
  }
}

export const commander = new Commander();
