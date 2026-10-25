// Hit tests shared by the client (its own shots) and the server (bot shots, claim validation).
import { HITBOX } from './constants.js';
import { qrotInv } from './math.js';

const _l = [0, 0, 0], _d = [0, 0, 0];

// Is point p within `pad` of a dragon at pos/quat? (ellipsoid in the dragon's body frame)
export function hitsDragon(p, pos, quat, pad = 0) {
  _d[0] = p[0] - pos[0]; _d[1] = p[1] - pos[1]; _d[2] = p[2] - pos[2];
  if (_d[0] * _d[0] + _d[1] * _d[1] + _d[2] * _d[2] > (HITBOX[0] + pad + 2) ** 2) return false;
  qrotInv(_l, quat, _d);
  const x = _l[0] / (HITBOX[0] + pad), y = _l[1] / (HITBOX[1] + pad), z = _l[2] / (HITBOX[2] + pad);
  return x * x + y * y + z * z <= 1;
}

// Swept test of a segment a->b against a dragon; returns the parameter t in [0,1] of the first hit, or -1.
export function sweepDragon(a, b, pos, quat, pad = 0) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz);
  // quick reject: closest point on segment to the dragon centre
  const t0 = len > 0 ? Math.max(0, Math.min(1, ((pos[0] - a[0]) * dx + (pos[1] - a[1]) * dy + (pos[2] - a[2]) * dz) / (len * len))) : 0;
  const cx = a[0] + dx * t0 - pos[0], cy = a[1] + dy * t0 - pos[1], cz = a[2] + dz * t0 - pos[2];
  if (cx * cx + cy * cy + cz * cz > (HITBOX[0] + pad + 1) ** 2) return -1;
  const steps = Math.max(1, Math.ceil(len / 1.5));
  const p = [0, 0, 0];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    p[0] = a[0] + dx * t; p[1] = a[1] + dy * t; p[2] = a[2] + dz * t;
    if (hitsDragon(p, pos, quat, pad)) return t;
  }
  return -1;
}

// Distance from point p to the ray o + d*s (s >= 0), d unit.
export function distToRay(p, o, d) {
  const px = p[0] - o[0], py = p[1] - o[1], pz = p[2] - o[2];
  const s = Math.max(0, px * d[0] + py * d[1] + pz * d[2]);
  return { dist: Math.hypot(px - d[0] * s, py - d[1] * s, pz - d[2] * s), along: s };
}

// Seeker guidance, shared by the client (the flight you see) and the room (bots deciding when to roll).
// Lead pursuit: steer toward where the target will be when the missile arrives, turning at most `turn`
// rad/s, at constant speed. p, v (missile) and tp, tv (target) are [x, y, z]; v is updated in place.
export function homeSeeker(p, v, tp, tv, dt, turn) {
  const spd = Math.hypot(v[0], v[1], v[2]) || 1;
  const rx = tp[0] - p[0], ry = tp[1] - p[1], rz = tp[2] - p[2];
  const dist = Math.hypot(rx, ry, rz) || 1;
  const closing = Math.max(60, spd - (tv[0] * rx + tv[1] * ry + tv[2] * rz) / dist);
  const lead = Math.min(dist / closing, 2.5);
  let wx = rx + tv[0] * lead, wy = ry + tv[1] * lead, wz = rz + tv[2] * lead;
  const wl = Math.hypot(wx, wy, wz) || 1;
  wx /= wl; wy /= wl; wz /= wl;
  let cx = v[0] / spd, cy = v[1] / spd, cz = v[2] / spd;
  const ang = Math.acos(Math.max(-1, Math.min(1, cx * wx + cy * wy + cz * wz)));
  if (ang > 1e-4) {
    const k = Math.min(1, (turn * dt) / ang);
    cx += (wx - cx) * k; cy += (wy - cy) * k; cz += (wz - cz) * k;
    const cl = Math.hypot(cx, cy, cz) || 1;
    cx /= cl; cy /= cl; cz /= cl;
  }
  v[0] = cx * spd; v[1] = cy * spd; v[2] = cz * spd;
  return dist;
}
