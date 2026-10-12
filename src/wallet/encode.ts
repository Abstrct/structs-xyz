/* Encodes any structs.structs Msg from a plain object, driven by the generated schema.
 * Values may be strings (as forms give them), numbers, bigints or enum names. */
import { MSGS, NESTED, ENUMS, type FieldSpec } from './schema.gen';
import { Writer, any, coin, legacyDec } from './proto';

export type MsgValue = Record<string, unknown>;
export interface Msg { typeUrl: string; value: MsgValue }

export const typeUrlOf = (name: string) => `/structs.structs.${name}`;
export const msgName = (typeUrl: string) => typeUrl.replace(/^\/structs\.structs\./, '');

export function enumValue(enumName: string, v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  const s = String(v ?? '').trim();
  if (/^\d+$/.test(s)) return Number(s);
  const hit = ENUMS[enumName]?.find(([n]) => n.toLowerCase() === s.toLowerCase());
  if (!hit) throw new Error(`"${s}" is not a ${enumName} (${(ENUMS[enumName] || []).map(([n]) => n).join(', ')})`);
  return hit[1];
}

function asUint(v: unknown, field: string): bigint {
  if (v == null || v === '') return 0n;
  const s = typeof v === 'bigint' ? v.toString() : String(v).trim();
  if (!/^\d+$/.test(s)) throw new Error(`${field} must be a whole number, got "${s}"`);
  const n = BigInt(s);
  if (n >= 1n << 64n) throw new Error(`${field} is too large`);
  return n;
}
function asInt(v: unknown, field: string): bigint {
  if (v == null || v === '') return 0n;
  const s = String(v).trim();
  if (!/^-?\d+$/.test(s)) throw new Error(`${field} must be an integer, got "${s}"`);
  return BigInt(s);
}

function asCoin(v: unknown, field: string): { denom: string; amount: string } {
  if (typeof v === 'string') {
    const m = /^\s*(\d+)\s*([a-zA-Z][a-zA-Z0-9/.:_-]*)\s*$/.exec(v);
    if (!m) throw new Error(`${field} must look like "100ualpha"`);
    return { amount: m[1], denom: m[2] };
  }
  const c = v as { denom?: string; amount?: unknown } | null;
  if (!c || !c.denom) throw new Error(`${field} needs a denom`);
  return { denom: c.denom, amount: asUint(c.amount, field).toString() };
}

function writeField(w: Writer, f: FieldSpec, v: unknown, owner: string) {
  const label = `${owner}.${f.name}`;
  const one = (x: unknown) => {
    switch (f.kind) {
      case 'string': w.string(f.no, x == null ? '' : String(x)); break;
      case 'dec': w.string(f.no, x == null || x === '' ? '' : legacyDec(String(x))); break;
      case 'bytes': w.bytes(f.no, x instanceof Uint8Array ? x : null); break;
      case 'bool': w.uint(f.no, x === true || x === 'true' || x === '1' ? 1 : 0); break;
      case 'uint64': case 'uint32': w.uint(f.no, asUint(x, label)); break;
      case 'int64': case 'int32': w.uint(f.no, asInt(x, label)); break;
      case 'enum': w.uint(f.no, x == null || x === '' ? 0 : enumValue(f.enum!, x)); break;
      // A Coin marked non-nullable is always on the wire, even when zero.
      case 'coin': w.msg(f.no, coin(asCoin(x, label)), true); break;
      case 'msg': w.msg(f.no, encodeFields(NESTED[f.msg!] || [], (x || {}) as MsgValue, f.msg!)); break;
    }
  };
  if (f.repeated) {
    const list = Array.isArray(v) ? v : v == null || v === '' ? [] : String(v).split(/[\s,]+/).filter(Boolean);
    // Packed encoding for repeated scalars isn't needed: every repeated field here is a string or Coin.
    for (const x of list) one(x);
  } else if (f.kind === 'coin' && (v == null || v === '')) {
    // leave a missing optional coin off
  } else one(v);
}

function encodeFields(fields: FieldSpec[], value: MsgValue, owner: string): Uint8Array {
  const w = new Writer();
  for (const f of [...fields].sort((a, b) => a.no - b.no)) writeField(w, f, value[f.name], owner);
  return w.finish();
}

/** Protobuf bytes of one Msg (without the Any wrapper). */
export function encodeMsg(m: Msg): Uint8Array {
  const name = msgName(m.typeUrl);
  const spec = MSGS[name];
  if (!spec) throw new Error(`Unknown message ${m.typeUrl}`);
  return encodeFields(spec.fields, m.value, name);
}

export function encodeAny(m: Msg): Uint8Array { return any(m.typeUrl, encodeMsg(m)); }

/** Checks a message against its schema before it is signed: unknown fields, required ids. */
export function validateMsg(m: Msg): string[] {
  const name = msgName(m.typeUrl);
  const spec = MSGS[name];
  if (!spec) return [`Unknown message ${m.typeUrl}`];
  const errs: string[] = [];
  const known = new Set(spec.fields.map((f) => f.name));
  for (const k of Object.keys(m.value)) if (!known.has(k)) errs.push(`${name} has no field "${k}"`);
  try { encodeMsg(m); } catch (e) { errs.push((e as Error).message); }
  if (!m.value.creator && known.has('creator')) errs.push(`${name} needs a creator (the signing address)`);
  return errs;
}
