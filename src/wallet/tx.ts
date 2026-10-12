/* Building, signing and broadcasting Cosmos SDK transactions (SIGN_MODE_DIRECT), straight to
 * the chain's LCD — which answers browsers (CORS-open, POST with JSON allowed). */
import { Writer, any, coin } from './proto';
import { encodeAny, type Msg } from './encode';
import { signBytes, toB64, type KeyPair } from './keys';
import { LCD_URL } from '../chain/lcd';

export const FEE_DENOM = 'ualpha';
export const DEFAULT_GAS = 500_000;
/** Simulated gas × this, so a block's state moving under us doesn't run the tx out of gas. */
export const GAS_MULTIPLIER = 1.6;

export interface SignerData { chainId: string; accountNumber: bigint; sequence: bigint }
export interface Fee { amount: { denom: string; amount: string }[]; gas: number }

export function txBody(msgs: Msg[], memo = ''): Uint8Array {
  const w = new Writer();
  for (const m of msgs) w.msg(1, encodeAny(m), true);
  w.string(2, memo);
  return w.finish();
}

export function authInfo(pubKey: Uint8Array, sequence: bigint, fee: Fee): Uint8Array {
  const pk = any('/cosmos.crypto.secp256k1.PubKey', new Writer().bytes(1, pubKey).finish());
  const modeInfo = new Writer().msg(1, new Writer().uint(1, 1), true);   // single { mode: SIGN_MODE_DIRECT }
  const signerInfo = new Writer().msg(1, pk).msg(2, modeInfo, true).uint(3, sequence);
  const feeW = new Writer();
  for (const c of fee.amount) feeW.msg(1, coin(c), true);
  feeW.uint(2, fee.gas);
  return new Writer().msg(1, signerInfo, true).msg(2, feeW, true).finish();
}

export function signDoc(body: Uint8Array, auth: Uint8Array, chainId: string, accountNumber: bigint): Uint8Array {
  // account_number 0 is a real account (the first one): proto3 drops it, which is still right.
  return new Writer().bytes(1, body).bytes(2, auth).string(3, chainId).uint(4, accountNumber).finish();
}

export function txRaw(body: Uint8Array, auth: Uint8Array, sigs: Uint8Array[]): Uint8Array {
  const w = new Writer().bytes(1, body).bytes(2, auth);
  for (const s of sigs) w.bytes(3, s);
  return w.finish();
}

export function signTx(key: KeyPair, msgs: Msg[], signer: SignerData, fee: Fee, memo = ''): Uint8Array {
  const body = txBody(msgs, memo);
  const auth = authInfo(key.pubKey, signer.sequence, fee);
  const sig = signBytes(key.privKey, signDoc(body, auth, signer.chainId, signer.accountNumber));
  return txRaw(body, auth, [sig]);
}

/* ── The chain, over LCD ──────────────────────────────────────────────── */

export class ChainTxError extends Error {
  code: number; codespace: string; log: string; hash?: string;
  constructor(code: number, codespace: string, log: string, hash?: string) {
    super(humanError(code, codespace, log));
    this.code = code; this.codespace = codespace; this.log = log; this.hash = hash;
  }
  /** "account sequence mismatch, expected 12, got 11" → 12 */
  get expectedSequence(): bigint | null {
    const m = /expected (\d+), got (\d+)/.exec(this.log);
    return this.code === 32 && m ? BigInt(m[1]) : null;
  }
}

/** Drop the SDK's source-location and gas tail ("[cosmos/cosmos-sdk@…/baseapp.go:1052] with gas used: 'N'"). */
export function stripCosmosTail(s: string): string { return s.replace(/\s*\[cosmos\/cosmos-sdk[^\]]*\].*$/s, '').replace(/\s*with gas used:.*$/s, '').trim(); }

/** Raw chain logs into something a commander can act on. */
export function humanError(code: number, codespace: string, log: string): string {
  const l = log || '';
  if (codespace === 'structs-ante' || code >= 2000) {
    const ante: Record<number, string> = {
      2010: 'This address is not registered to a player', 2011: 'Missing permission for that action',
      2020: 'Only one charged action per transaction', 2021: 'Charge already used this block — next block', 2022: 'Battery drained this block — next block',
      2030: 'One proof per object per transaction', 2031: 'Proof already tried this block — next block', 2033: 'That object is throttled this block',
      2040: 'Too many messages from this player this block', 2041: 'Too many transactions from this address this block — next block', 2050: 'Free transactions must carry a zero fee',
    };
    if (ante[code]) return ante[code];
  }
  if (code === 32) return 'Out of order (account sequence) — retrying with the right number';
  if (code === 5 || /insufficient funds/i.test(l)) return 'Not enough funds for that';
  if (code === 11 || /out of gas/i.test(l)) return 'Ran out of gas — retry with more';
  if (code === 13) return 'Fee too low for this node';
  if (code === 19) return 'Already submitted (tx in mempool)';
  if (/cannot handle new load requirements/i.test(l)) return 'Not enough free power for that (or you already have the most you can build)';
  if (/work failure/i.test(l)) return 'Puzzle answer not accepted (the clock moved): solving again';
  if (/insufficient charge|not enough charge|charge \(\d+\) is (less|lower)/i.test(l)) return 'Not enough charge yet: wait a few blocks';
  if (/permission/i.test(l)) return 'You lack permission for that object';
  if (/proof|difficulty|hash/i.test(l) && /invalid|insufficient|does not/i.test(l)) return 'Puzzle answer not accepted yet: keep solving';
  if (/player[^.]*(is )?offline|halted|load exceeds/i.test(l) && !/must be offline/i.test(l)) return 'Not enough power: your machines use more than you have';
  const clean = stripCosmosTail(l).replace(/^failed to execute message; message index: \d+: /, '');
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : `Chain error ${codespace}/${code}`;
}

