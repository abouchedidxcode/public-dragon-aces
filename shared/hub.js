// Matchmaking across rooms. A connection's first message picks a room:
//   { t: 'join', pv, name, breed, mode: 'quick' | 'create' | 'code', code?, bots?, gm?: 'ffa' | 'tdm' }
// pv is the client's PROTOCOL (shared/protocol.js); an old cached page is told to reload instead of joining.
// quick  -> the busiest public room with a free seat (or a new one). Public skies alternate FFA and TDM.
// create -> a new private room with a 4-letter code to share (gm picks Free-for-all or Team Deathmatch)
// code   -> that private room (or a fresh one with that code if it has emptied)
import { MAX_PLAYERS, MODES } from './constants.js';
import { Room } from './room.js';
import { PROTOCOL } from './protocol.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const MAX_ROOMS = 64;

export class Hub {
  constructor({ tickMs = 1000 / 60 } = {}) {
    this.rooms = new Map();
    this.timer = setInterval(() => this.update(), tickMs);
    this.seq = 0;
  }

  update() {
    for (const [code, room] of this.rooms) {
      if (room.humans === 0) {
        this.rooms.delete(code);
        continue;
      }
      try {
        room.update();
      } catch (err) {
        console.error(`[dragon-aces] room ${code} update threw:`, err);
      }
    }
  }

  newCode() {
    for (let i = 0; i < 100; i++) {
      let c = '';
      for (let j = 0; j < 4; j++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      if (!this.rooms.has(c)) return c;
    }
    return 'R' + ++this.seq;
  }

  pick(m) {
    if (m.mode === 'code') {
      const code = String(m.code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
      if (code.length !== 4) return { error: 'That room code is not valid.' };
      let room = this.rooms.get(code);
      if (room && !room.open) return { error: `Room ${code} is full (${MAX_PLAYERS} dragons).` };
      if (!room) room = this.create(code, false, m.bots !== false, m.gm);
      return { room };
    }
    if (m.mode === 'create') return { room: this.create(this.newCode(), false, m.bots !== false, m.gm) };
    let best = null;
    for (const room of this.rooms.values()) {
      if (!room.isPublic || !room.open || room.phase !== 'battle') continue;
      if (!best || room.humans > best.humans) best = room;
    }
    return { room: best || this.create(this.newCode(), true, true) };
  }

  create(code, isPublic, bots, gm = 'ffa') {
    if (this.rooms.size >= MAX_ROOMS) return null;
    const room = new Room({ code, isPublic, bots, mode: MODES[gm] ? gm : 'ffa', playlist: isPublic, seed: Math.floor(Math.random() * 2 ** 31) });
    this.rooms.set(code, room);
    return room;
  }

  // conn: { send(data), close(code, reason) }. Returns the handlers the transport calls.
  connect(conn) {
    let room = null;
    let ent = null;
    return {
      message: (data) => {
        if (ent) {
          room.message(ent, data);
          return;
        }
        if (typeof data !== 'string') return;
        let m;
        try {
          m = JSON.parse(data);
        } catch {
          return;
        }
        if (!m || m.t !== 'join') return;
        if (m.pv !== PROTOCOL) {
          conn.send(JSON.stringify({ t: 'error', msg: 'DRAGON ACES has been updated. Reload the page to join the battle.' }));
          return;
        }
        const { room: r, error } = this.pick(m);
        if (!r) {
          conn.send(JSON.stringify({ t: 'error', msg: error || 'The server is busy, try again in a minute.' }));
          return;
        }
        room = r;
        ent = room.join(conn, m);
        if (!ent) {
          room = null;
          conn.send(JSON.stringify({ t: 'error', msg: 'That room just filled up.' }));
        }
      },
      close: () => {
        if (room && ent) room.leave(ent);
        room = null;
        ent = null;
      },
    };
  }

  stats() {
    let players = 0;
    for (const r of this.rooms.values()) players += r.humans;
    return { rooms: this.rooms.size, players };
  }

  stop() {
    clearInterval(this.timer);
    this.rooms.clear();
  }
}
