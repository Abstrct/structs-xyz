/* A minimal protobuf writer: just what Cosmos transactions need (varints, length-delimited
 * fields, nested messages). Field order follows the caller, which is field-number order for
 * everything the client builds, so encodings match what Go's marshaller produces. */

const te = new TextEncoder();

export class Writer {
  private parts: Uint8Array[] = [];
  private len = 0;

  private push(b: Uint8Array) { this.parts.push(b); this.len += b.length; return this; }

  private varint(v: bigint) {
    if (v < 0n) v = BigInt.asUintN(64, v);   // int64 negatives are ten-byte varints
    const out: number[] = [];
    while (v > 127n) { out.push(Number(v & 127n) | 128); v >>= 7n; }
    out.push(Number(v));
    return this.push(Uint8Array.from(out));
  }

  private tag(no: number, wire: number) { return this.varint(BigInt((no << 3) | wire)); }

  /** uint64/int64/uint32/int32/enum/bool. Zero is the proto3 default and is skipped. */
  uint(no: number, v: bigint | number | string | boolean | undefined | null) {
    if (v == null || v === '' || v === false) return this;
    const n = typeof v === 'boolean' ? 1n : BigInt(v);
    if (n === 0n) return this;
    return this.tag(no, 0).varint(n);
  }

  bytes(no: number, b: Uint8Array | undefined | null) {
    if (!b || !b.length) return this;
    return this.tag(no, 2).varint(BigInt(b.length)).push(b);
  }

  string(no: number, s: string | undefined | null) {
    if (s == null || s === '') return this;
    return this.bytes(no, te.encode(s));
  }

  /** A nested message. An empty one still goes on the wire when `always` (e.g. a required Coin). */
  msg(no: number, inner: Writer | Uint8Array | null | undefined, always = false) {
    if (!inner) return this;
    const b = inner instanceof Writer ? inner.finish() : inner;
    if (!b.length && !always) return this;
    return this.tag(no, 2).varint(BigInt(b.length)).push(b);
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.len);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

/** google.protobuf.Any. */
export function any(typeUrl: string, value: Uint8Array): Uint8Array {
  return new Writer().string(1, typeUrl).bytes(2, value).finish();
}

/** cosmos.base.v1beta1.Coin. */
export function coin(c: { denom: string; amount: string | number | bigint }): Uint8Array {
  return new Writer().string(1, c.denom).string(2, String(c.amount)).finish();
}

/** LegacyDec on the wire: the decimal scaled by 10^18, as an integer string. */
export function legacyDec(v: string | number): string {
  const s = String(v).trim();
  if (!/^-?\d*(\.\d*)?$/.test(s) || s === '' || s === '.' || s === '-') throw new Error(`"${v}" is not a decimal`);
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace('-', '').split('.');
  if (f.length > 18) throw new Error(`"${v}" has more than 18 decimal places`);
  const n = BigInt((i || '0') + f.padEnd(18, '0'));
  return (neg && n ? '-' : '') + n.toString();
}

/* ── Reading (for responses: tx results, account numbers) ─────────────── */

export function readFields(buf: Uint8Array): Map<number, (bigint | Uint8Array)[]> {
  const out = new Map<number, (bigint | Uint8Array)[]>();
  let i = 0;
  const vint = () => {
    let r = 0n, s = 0n;
    for (;;) {
      if (i >= buf.length) throw new Error('truncated varint');
      const b = buf[i++];
      r |= BigInt(b & 127) << s;
      if (!(b & 128)) return r;
      s += 7n;
    }
  };
  while (i < buf.length) {
    const key = Number(vint());
    const no = key >>> 3, wire = key & 7;
    let v: bigint | Uint8Array;
    if (wire === 0) v = vint();
    else if (wire === 2) { const n = Number(vint()); v = buf.subarray(i, i + n); i += n; }
    else if (wire === 1) { v = buf.subarray(i, i + 8); i += 8; }
    else if (wire === 5) { v = buf.subarray(i, i + 4); i += 4; }
    else throw new Error('unsupported wire type ' + wire);
    const list = out.get(no);
    if (list) list.push(v); else out.set(no, [v]);
  }
  return out;
}