async function lcdJson<T>(path: string, init?: RequestInit, timeoutMs = 20000): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(LCD_URL + path, { ...init, signal: ctl.signal });
    const text = await res.text();
    let body: any;
    try { body = JSON.parse(text); } catch { throw new Error(`LCD ${res.status}: ${text.slice(0, 120)}`); }
    if (!res.ok) {
      const err = new Error(body?.message || `LCD ${res.status}`) as Error & { status: number; code?: number };
      err.status = res.status; err.code = body?.code;
      throw err;
    }
    return body as T;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('The chain took too long to answer');
    throw e;
  } finally { clearTimeout(timer); }
}

let chainIdP: Promise<string> | null = null;
export function chainId(): Promise<string> {
  if (!chainIdP) chainIdP = lcdJson<{ default_node_info: { network: string } }>('/cosmos/base/tendermint/v1beta1/node_info')
    .then((r) => r.default_node_info.network).catch((e) => { chainIdP = null; throw e; });
  return chainIdP;
}

export interface AccountInfo { exists: boolean; accountNumber: bigint; sequence: bigint }
export async function account(address: string): Promise<AccountInfo> {
  try {
    const r = await lcdJson<{ account: { account_number?: string; sequence?: string; base_account?: { account_number: string; sequence: string } } }>(`/cosmos/auth/v1beta1/accounts/${address}`);
    const a = r.account.base_account || r.account;
    return { exists: true, accountNumber: BigInt(a.account_number || '0'), sequence: BigInt(a.sequence || '0') };
  } catch (e) {
    if ((e as { status?: number }).status === 404 || /not found/i.test((e as Error).message)) return { exists: false, accountNumber: 0n, sequence: 0n };
    throw e;
  }
}

export async function balances(address: string): Promise<{ denom: string; amount: string }[]> {
  const r = await lcdJson<{ balances: { denom: string; amount: string }[] }>(`/cosmos/bank/v1beta1/balances/${address}?pagination.limit=200`);
  return r.balances || [];
}

/** Gas a tx would use, by dry-running it. Signature checks are skipped by simulation, but a
 * real signature keeps the ante handler's gas accounting identical to the real thing. */
export async function simulate(txBytes: Uint8Array): Promise<number> {
  const r = await lcdJson<{ gas_info: { gas_used: string } }>('/cosmos/tx/v1beta1/simulate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tx_bytes: toB64(txBytes) }),
  }, 30000);
  return Number(r.gas_info.gas_used);
}

export interface Broadcast { hash: string }
export async function broadcast(txBytes: Uint8Array): Promise<Broadcast> {
  const r = await lcdJson<{ tx_response: { code: number; codespace: string; raw_log: string; txhash: string } }>('/cosmos/tx/v1beta1/txs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tx_bytes: toB64(txBytes), mode: 'BROADCAST_MODE_SYNC' }),
  }, 30000);
  const t = r.tx_response;
  if (t.code) throw new ChainTxError(t.code, t.codespace, t.raw_log, t.txhash);
  return { hash: t.txhash };
}

export interface TxResult { hash: string; height: number; code: number; log: string; gasUsed: number; events: { type: string; attributes: { key: string; value: string }[] }[] }
export async function getTx(hash: string): Promise<TxResult | null> {
  try {
    const r = await lcdJson<{ tx_response: { txhash: string; height: string; code: number; raw_log: string; gas_used: string; events: TxResult['events'] } }>(`/cosmos/tx/v1beta1/txs/${hash}`);
    const t = r.tx_response;
    return { hash: t.txhash, height: Number(t.height), code: t.code, log: t.raw_log, gasUsed: Number(t.gas_used), events: t.events || [] };
  } catch (e) {
    if ((e as { status?: number }).status === 404 || /not found/i.test((e as Error).message)) return null;
    throw e;
  }
}
