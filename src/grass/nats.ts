/* NATS over a WebSocket, the wire GRASS speaks. A minimal client, no dependencies: the
 * text protocol (INFO / CONNECT / SUB / UNSUB / MSG / PING / PONG) in binary frames.
 * A MSG's payload is framed by its declared byte length, and a frame boundary can fall
 * anywhere (mid-line, mid-payload), so the parser buffers bytes, never strings.
 * Reconnects with backoff (1 s → 30 s) and re-subscribes; a client PING every 20 s
 * catches a socket that went silent without closing, and a handshake deadline one that
 * opened (or hangs opening) but never answers. */

export type NatsOp =
  | { op: 'INFO'; info: Record<string, unknown> }
  | { op: 'MSG'; subject: string; sid: number; reply?: string; payload: Uint8Array }
  | { op: 'PING' } | { op: 'PONG' } | { op: 'OK' }
  | { op: 'ERR'; message: string };

const CR = 13, LF = 10;
const dec = new TextDecoder();
const enc = new TextEncoder();
/** Anything bigger without a line end is not NATS: drop it rather than grow forever. */
const MAX_BUFFER = 8 * 1024 * 1024;

export class NatsParser {
  private buf: Uint8Array = new Uint8Array(0);

  /** Feed one frame; get back every complete operation it finished. */
  push(chunk: Uint8Array): NatsOp[] {
    if (!this.buf.length) this.buf = chunk;
    else {
      const b = new Uint8Array(this.buf.length + chunk.length);
      b.set(this.buf, 0); b.set(chunk, this.buf.length);
      this.buf = b;
    }
    const out: NatsOp[] = [];
    let pos = 0;
    const buf = this.buf;
    while (pos < buf.length) {
      const eol = crlf(buf, pos);
      if (eol < 0) break;
      const line = dec.decode(buf.subarray(pos, eol));
      const sp = line.search(/[ \t]/);
      const verb = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
      const rest = sp < 0 ? '' : line.slice(sp + 1).trim();
      if (verb === 'MSG' || verb === 'HMSG') {
        const a = rest.split(/[ \t]+/);
        // MSG <subject> <sid> [reply] <#bytes>   ·   HMSG <subject> <sid> [reply] <#hdr> <#total>
        const total = Number(a[a.length - 1]);
        const hdr = verb === 'HMSG' ? Number(a[a.length - 2]) : 0;
        const fixed = verb === 'HMSG' ? 4 : 3;
        if (!Number.isFinite(total) || total < 0 || a.length < fixed) { pos = eol + 2; continue; }
        const start = eol + 2, end = start + total;
        if (end + 2 > buf.length) break;   // the payload is still in flight
        out.push({ op: 'MSG', subject: a[0], sid: Number(a[1]), reply: a.length > fixed ? a[2] : undefined, payload: buf.slice(start + hdr, end) });
        pos = end + 2;
        continue;
      }
      pos = eol + 2;
      if (verb === 'PING') out.push({ op: 'PING' });
      else if (verb === 'PONG') out.push({ op: 'PONG' });
      else if (verb === '+OK') out.push({ op: 'OK' });
      else if (verb === '-ERR') out.push({ op: 'ERR', message: rest.replace(/^'|'$/g, '') });
      else if (verb === 'INFO') { try { out.push({ op: 'INFO', info: JSON.parse(rest) }); } catch { /* malformed: skip */ } }
    }
    this.buf = pos >= buf.length ? new Uint8Array(0) : buf.slice(pos);
    if (this.buf.length > MAX_BUFFER) this.buf = new Uint8Array(0);
    return out;
  }

  reset() { this.buf = new Uint8Array(0); }
}

function crlf(b: Uint8Array, from: number): number {
  for (let i = from; i < b.length - 1; i++) if (b[i] === CR && b[i + 1] === LF) return i;
  return -1;
}

/* ── Connection ─────────────────────────────────────────────────────────── */

export type NatsState = 'connecting' | 'live' | 'down' | 'closed';
export interface NatsMsg { subject: string; sid: number; reply?: string; payload: Uint8Array }
type WsCtor = new (url: string) => WebSocket;

export interface NatsOptions {
  url: string;
  /** For tests and Node: a WebSocket constructor (defaults to the global one). */
  WebSocket?: WsCtor;
  name?: string;
  pingMs?: number;
  /** How long a dial may take to reach the handshake's PONG before it is dropped and retried. */
  handshakeMs?: number;
}

export class NatsWs {
  state: NatsState = 'connecting';
  url: string;
  /** Server INFO from the current connection. */
  info: Record<string, unknown> | null = null;
  private ws: WebSocket | null = null;
  private parser = new NatsParser();
  private subs = new Map<number, { subject: string; fn: (m: NatsMsg) => void }>();
  private nextSid = 1;
  private backoff = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private shakeTimer: ReturnType<typeof setTimeout> | null = null;
  private pingsOut = 0;
  private stateL = new Set<(s: NatsState) => void>();
  private Ws: WsCtor;
  private closed = false;

