/* The live channel: Tendermint's WebSocket on the public testnet. NewBlock is
 * the client's clock; every Tx carries structsd's typed events
 * (structs.structs.Event*) with JSON payloads. No replay: anything missed
 * while disconnected is gone, so the connection state is always surfaced and
 * the stores re-read REST on reconnect. */
import { safeEach } from '../core/util';

export const RPC_WS_URL = ((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_RPC_WS_URL) || 'wss://public.testnet.structs.network:26657/websocket';

export type LinkState = 'connecting' | 'live' | 'down';

export interface ChainTxEvent {
  /** Short type, e.g. "EventAttack". */
  type: string;
  /** Parsed JSON payload of the event's container attribute. */
  data: any;
}
export interface LiveTx { height: number; hash: string; events: ChainTxEvent[]; signer?: string; action?: string; time: number }
export interface LiveBlock { height: number; time: string; txCount: number; receivedAt: number }

type Listener<T> = (v: T) => void;

class LiveFeed {
  state: LinkState = 'connecting';
  height = 0;
  lastBlockAt = 0;
  /** Running estimate of seconds per block. */
  blockTime = 6;
  private ws: WebSocket | null = null;
  private backoff = 1000;
  private started = false;
  private blockL = new Set<Listener<LiveBlock>>();
  private txL = new Set<Listener<LiveTx>>();
  private stateL = new Set<Listener<LinkState>>();
  private reconnectL = new Set<() => void>();
  private everConnected = false;
  private openedAt = 0;

  start() {
    if (this.started) return;
    this.started = true;
    this.connect();
    // A socket can go quiet without closing; if blocks stop, recycle it.
    window.setInterval(() => {
      // Silence counts from the later of the last block and this socket's opening.
      if (this.state === 'live' && Date.now() - Math.max(this.lastBlockAt, this.openedAt) > 45000) {
        try { this.ws?.close(); } catch { /* ignore */ }
      }
    }, 10000);
  }

  onBlock(f: Listener<LiveBlock>) { this.blockL.add(f); return () => this.blockL.delete(f); }
  onTx(f: Listener<LiveTx>) { this.txL.add(f); return () => this.txL.delete(f); }
  onState(f: Listener<LinkState>) { this.stateL.add(f); f(this.state); return () => this.stateL.delete(f); }
  /** Fires after a reconnect: time to re-read authoritative state. */
  onReconnect(f: () => void) { this.reconnectL.add(f); return () => this.reconnectL.delete(f); }

  private setState(s: LinkState) {
    if (s === this.state) return;
    this.state = s;
    safeEach(this.stateL, (f) => f(s));
  }

  private connect() {
    this.setState('connecting');
    let ws: WebSocket;
    try { ws = new WebSocket(RPC_WS_URL); } catch { this.retry(); return; }
    this.ws = ws;
    ws.onopen = () => {
      // Backoff resets only once blocks actually flow (see handle), so a dead node isn't hammered.
      this.openedAt = Date.now();
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'subscribe', id: 1, params: { query: "tm.event='NewBlock'" } }));
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'subscribe', id: 2, params: { query: "tm.event='Tx'" } }));
      this.setState('live');
      if (this.everConnected) safeEach(this.reconnectL, (f) => f());
      this.everConnected = true;
    };
    ws.onmessage = (m) => this.handle(m.data);
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = () => { if (this.ws === ws) { this.ws = null; this.retry(); } };
  }

  private retry() {
    this.setState('down');
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30000);
    setTimeout(() => this.connect(), wait);
  }

  private handle(raw: unknown) {
    let msg: any;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg?.error) {
      // The node refused (e.g. too many subscribers): say so and try again later.
      console.warn('[live] subscription refused:', msg.error.message || msg.error);
      this.setState('down');
      try { this.ws?.close(); } catch { /* ignore */ }
      return;
    }
    const data = msg?.result?.data;
    if (!data) return;
    if (data.type === 'tendermint/event/NewBlock') {
      const header = data.value?.block?.header;
      if (!header) return;
      const height = Number(header.height);
      const now = Date.now();
      this.backoff = 1000;
      if (this.lastBlockAt && height === this.height + 1) {
        const dt = (now - this.lastBlockAt) / 1000;
        if (dt > 0.05 && dt < 30) this.blockTime = this.blockTime * 0.8 + dt * 0.2;
      }
      this.height = Math.max(this.height, height);
      this.lastBlockAt = now;
      const b: LiveBlock = { height, time: header.time, txCount: (data.value?.block?.data?.txs || []).length, receivedAt: now };
      safeEach(this.blockL, (f) => f(b));
    } else if (data.type === 'tendermint/event/Tx') {
      const tr = data.value?.TxResult;
      if (!tr) return;
      const events: ChainTxEvent[] = [];
      let signer: string | undefined, action: string | undefined;
      for (const e of tr.result?.events || []) {
        if (e.type === 'message') {
          for (const a of e.attributes || []) {
            if (a.key === 'sender' && !signer) signer = a.value;
            if (a.key === 'action' && !action) action = a.value;
          }
          continue;
        }
        if (!String(e.type).startsWith('structs.structs.')) continue;
        const attr = (e.attributes || []).find((a: { key: string; value: string }) => a.key !== 'msg_index');
        let payload: any = null;
        if (attr) { try { payload = JSON.parse(attr.value); } catch { payload = attr.value; } }
        events.push({ type: e.type.slice('structs.structs.'.length), data: payload });
      }
      const hashes = msg.result?.events?.['tx.hash'];
      const tx: LiveTx = { height: Number(tr.height), hash: Array.isArray(hashes) ? hashes[0] : '', events, signer, action, time: Date.now() };
      safeEach(this.txL, (f) => f(tx));
    }
  }
}

export const live = new LiveFeed();
