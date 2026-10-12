/* Enlisting in the background: the vault is made (if there is none), the guild is asked to create
 * the player, and a planet is claimed — while the commander is already in the game. The guild's
 * signer takes a block or several; this tracks the steps for whoever wants to show them, and
 * survives a reload (the pending request is kept and resumed on boot). */
import { wallet } from '../wallet/wallet';
import { GuildBlockedError } from '../guild/transport';
import { explore, joinGuild } from './onboard';
import { lcd } from '../chain/lcd';
import { empire } from './empire';
import { toast } from '../core/dom';
import { audio } from '../core/audio';
import { safeEach } from '../core/util';

export interface Enlistment {
  index: number;
  name: string;
  guildId: string;
  guildName: string;
  status: 'running' | 'done' | 'failed';
  steps: string[];
  error?: string;
  playerId?: string;
}

const KEY = 'structs.enlist.pending';
type Pending = Pick<Enlistment, 'index' | 'name' | 'guildId' | 'guildName'>;

let current: Enlistment | null = null;
const listeners = new Set<() => void>();
const emit = () => safeEach(listeners, (f) => f());

export const enlisting = {
  get current(): Enlistment | null { return current; },
  get running(): boolean { return current?.status === 'running'; },
  onChange(f: () => void) { listeners.add(f); return () => listeners.delete(f); },
};

/** Name a commander and join a guild. Makes the vault first when there is none. Resolves once the
 * request is under way (not when the player lands): the rest happens in the background. */
export async function enlist(name: string, guildId: string, guildName: string, index = wallet.activeIndex) {
  if (current?.status === 'running') throw new Error('Already enlisting');
  if (wallet.state === 'empty') await wallet.createInstant();
  // Another tab made the vault after this one booted: it opens the same way here.
  if (!wallet.unlocked && wallet.deviceSealed) await wallet.restore();
  if (!wallet.unlocked) throw new Error('Unlock the vault to enlist');
  wallet.setAccount(index, { label: name });
  const p: Pending = { index, name, guildId, guildName };
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* resumes only this visit */ }
  void run(p);
}

/** On boot: a signup that was waiting for the guild when the page closed picks up again. */
export function resumeEnlist() {
  let p: Pending | null = null;
  try { p = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { p = null; }
  if (!p || current) return;
  const a = wallet.account(p.index);
  if (!a || !wallet.unlocked) { if (!a) clear(); return; }
  void run(p);
}

export function retryEnlist() {
  const c = current;
  if (c?.status === 'failed') void run({ index: c.index, name: c.name, guildId: c.guildId, guildName: c.guildName });
}

function clear() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }

/** One tab at a time talks to the guild (a second signup or a second explore would misfire). A tab
 * that finds another already at it just watches for the player to land. */
function run(p: Pending): Promise<void> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks?.request) return work(p);
  return locks.request('structs-enlist', { ifAvailable: true }, (lock) => (lock ? work(p) : watch(p))).catch(() => undefined);
}

async function watch(p: Pending) {
  const job: Enlistment = { index: p.index, name: p.name, guildId: p.guildId, guildName: p.guildName, status: 'running', steps: ['Another tab is finishing your signup'] };
  current = job;
  emit();
  for (let i = 0; i < 60 && current === job; i++) {
    await new Promise((r) => setTimeout(r, 8000));
    await wallet.resolvePlayers();
    const pid = wallet.account(p.index)?.playerId;
    if (pid && current === job) { job.playerId = pid; job.status = 'done'; emit(); void empire.refresh(pid); return; }
  }
}

async function work(p: Pending) {
  const job: Enlistment = { index: p.index, name: p.name, guildId: p.guildId, guildName: p.guildName, status: 'running', steps: [] };
  current = job;
  emit();
  // A forget mid-way abandons this job: nothing it learns afterwards is shown or acted on.
  const live = () => current === job;
  const step = (s: string) => { if (!live()) return; job.steps = [...job.steps, s]; emit(); };
  try {
    const pid = await joinGuild(p.index, p.guildId, p.name, step);
    if (!live()) return;
    job.playerId = pid;
    // A player that landed while the page was closed may not have claimed its planet yet.
    const pl = await lcd.player(pid).catch(() => null);
    if (!live()) return;
    if (!pl?.Player?.planetId) { step('Claiming a planet'); explore(p.index, pid); }
    clear();
    job.status = 'done';
    emit();
    audio.stinger('secure', 0.6);
    toast(`Welcome to ${p.guildName}, ${p.name}`, 'player', 5000);
    void empire.refresh(pid);
  } catch (e) {
    if (!live()) return;
    job.status = 'failed';
    job.error = (e as Error).message;
    emit();
    // A guild that refuses this website will refuse again: don't retry it on every visit.
    if (e instanceof GuildBlockedError) { clear(); toast(job.error + ' Try another guild.', 'enemy', 7000); return; }
    toast('Enlisting stalled: ' + job.error, 'enemy', 7000, { label: 'Retry', run: retryEnlist });
  }
}

/** Off the vault's forget: nothing to resume. */
wallet.onForget(() => { clear(); current = null; emit(); });
