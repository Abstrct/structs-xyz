/* The wallet session: vault state, the accounts it holds, and the only door to a private key.
 * Keys are derived on demand from the phrase held in memory while unlocked, used, and dropped.
 * A passphrase vault auto-locks after a quiet spell (default 45 min). A device vault (made by
 * one-click enlist) opens itself on load and never locks: there is no passphrase to ask for. */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { deriveKey, isValidMnemonic, newMnemonic, normaliseMnemonic, toHex, type KeyPair } from './keys';
import { openDevice, openPhrase, readVault, sealDevice, sealPhrase, updateAccounts, writeVault, type VaultAccount } from './vault';
import { dropDeviceKey, newDeviceKey, readDeviceKey } from './devicekey';
import { insecurePage } from './secure';
import { lcd } from '../chain/lcd';
import { safeEach } from '../core/util';

export type WalletState = 'empty' | 'locked' | 'unlocked';
type Fn = () => void;

const LOCK_KEY = 'structs.wallet.autolock';
const ACTIVE_KEY = 'structs.wallet.active';

class Wallet {
  private phrase: string | null = null;
  private listeners = new Set<Fn>();
  private lastTouch = Date.now();

  constructor() {
    if (typeof window === 'undefined') return;
    for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => { this.lastTouch = Date.now(); }, { passive: true, capture: true });
    window.setInterval(() => {
      const mins = this.autoLockMinutes;
      if (this.phrase && !this.deviceSealed && mins > 0 && Date.now() - this.lastTouch > mins * 60_000) this.lock();
    }, 20_000);
  }

  get state(): WalletState { return this.phrase ? 'unlocked' : readVault() ? 'locked' : 'empty'; }
  get unlocked() { return !!this.phrase; }
  get accounts(): VaultAccount[] { return readVault()?.accounts ?? []; }
  get primary(): VaultAccount | null { return this.accounts.find((a) => a.index === 0) ?? null; }
  get backedUp(): boolean { return !!readVault()?.backedUpAt; }
  /** Sealed by this browser's device key (one-click enlist) rather than a passphrase. */
  get deviceSealed(): boolean { return readVault()?.mode === 'device'; }

  /** The account the commander acts as (defaults to the primary). */
  get activeIndex(): number { try { return Number(localStorage.getItem(ACTIVE_KEY) || 0) || 0; } catch { return 0; } }
  get active(): VaultAccount | null { const i = this.activeIndex; return this.accounts.find((a) => a.index === i) ?? this.primary; }
  setActive(index: number) { try { localStorage.setItem(ACTIVE_KEY, String(index)); } catch { /* ignore */ } this.emit(); }

  get autoLockMinutes(): number { try { const v = localStorage.getItem(LOCK_KEY); return v == null ? 45 : Number(v); } catch { return 45; } }
  set autoLockMinutes(m: number) { try { localStorage.setItem(LOCK_KEY, String(m)); } catch { /* ignore */ } }

  onChange(f: Fn) { this.listeners.add(f); return () => this.listeners.delete(f); }
  private emit() { safeEach(this.listeners, (f) => f()); }

  account(index: number) { return this.accounts.find((a) => a.index === index) ?? null; }
  byAddress(address: string) { return this.accounts.find((a) => a.address === address) ?? null; }
  byPlayer(playerId: string) { return this.accounts.find((a) => a.playerId === playerId) ?? null; }
  /** Every player id this wallet controls. */
  playerIds(): string[] { return this.accounts.map((a) => a.playerId).filter((x): x is string => !!x); }

  /** Create or import: seals the phrase under a passphrase and opens the session. */
  async create(phrase: string, passphrase: string) {
    secureOrThrow();
    const m = normaliseMnemonic(phrase);
    if (!isValidMnemonic(m)) throw new Error('That is not a valid 12 or 24 word recovery phrase');
    if (passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters');
    const k = deriveKey(m, 0);
    const acct: VaultAccount = { index: 0, address: k.address, label: 'Commander', role: 'primary', createdAt: Date.now() };
    writeVault(await sealPhrase(m, passphrase, [acct]));
    this.phrase = m;
    this.lastTouch = Date.now();
    this.emit();
    void this.resolvePlayers();
  }

  /** One click: a fresh 24-word phrase sealed by the device key, open at once. Or `phrase` to import one the same way. */
  async createInstant(phrase = newMnemonic(24)) {
    secureOrThrow();
    const m = normaliseMnemonic(phrase);
    if (!isValidMnemonic(m)) throw new Error('That is not a valid 12 or 24 word recovery phrase');
    const k = deriveKey(m, 0);
    // Re-importing this browser's own phrase (its device key was lost) keeps the accounts it knew.
    const prev = readVault();
    const same = prev?.accounts.find((a) => a.index === 0)?.address === k.address ? prev! : undefined;
    const accounts = same?.accounts ?? [{ index: 0, address: k.address, label: 'Commander', role: 'primary', createdAt: Date.now() } as VaultAccount];
    const { id, key } = await newDeviceKey();
    // The new key is stored under its own id before the vault names it, so a failed write leaves the old vault openable.
    writeVault(await sealDevice(m, key, id, accounts, same));
    if (prev?.mode === 'device' && prev.keyId !== id) void dropDeviceKey(prev.keyId ?? 'vault');
    this.phrase = m;
    this.lastTouch = Date.now();
    this.emit();
    void this.resolvePlayers();
  }

  /** On load: a device vault opens itself. A passphrase vault stays locked. */
  async restore() {
    const v = readVault();
    if (this.phrase || !v || v.mode !== 'device') return;
    secureOrThrow();
    let key: CryptoKey | null;
    try { key = await readDeviceKey(v.keyId ?? 'vault'); } catch (e) { throw new Error('This browser’s key storage did not answer (' + ((e as Error).message || 'IndexedDB error') + '). Reload to try again.'); }
    if (!key) throw new Error('This browser lost the device key that seals your vault. Import your recovery phrase to restore the commander.');
    this.phrase = await openDevice(v, key);
    this.lastTouch = Date.now();
    this.emit();
    void this.resolvePlayers();
  }

  async unlock(passphrase: string) {
    const v = readVault();
    if (!v) throw new Error('No vault in this browser');
    if (v.mode === 'device') return this.restore();
    secureOrThrow();
    this.phrase = await openPhrase(v, passphrase);
    this.lastTouch = Date.now();
    this.emit();
    void this.resolvePlayers();
  }

  /** A device vault has nothing to unlock with, so it stays open. */
  lock() { if (!this.phrase || this.deviceSealed) return; this.phrase = null; this.emit(); }

  /** Removes the vault from this browser. The phrase is the only way back. Everything that acted
   * on its behalf (guild and chat sessions, crew, standing orders) is told to let go too. */
  forget() {
    this.phrase = null;
    const keyId = readVault()?.keyId;
    writeVault(null);
    void dropDeviceKey(keyId);
    try { localStorage.removeItem(ACTIVE_KEY); } catch { /* ignore */ }
    safeEach(this.forgetL, (f) => f());
    this.emit();
  }
  private forgetL = new Set<() => void>();
  onForget(f: () => void) { this.forgetL.add(f); return () => this.forgetL.delete(f); }

  /** Re-seal under a new passphrase. A device vault needs no old one: this moves it to a passphrase seal. */
  async changePassphrase(oldPass: string, newPass: string) {
    const v = readVault();
    if (!v) throw new Error('No vault');
    if (newPass.length < 8) throw new Error('Use a passphrase of at least 8 characters');
    const device = v.mode === 'device';
    const m = device ? (this.phrase ?? (await this.restore(), this.phrase!)) : await openPhrase(v, oldPass);
    const next = await sealPhrase(m, newPass, v.accounts, v);
    writeVault(next);
    if (device) { void dropDeviceKey(v.keyId ?? 'vault'); this.emit(); }
  }

  markBackedUp() { const v = readVault(); if (v) { v.backedUpAt = Date.now(); writeVault(v); this.emit(); } }

  /** Reveal the phrase (for a backup). A passphrase vault asks for it again, even while unlocked. */
  async revealPhrase(passphrase = ''): Promise<string> {
    const v = readVault();
    if (!v) throw new Error('No vault');
    if (v.mode === 'device') { if (!this.phrase) await this.restore(); return this.phrase!; }
    return openPhrase(v, passphrase);
  }

  /** Add the HD account at `index` (a replicant identity). */
  addAccount(index: number, label: string, role: VaultAccount['role'] = 'productive'): VaultAccount {
    const k = this.key(index);
    const acct: VaultAccount = { index, address: k.address, label, role, createdAt: Date.now() };
    updateAccounts((list) => (list.some((a) => a.index === index) ? list : [...list, acct].sort((a, b) => a.index - b.index)));
    this.emit();
    // The key may already be a player (made elsewhere): find out now, not at the next unlock.
    void this.resolvePlayers();
    return acct;
  }

  nextIndex(): number { return Math.max(0, ...this.accounts.map((a) => a.index)) + 1; }

  setAccount(index: number, patch: Partial<VaultAccount>) {
    updateAccounts((list) => list.map((a) => (a.index === index ? { ...a, ...patch, index } : a)));
    this.emit();
  }

  removeAccount(index: number) {
    if (index === 0) throw new Error('The commander account cannot be removed');
    updateAccounts((list) => list.filter((a) => a.index !== index));
    if (this.activeIndex === index) this.setActive(0);
    this.emit();
  }

  /** The key for an account. Throws while locked. Callers use it and let it go. */
  key(index: number): KeyPair {
    if (!this.phrase) throw new WalletLockedError();
    // Signing doesn't count as activity: automation must not keep an unattended vault open.
    return deriveKey(this.phrase, index);
  }

  /** Off-chain proof signatures the guild stack understands: secp256k1 over sha256(utf8),
   * hex of r‖s‖recovery (cosmjs ExtendedSecp256k1Signature.toFixedLength). */
  signMessage(index: number, message: string): { address: string; pubkey: string; signature: string } {
    const k = this.key(index);
    const digest = sha256(new TextEncoder().encode(message));
    const rec = secp256k1.sign(digest, k.privKey, { prehash: false, lowS: true, format: 'recovered' });
    const fixed = new Uint8Array(65);
    fixed.set(rec.subarray(1, 65), 0);
    fixed[64] = rec[0];
    return { address: k.address, pubkey: toHex(k.pubKey), signature: toHex(fixed) };
  }

  /** Fill in player ids for accounts the chain knows. */
  async resolvePlayers() {
    let changed = false;
    for (const a of this.accounts) {
      if (a.playerId) continue;
      try {
        const r = await lcd.address(a.address);
        // A linked field key answers with its player's id; that player is already an account here.
        if (r.playerId && r.playerId !== '1-0' && !this.accounts.some((x) => x.playerId === r.playerId)) { this.setAccountQuiet(a.index, { playerId: r.playerId }); changed = true; }
      } catch { /* not registered yet */ }
    }
    if (changed) this.emit();
  }

  private setAccountQuiet(index: number, patch: Partial<VaultAccount>) {
    updateAccounts((list) => list.map((a) => (a.index === index ? { ...a, ...patch } : a)));
  }
}

export class WalletLockedError extends Error {
  constructor() { super('Unlock your wallet to sign'); this.name = 'WalletLockedError'; }
}

export const wallet = new Wallet();

/** No vault work on a page the browser doesn't trust (secure.ts): say why, plainly. */
function secureOrThrow() { const why = insecurePage(); if (why) throw new Error(why); }

