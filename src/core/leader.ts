/* One signer per browser. Every tab can show the queue, but only one may sign, hash or run
 * standing orders, or two tabs would send the same move twice. The signer is the first tab with
 * an unlocked vault: it holds a Web Lock for as long as it stays unlocked; a locked or closed
 * signer releases it and the next unlocked tab takes over.
 * Browsers without Web Locks fall back to every tab acting alone (the old behaviour). */
import { safeEach } from './util';

type Fn = (leader: boolean) => void;

class Leader {
  isLeader = false;
  private release: (() => void) | null = null;
  private wanting: AbortController | null = null;
  private listeners = new Set<Fn>();
  readonly supported = typeof navigator !== 'undefined' && !!navigator.locks?.request;

  onChange(f: Fn) { this.listeners.add(f); f(this.isLeader); return () => this.listeners.delete(f); }
  private set(v: boolean) { if (v === this.isLeader) return; this.isLeader = v; safeEach(this.listeners, (f) => f(v)); }

  /** Ask to become the signer (call while unlocked). Resolves immediately; leadership may come later. */
  want() {
    if (!this.supported) { this.set(true); return; }
    if (this.wanting || this.isLeader) return;
    const ctl = new AbortController();
    this.wanting = ctl;
    void navigator.locks.request('structs-signer', { signal: ctl.signal }, () => new Promise<void>((resolve) => {
      this.wanting = null;
      this.release = resolve;
      this.set(true);
    })).catch(() => { if (this.wanting === ctl) this.wanting = null; });
  }

  /** Give the role up (the vault locked, or was forgotten). */
  resign() {
    if (!this.supported) { this.set(false); return; }
    // Leave the line too: a request still waiting would hand us the role after we locked.
    this.wanting?.abort();
    this.wanting = null;
    this.release?.();
    this.release = null;
    this.set(false);
  }
}

export const leader = new Leader();
