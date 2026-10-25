// Transport to the room. Online: a WebSocket to /games/dragon-aces/ws (the Durable Object hub).
// Offline practice: the same Hub/Room code runs in the page and messages loop back without a network.
import { Hub } from '../../shared/hub.js';
import { MSG_SNAPSHOT, PROTOCOL, decodeSnapshot } from '../../shared/protocol.js';

export class Connection {
  constructor({ onMessage, onSnapshot, onClose }) {
    this.onMessage = onMessage;
    this.onSnapshot = onSnapshot;
    this.onClose = onClose;
    this.ws = null;
    this.local = null;
    this.open = false;
    this.rtt = 100;
    this.offset = null; // serverMs - performance.now()
    this.pingTimer = null;
  }

  connectOnline(join) {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const path = location.pathname.replace(/[^/]*$/, '') + 'ws';
      const ws = new WebSocket(`${proto}//${location.host}${path}`);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          ws.close();
          reject(new Error('Could not reach the dragon roost (timed out).'));
        }
      }, 8000);
      ws.onopen = () => {
        this.open = true;
        ws.send(JSON.stringify({ t: 'join', ...join, pv: PROTOCOL }));
      };
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
          const m = JSON.parse(e.data);
          if (!settled && (m.t === 'welcome' || m.t === 'error')) {
            settled = true;
            clearTimeout(timer);
            if (m.t === 'error') reject(new Error(m.msg));
            else resolve(m);
          }
          this.handle(m);
        } else this.handleBinary(e.data);
      };
      ws.onclose = () => {
        this.open = false;
        clearInterval(this.pingTimer);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('The connection closed before the battle started.'));
        } else if (this.onClose) this.onClose();
      };
      ws.onerror = () => {};
    }).then((welcome) => {
      this.startPing();
      return welcome;
    });
  }

  connectOffline(join) {
    this.hub = new Hub();
    let welcome = null;
    const conn = {
      send: (d) => {
        // deliver asynchronously like a network would
        queueMicrotask(() => {
          if (typeof d === 'string') {
            const m = JSON.parse(d);
            if (m.t === 'welcome') welcome = m;
            this.handle(m);
          } else this.handleBinary(d);
        });
      },
      close: () => {},
    };
    this.local = this.hub.connect(conn);
    this.open = true;
    this.local.message(JSON.stringify({ t: 'join', ...join, mode: 'create', bots: true, pv: PROTOCOL }));
    this.rtt = 0;
    return new Promise((resolve) => {
      const wait = () => (welcome ? resolve(welcome) : setTimeout(wait, 5));
      wait();
    });
  }

  startPing() {
    const ping = () => this.send({ t: 'ping', c: performance.now(), rtt: Math.round(this.rtt) });
    ping();
    this.pingTimer = setInterval(ping, 2000);
  }

  handle(m) {
    if (m.t === 'pong') {
      const now = performance.now();
      const rtt = now - m.c;
      this.rtt = this.rtt * 0.7 + rtt * 0.3;
      const off = m.ms + rtt / 2 - now;
      this.offset = this.offset === null ? off : this.offset * 0.8 + off * 0.2;
      return;
    }
    if (m.t === 'welcome' && this.offset === null) this.offset = m.ms - performance.now();
    this.onMessage(m);
  }

  handleBinary(buf) {
    const ab = buf instanceof ArrayBuffer ? buf : buf.buffer;
    if (new Uint8Array(ab)[0] !== MSG_SNAPSHOT) return;
    const snap = decodeSnapshot(ab);
    if (!snap) return;
    // offline there is no ping: lock the clock to the snapshots
    if (this.local) this.offset = snap.ms - performance.now();
    else if (this.offset === null) this.offset = snap.ms - performance.now();
    this.onSnapshot(snap);
  }

  serverNow() {
    return performance.now() + (this.offset || 0);
  }

  send(msg) {
    const data = typeof msg === 'string' || msg instanceof ArrayBuffer ? msg : JSON.stringify(msg);
    if (this.local) {
      this.local.message(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
      return;
    }
    if (this.ws && this.ws.readyState === 1) this.ws.send(data);
  }

  close() {
    clearInterval(this.pingTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }
    if (this.local) {
      this.local.close();
      this.hub.stop();
    }
    this.ws = null;
    this.local = null;
    this.open = false;
  }
}
