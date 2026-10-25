// The DRAGON ACES room server: the shared Hub/Room code (shared/hub.js, shared/room.js) behind WebSockets. It runs under
// tools/serve.mjs (Node, the `ws` package) or inside a Cloudflare Durable Object. All rooms of the game live in this
// one server; each room simulates bots at 30 Hz and sends snapshots at 20 Hz.
import { Hub } from '../shared/hub.js';

export const paths = ['/ws', '/api/stats'];

const MAX_PAYLOAD = 4 * 1024; // the largest client message is a small JSON event
const MAX_CONN_PER_IP = 24; // a whole room behind one NAT (LAN party, school) still fits
const MAX_MSGS_PER_SEC = 120; // 20 Hz state + fire/hit/burn events + pings
const IDLE_CLOSE_MS = 30_000; // clients ping every 2 s and send state at 20 Hz

export function createServer() {
  const hub = new Hub();
  const conns = new Set();
  const connPerIp = new Map();

  // Workers can't send protocol pings: drop peers that have gone silent.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const c of conns) if (now - c.lastSeen > IDLE_CLOSE_MS) c.ws.close(1001, 'idle');
  }, 5000);

  function onConnection(ws, req) {
    const ip = (req && req.socket && req.socket.remoteAddress) || 'unknown';
    const n = (connPerIp.get(ip) || 0) + 1;
    if (n > MAX_CONN_PER_IP) {
      ws.close(4004, 'too many connections');
      return;
    }
    connPerIp.set(ip, n);

    const c = { ws, lastSeen: Date.now(), windowStart: Date.now(), count: 0, closed: false };
    conns.add(c);
    const handlers = hub.connect({
      send(data) {
        if (!c.closed && ws.readyState === ws.OPEN) ws.send(data);
      },
      close(code, reason) {
        ws.close(code, reason);
      },
    });

    ws.on('message', (data, isBinary) => {
      const now = Date.now();
      c.lastSeen = now;
      if (data.length > MAX_PAYLOAD) {
        ws.close(1009, 'message too big');
        return;
      }
      if (now - c.windowStart > 1000) {
        c.windowStart = now;
        c.count = 0;
      }
      if (++c.count > MAX_MSGS_PER_SEC) return;
      try {
        handlers.message(isBinary ? data : data.toString('utf8'));
      } catch (err) {
        console.error('[dragon-aces] message handler threw:', err);
      }
    });
    ws.on('close', () => {
      if (c.closed) return;
      c.closed = true;
      conns.delete(c);
      const left = (connPerIp.get(ip) || 1) - 1;
      if (left <= 0) connPerIp.delete(ip);
      else connPerIp.set(ip, left);
      handlers.close();
    });
  }

  function fetch(request, path) {
    if (path.split('?')[0] === '/api/stats') {
      return new Response(JSON.stringify(hub.stats()), {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
    return new Response('not found', { status: 404 });
  }

  function stop() {
    clearInterval(sweep);
    for (const c of conns) c.ws.close(1001, 'server stopping');
    conns.clear();
    connPerIp.clear();
    hub.stop();
  }

  return { onConnection, fetch, stop };
}
