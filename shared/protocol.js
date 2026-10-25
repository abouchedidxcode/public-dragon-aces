// Wire format. High-rate data (each client's own dragon, world snapshots) is binary; everything else is
// small JSON event messages ({ t: 'type', ... }).
//
//   client -> server  STATE (27 bytes)
//     u8 type=1 | u8 flags | u16 seq | f32 x y z | i16 qx qy qz qw | u16 speed*50 | u8 throttle*255
//   server -> client  SNAPSHOT
//     u8 type=2 | u32 serverMs | u8 count | count * (u8 id | u8 flags | f32 x y z | i16 q*4 | u16 speed*50 | u8 hp | u8 throttle*255)

// JSON events (room -> client unless noted). Everything below is decided by the room; clients only ask.
//   abil (client -> room)          use the breed ability; the room checks the cooldown and what it hits
//   abil {a,k,ph,...}              an ability: ph 'charge' (telegraphed wind-up, w seconds) then 'fire' (or 'miss' for chain)
//                                  inferno fire {p,d,dur} | nova charge/fire {p,r,hits} | chain charge {tgt} / fire {path,hits}
//                                  / miss {path,tgt,dodged} | acid charge {o,p,r} / fire {p,r,life,z}; all carry cd
//   abilwarn {k,a,w}               (to the target) a Chain Lightning is charging on you: barrel roll to dodge
//   abilno {k} / abilcd {cd}       (to the caster) nothing to hit, refunded / seconds left on the cooldown
//   zone {id,k,o,team,p,r,life}    a lingering napalm ('nap') or acid cloud
//   st {id,k,d}                    status effect for d seconds: chill | corrode | armor | blaze | amp
//   bounty {id,amt}                a dragon is now worth a bounty (0 = cleared)
//   heal {id,hp}                   streak "surge" heal
//   kill adds: med (medals), bounty, rw (streak reward), ts (TDM team kills); dmg kinds add nova chain nap acid
//   match/welcome: mode ('ffa'|'tdm'), teams ([gold, crimson] kills), result ({winner, teams}); ents carry team and bounty
// Bumped whenever a cached client would disagree with the room about the world or the rules (map layout, sizes,
// limits). Clients send it with 'join'; the hub turns away any other version with a "reload the page" error.
//   2: dragons 1.4x with a matching hitbox, 1.65 km map (sky islands and shrines moved), 10 per room, new kill limits
export const PROTOCOL = 2;
export const MSG_STATE = 1;
export const MSG_SNAPSHOT = 2;
const STATE_SIZE = 27;
const ENT_SIZE = 26;
const Q = 32767;

export function encodeState(s, flags, seq) {
  const buf = new ArrayBuffer(STATE_SIZE);
  const v = new DataView(buf);
  v.setUint8(0, MSG_STATE);
  v.setUint8(1, flags);
  v.setUint16(2, seq & 0xffff, true);
  v.setFloat32(4, s.p[0], true);
  v.setFloat32(8, s.p[1], true);
  v.setFloat32(12, s.p[2], true);
  v.setInt16(16, Math.round(s.q[0] * Q), true);
  v.setInt16(18, Math.round(s.q[1] * Q), true);
  v.setInt16(20, Math.round(s.q[2] * Q), true);
  v.setInt16(22, Math.round(s.q[3] * Q), true);
  v.setUint16(24, Math.min(65535, Math.round(s.speed * 50)), true);
  v.setUint8(26, Math.round(Math.max(0, Math.min(1, s.throttle)) * 255));
  return buf;
}

function readQuat(v, o, out) {
  out[0] = v.getInt16(o, true) / Q;
  out[1] = v.getInt16(o + 2, true) / Q;
  out[2] = v.getInt16(o + 4, true) / Q;
  out[3] = v.getInt16(o + 6, true) / Q;
  const l = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
  out[0] /= l; out[1] /= l; out[2] /= l; out[3] /= l;
  return out;
}

// Returns null for anything malformed.
export function decodeState(bytes) {
  if (!bytes || bytes.byteLength !== STATE_SIZE) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint8(0) !== MSG_STATE) return null;
  const p = [v.getFloat32(4, true), v.getFloat32(8, true), v.getFloat32(12, true)];
  if (!p.every(Number.isFinite)) return null;
  return {
    flags: v.getUint8(1),
    seq: v.getUint16(2, true),
    p,
    q: readQuat(v, 16, [0, 0, 0, 1]),
    speed: v.getUint16(24, true) / 50,
    throttle: v.getUint8(26) / 255,
  };
}

export function encodeSnapshot(ms, ents) {
  const buf = new ArrayBuffer(6 + ents.length * ENT_SIZE);
  const v = new DataView(buf);
  v.setUint8(0, MSG_SNAPSHOT);
  v.setUint32(1, ms >>> 0, true);
  v.setUint8(5, ents.length);
  let o = 6;
  for (const e of ents) {
    const s = e.fs;
    v.setUint8(o, e.id);
    v.setUint8(o + 1, e.flags);
    v.setFloat32(o + 2, s.p[0], true);
    v.setFloat32(o + 6, s.p[1], true);
    v.setFloat32(o + 10, s.p[2], true);
    v.setInt16(o + 14, Math.round(s.q[0] * Q), true);
    v.setInt16(o + 16, Math.round(s.q[1] * Q), true);
    v.setInt16(o + 18, Math.round(s.q[2] * Q), true);
    v.setInt16(o + 20, Math.round(s.q[3] * Q), true);
    v.setUint16(o + 22, Math.min(65535, Math.round(s.speed * 50)), true);
    v.setUint8(o + 24, Math.max(0, Math.min(255, Math.ceil(e.hp))));
    v.setUint8(o + 25, Math.round(Math.max(0, Math.min(1, s.throttle)) * 255));
    o += ENT_SIZE;
  }
  return buf;
}

export function decodeSnapshot(buf) {
  const v = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer, buf.byteOffset || 0, buf.byteLength);
  if (v.getUint8(0) !== MSG_SNAPSHOT) return null;
  const ms = v.getUint32(1, true);
  const n = v.getUint8(5);
  const ents = [];
  let o = 6;
  for (let i = 0; i < n; i++) {
    ents.push({
      id: v.getUint8(o),
      flags: v.getUint8(o + 1),
      p: [v.getFloat32(o + 2, true), v.getFloat32(o + 6, true), v.getFloat32(o + 10, true)],
      q: readQuat(v, o + 14, [0, 0, 0, 1]),
      speed: v.getUint16(o + 22, true) / 50,
      hp: v.getUint8(o + 24),
      throttle: v.getUint8(o + 25) / 255,
    });
    o += ENT_SIZE;
  }
  return { ms, ents };
}
