/* The vault: the recovery phrase at rest, encrypted in this browser. Two seals:
 *   passphrase: PBKDF2-SHA256 (600k rounds) → AES-256-GCM, via WebCrypto. Salt and IV are random per save.
 *   device:     AES-256-GCM under a non-extractable key in IndexedDB (devicekey.ts) — one-click enlist.
 * Only ciphertext touches storage; the plaintext phrase lives in memory while unlocked and is
 * dropped on lock. Public facts (addresses, labels, player ids) are stored in the clear so the
 * client can show your empire before you unlock. */

const KEY = 'structs.vault.v1';
const ROUNDS = 600_000;

export interface VaultAccount {
  /** HD index on m/44'/118'/0'/0/i. 0 is the commander; ≥1 are replicants. */
  index: number;
  address: string;
  label: string;
  playerId?: string;
  role?: 'primary' | 'productive' | 'bait' | 'raider' | 'key';
  createdAt: number;
}

export interface VaultFile {
  v: 1;
  /** base64 */
  salt: string; iv: string; ct: string;
  rounds: number;
  accounts: VaultAccount[];
  /** When this phrase was last backed up (shown, confirmed) by the person. */
  backedUpAt?: number;
  /** 'device': sealed by this browser's device key, no passphrase. Absent: a passphrase seal. */
  mode?: 'device';
  /** Which device key seals it (devicekey.ts). */
  keyId?: string;
  createdAt: number;
}

const b64 = (b: ArrayBuffer | Uint8Array) => { let s = ''; for (const x of new Uint8Array(b)) s += String.fromCharCode(x); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveAesKey(passphrase: string, salt: Uint8Array, rounds: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: rounds, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function sealPhrase(phrase: string, passphrase: string, accounts: VaultAccount[], prev?: VaultFile): Promise<VaultFile> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(passphrase, salt, ROUNDS);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, new TextEncoder().encode(phrase));
  return { v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct), rounds: ROUNDS, accounts, backedUpAt: prev?.backedUpAt, createdAt: prev?.createdAt ?? Date.now() };
}

/** Seal under the device key (salt and rounds unused). */
export async function sealDevice(phrase: string, key: CryptoKey, keyId: string, accounts: VaultAccount[], prev?: VaultFile): Promise<VaultFile> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, new TextEncoder().encode(phrase));
  return { v: 1, salt: '', iv: b64(iv), ct: b64(ct), rounds: 0, accounts, mode: 'device', keyId, backedUpAt: prev?.backedUpAt, createdAt: prev?.createdAt ?? Date.now() };
}

export async function openDevice(file: VaultFile, key: CryptoKey): Promise<string> {
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(file.iv) as BufferSource }, key, unb64(file.ct) as BufferSource);
    return new TextDecoder().decode(pt);
  } catch {
    throw new Error('This browser’s device key no longer opens the vault. Import your recovery phrase to restore the commander.');
  }
}

export async function openPhrase(file: VaultFile, passphrase: string): Promise<string> {
  const key = await deriveAesKey(passphrase, unb64(file.salt), file.rounds);
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(file.iv) as BufferSource }, key, unb64(file.ct) as BufferSource);
    return new TextDecoder().decode(pt);
  } catch {
    throw new Error('Wrong passphrase');
  }
}

export function readVault(): VaultFile | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as VaultFile;
    return v && v.v === 1 && v.ct ? v : null;
  } catch { return null; }
}

export function writeVault(v: VaultFile | null) {
  try {
    if (v) localStorage.setItem(KEY, JSON.stringify(v));
    else localStorage.removeItem(KEY);
  } catch (e) {
    throw new Error('This browser refused to store the vault: ' + (e as Error).message);
  }
}

/** Public account facts only (no ciphertext change): labels, player ids, roles. */
export function updateAccounts(mut: (a: VaultAccount[]) => VaultAccount[]) {
  const v = readVault();
  if (!v) return;
  v.accounts = mut(v.accounts.map((a) => ({ ...a })));
  writeVault(v);
}
