/* The device key: a non-extractable AES-256-GCM key kept in this browser's IndexedDB. It seals
 * a vault made in one click (no passphrase), so enlisting is instant. Script on this origin can
 * use the key but never read its bytes; anyone with this browser profile can open the vault, so
 * the recovery phrase (shown in the vault, any time) is the real backup. Its own database, so
 * clearing the client's caches never touches it. */

const DB = 'structs-xyz-keys';
const STORE = 'keys';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let idb: IDBFactory | undefined;
    try { idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB; } catch { idb = undefined; }
    if (!idb) { reject(new Error('This browser has no IndexedDB, so it cannot hold a device key')); return; }
    // An open that never settles (seen on Safari's first open) must not hang boot.
    const t = setTimeout(() => reject(new Error('IndexedDB did not open in time')), 4000);
    const req = idb.open(DB, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => { clearTimeout(t); resolve(req.result); };
    req.onerror = () => { clearTimeout(t); reject(req.error || new Error('IndexedDB refused to open')); };
    req.onblocked = () => { clearTimeout(t); reject(new Error('IndexedDB is blocked by another tab')); };
  });
}

function run<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return db().then((d) => new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction, req: IDBRequest;
    try { tx = d.transaction(STORE, mode); req = f(tx.objectStore(STORE)); } catch (e) { d.close(); reject(e); return; }
    tx.oncomplete = () => { d.close(); resolve(req.result as T); };
    tx.onerror = tx.onabort = () => { d.close(); reject(tx.error || new Error('IndexedDB write failed')); };
  }));
}

/** The key a vault names, or null when it is gone. Throws when storage can't be read at all. */
export function readDeviceKey(id: string): Promise<CryptoKey | null> {
  return run<CryptoKey | undefined>('readonly', (s) => s.get(id)).then((k) => k ?? null);
}

/** A fresh key, stored under its own id (an older vault's key is left alone until dropped). */
export async function newDeviceKey(): Promise<{ id: string; key: CryptoKey }> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const id = 'vault-' + crypto.randomUUID();
  await run('readwrite', (s) => s.put(key, id));
  return { id, key };
}

export function dropDeviceKey(id: string | undefined): Promise<void> {
  if (!id) return Promise.resolve();
  return run<undefined>('readwrite', (s) => s.delete(id)).then(() => undefined).catch(() => undefined);
}