  constructor(private opts: NatsOptions) {
    this.url = opts.url;
    this.Ws = opts.WebSocket || (globalThis.WebSocket as unknown as WsCtor);
  }

  onState(f: (s: NatsState) => void) { this.stateL.add(f); return () => { this.stateL.delete(f); }; }

  connect() {
    this.closed = false;
    if (this.ws) return;
    this.setState('connecting');
    let ws: WebSocket;
    try { ws = new this.Ws(this.url); } catch { this.retry(); return; }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.parser.reset();
    this.pingsOut = 0;
    // Until the PONG to hello()'s PING, the link is not live; a server that never says so
    // would leave us 'connecting' for good (and the stale-feed watchdog only watches live links).
    this.stopHandshake();
    this.shakeTimer = setTimeout(() => {
      this.shakeTimer = null;
      if (this.ws !== ws || this.state === 'live') return;
      console.warn('[nats] no handshake from ' + this.url + ', retrying');
      this.ws = null;
      try { ws.close(); } catch { /* ignore */ }
      if (!this.closed) this.retry();
    }, this.opts.handshakeMs ?? 12_000);
    ws.onmessage = (e: MessageEvent) => {
      if (this.ws !== ws) return;
      const d = e.data;
      const bytes = typeof d === 'string' ? enc.encode(d) : d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : null;
      if (!bytes) return;
      for (const op of this.parser.push(bytes)) this.handle(op);
    };
    // CONNECT goes out the moment the socket opens, without waiting for INFO: the server allows
    // it, and a busy page (WebGL boot) could otherwise miss NATS's short auth timeout.
    ws.onopen = () => { if (this.ws === ws) this.hello(); };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = () => { if (this.ws === ws) { this.ws = null; this.stopPing(); this.stopHandshake(); if (!this.closed) this.retry(); } };
  }

  /** Drop the socket and dial again now (a stale-feed watchdog's lever). */
  restart() {
    const ws = this.ws;
    this.ws = null;
    this.stopPing();
    this.stopHandshake();
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    try { ws?.close(); } catch { /* ignore */ }
    if (!this.closed) this.connect();
  }

  close() {
    this.closed = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.stopPing();
    this.stopHandshake();
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* ignore */ }
    this.setState('closed');
  }

  subscribe(subject: string, fn: (m: NatsMsg) => void): () => void {
    const sid = this.nextSid++;
    this.subs.set(sid, { subject, fn });
    if (this.state === 'live') this.send(`SUB ${subject} ${sid}\r\n`);
    return () => {
      if (!this.subs.delete(sid)) return;
      if (this.state === 'live') this.send(`UNSUB ${sid}\r\n`);
    };
  }

  private handle(op: NatsOp) {
    switch (op.op) {
      case 'INFO':
        // The handshake already went out on open; INFO is kept for reference (and re-sent by servers).
        this.info = op.info;
        return;
      case 'PING': this.send('PONG\r\n'); return;
      case 'PONG':
        this.pingsOut = 0;
        if (this.state !== 'live') { this.stopHandshake(); this.setState('live'); this.backoff = 1000; this.startPing(); }
        return;
      case 'MSG': {
        const s = this.subs.get(op.sid);
        if (s) { try { s.fn(op); } catch (e) { console.error(e); } }
        return;
      }
      case 'ERR':
        console.warn('[nats] server error:', op.message);
        return;
      default: return;
    }
  }

  private hello() {
    const connect = { verbose: false, pedantic: false, lang: this.opts.name || 'structs-xyz', version: '1', protocol: 1, headers: false };
    let out = `CONNECT ${JSON.stringify(connect)}\r\n`;
    for (const [sid, s] of this.subs) out += `SUB ${s.subject} ${sid}\r\n`;
    // The PONG to this PING says the server took CONNECT and the SUBs.
    this.send(out + 'PING\r\n');
    this.pingsOut = 1;
  }

  private send(s: string) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return;
    try { ws.send(enc.encode(s)); } catch { /* the close handler takes it from here */ }
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      // Two pings unanswered: the socket is dead even if it hasn't said so.
      if (this.pingsOut >= 2) { this.restart(); return; }
      this.pingsOut++;
      this.send('PING\r\n');
    }, this.opts.pingMs ?? 20000);
  }
  private stopPing() { if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; } }
  private stopHandshake() { if (this.shakeTimer) { clearTimeout(this.shakeTimer); this.shakeTimer = null; } }

  private retry() {
    this.setState('down');
    if (this.retryTimer) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30000);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; if (!this.closed) this.connect(); }, wait);
  }

  private setState(s: NatsState) {
    if (s === this.state) return;
    this.state = s;
    for (const f of this.stateL) { try { f(s); } catch (e) { console.error(e); } }
  }
}
