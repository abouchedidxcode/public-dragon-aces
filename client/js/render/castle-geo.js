// The Citadel's geometry, generated from the shared spec (shared/castle.js) so that what you see is what you crash
// into. Pure JS with typed arrays (no three.js): it runs in castle-worker.js, off the main thread.
//
// Every surface is authored with explicit metric UVs (u along the wall, v up it, in metres), so the photoscanned
// stone coursing stays horizontal on tapered, twisted and conical shapes and the texel density is the same on a 5 m
// buttress and a 600 m spire. Each vertex also carries a material layer and a hand-placed occlusion term; the
// baker (castle-bake.js) multiplies in baked sun and ambient occlusion from a voxel model of the whole castle.
//
// Detail levels: 0 is everything (pilasters, string courses, ribs, crockets, dormers, mouldings, ramp brackets),
// 1 drops the small stuff, 2 is the silhouette (still twisted, still spiralled, but a handful of triangles per
// stage). Repeated small parts (merlons, windows, chain links, banners, braziers) come out as instance lists.
import { archHalfWidth, archOutline, buttressPath, castleSpec, CASTLE, towerRadiusAt } from '../../../shared/castle.js';

const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;
export const MAT = { ashlar: 0, rubble: 1, slate: 2, wood: 3, iron: 4, dark: 5 };

// deterministic hash in [0, 1)
export function hash(a, b = 0, c = 0) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ------------------------------------------------------------------------------------------------ mesh builder
export class MeshBuilder {
  constructor() {
    this.n = 0;
    this.ni = 0;
    this.vcap = 8192;
    this.icap = 24576;
    this.pos = new Float32Array(this.vcap * 3);
    this.nrm = new Float32Array(this.vcap * 3);
    this.uv = new Float32Array(this.vcap * 2);
    this.dat = new Uint8Array(this.vcap * 4); // ao, sun (baked later), wet (baked later), material
    this.idx = new Uint32Array(this.icap);
    this.maxEdge = 1e9; // tessellation limit for quads (metres), set per detail level
  }

  grow(v, i) {
    if (this.n + v > this.vcap) {
      let c = this.vcap;
      while (this.n + v > c) c *= 2;
      const p = new Float32Array(c * 3); p.set(this.pos); this.pos = p;
      const n = new Float32Array(c * 3); n.set(this.nrm); this.nrm = n;
      const u = new Float32Array(c * 2); u.set(this.uv); this.uv = u;
      const d = new Uint8Array(c * 4); d.set(this.dat); this.dat = d;
      this.vcap = c;
    }
    if (this.ni + i > this.icap) {
      let c = this.icap;
      while (this.ni + i > c) c *= 2;
      const x = new Uint32Array(c); x.set(this.idx); this.idx = x;
      this.icap = c;
    }
  }

  vert(x, y, z, nx, ny, nz, u, v, mat, ao) {
    const k = this.n++;
    const p = k * 3;
    this.pos[p] = x; this.pos[p + 1] = y; this.pos[p + 2] = z;
    this.nrm[p] = nx; this.nrm[p + 1] = ny; this.nrm[p + 2] = nz;
    this.uv[k * 2] = u; this.uv[k * 2 + 1] = v;
    const d = k * 4;
    this.dat[d] = Math.max(0, Math.min(255, (ao * 255) | 0));
    this.dat[d + 1] = 255;
    this.dat[d + 2] = 255;
    this.dat[d + 3] = mat;
    return k;
  }

  tri(a, b, c) {
    const i = this.ni;
    this.idx[i] = a; this.idx[i + 1] = b; this.idx[i + 2] = c;
    this.ni += 3;
  }

  get tris() { return this.ni / 3; }

  // A flat quad p0 p1 p2 p3 (corners in order around it) with per-corner UVs. The normal is flipped to face the hint.
  // Quads are tessellated to `maxEdge` metres: the baked sun and occlusion live in the vertices, so a 100 m wall
  // needs vertices along it for a tower's shadow to land in its middle. ao is a number or one value per corner.
  quad(x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3, u0, v0, u1, v1, u2, v2, u3, v3, mat, ao, hx, hy, hz) {
    // normal from the diagonals
    let nx = (y2 - y0) * (z3 - z1) - (z2 - z0) * (y3 - y1);
    let ny = (z2 - z0) * (x3 - x1) - (x2 - x0) * (z3 - z1);
    let nz = (x2 - x0) * (y3 - y1) - (y2 - y0) * (x3 - x1);
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return;
    nx /= l; ny /= l; nz /= l;
    const flip = nx * hx + ny * hy + nz * hz < 0;
    if (flip) { nx = -nx; ny = -ny; nz = -nz; }
    const e = this.maxEdge;
    const nu = Math.max(1, Math.min(40, Math.ceil(Math.max(Math.hypot(x1 - x0, y1 - y0, z1 - z0), Math.hypot(x2 - x3, y2 - y3, z2 - z3)) / e)));
    const nv = Math.max(1, Math.min(40, Math.ceil(Math.max(Math.hypot(x3 - x0, y3 - y0, z3 - z0), Math.hypot(x2 - x1, y2 - y1, z2 - z1)) / e)));
    this.grow((nu + 1) * (nv + 1), nu * nv * 6);
    const A = typeof ao === 'number' ? null : ao;
    const a0 = A ? A[0] : ao, a1 = A ? A[1] : ao, a2 = A ? A[2] : ao, a3 = A ? A[3] : ao;
    const base = this.n;
    for (let j = 0; j <= nv; j++) {
      const t = j / nv;
      for (let i = 0; i <= nu; i++) {
        const s = i / nu;
        const w0 = (1 - s) * (1 - t), w1 = s * (1 - t), w2 = s * t, w3 = (1 - s) * t;
        this.vert(
          w0 * x0 + w1 * x1 + w2 * x2 + w3 * x3, w0 * y0 + w1 * y1 + w2 * y2 + w3 * y3, w0 * z0 + w1 * z1 + w2 * z2 + w3 * z3, nx, ny, nz,
          w0 * u0 + w1 * u1 + w2 * u2 + w3 * u3, w0 * v0 + w1 * v1 + w2 * v2 + w3 * v3, mat, w0 * a0 + w1 * a1 + w2 * a2 + w3 * a3,
        );
      }
    }
    const row = nu + 1;
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = base + j * row + i, b = a + 1, c = a + row + 1, d = a + row;
        if (flip) { this.tri(a, d, c); this.tri(a, c, b); } else { this.tri(a, b, c); this.tri(a, c, d); }
      }
    }
  }

  // same with explicit per-corner normals and ao (smooth shading), winding chosen from the hint
  quadS(P, N, U, mat, ao, hx, hy, hz) {
    const nx = (P[7] - P[1]) * (P[11] - P[4]) - (P[8] - P[2]) * (P[10] - P[3]);
    const ny = (P[8] - P[2]) * (P[9] - P[3]) - (P[6] - P[0]) * (P[11] - P[5]);
    const nz = (P[6] - P[0]) * (P[10] - P[4]) - (P[7] - P[1]) * (P[9] - P[3]);
    const flip = nx * hx + ny * hy + nz * hz < 0;
    const e = this.maxEdge;
    const len = (i, j) => Math.hypot(P[j * 3] - P[i * 3], P[j * 3 + 1] - P[i * 3 + 1], P[j * 3 + 2] - P[i * 3 + 2]);
    const nu = Math.max(1, Math.min(40, Math.ceil(Math.max(len(0, 1), len(3, 2)) / e)));
    const nv = Math.max(1, Math.min(40, Math.ceil(Math.max(len(0, 3), len(1, 2)) / e)));
    this.grow((nu + 1) * (nv + 1), nu * nv * 6);
    const base = this.n;
    const aoAt = (k) => (Array.isArray(ao) ? ao[k] : ao);
    for (let j = 0; j <= nv; j++) {
      const t = j / nv;
      for (let i = 0; i <= nu; i++) {
        const s = i / nu;
        const w = [(1 - s) * (1 - t), s * (1 - t), s * t, (1 - s) * t];
        let px = 0, py = 0, pz = 0, qx = 0, qy = 0, qz = 0, u = 0, v = 0, a = 0;
        for (let k = 0; k < 4; k++) {
          px += w[k] * P[k * 3]; py += w[k] * P[k * 3 + 1]; pz += w[k] * P[k * 3 + 2];
          qx += w[k] * N[k * 3]; qy += w[k] * N[k * 3 + 1]; qz += w[k] * N[k * 3 + 2];
          u += w[k] * U[k * 2]; v += w[k] * U[k * 2 + 1]; a += w[k] * aoAt(k);
        }
        const ql = Math.hypot(qx, qy, qz) || 1;
        this.vert(px, py, pz, qx / ql, qy / ql, qz / ql, u, v, mat, a);
      }
    }
    const row = nu + 1;
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = base + j * row + i, b = a + 1, c = a + row + 1, d = a + row;
        if (flip) { this.tri(a, d, c); this.tri(a, c, b); } else { this.tri(a, b, c); this.tri(a, c, d); }
      }
    }
  }

  // a flat triangle, oriented toward the hint
  tri3(x0, y0, z0, x1, y1, z1, x2, y2, z2, u0, v0, u1, v1, u2, v2, mat, ao, hx, hy, hz) {
    this.grow(3, 3);
    let nx = (y1 - y0) * (z2 - z0) - (z1 - z0) * (y2 - y0);
    let ny = (z1 - z0) * (x2 - x0) - (x1 - x0) * (z2 - z0);
    let nz = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return;
    nx /= l; ny /= l; nz /= l;
    const flip = nx * hx + ny * hy + nz * hz < 0;
    if (flip) { nx = -nx; ny = -ny; nz = -nz; }
    const a = this.vert(x0, y0, z0, nx, ny, nz, u0, v0, mat, ao);
    const b = this.vert(x1, y1, z1, nx, ny, nz, u1, v1, mat, ao);
    const c = this.vert(x2, y2, z2, nx, ny, nz, u2, v2, mat, ao);
    if (flip) this.tri(a, c, b); else this.tri(a, b, c);
  }
}

// ------------------------------------------------------------------------------------------------ helpers
// a ring of n points at height y, radius r around (cx, cz), starting at angle a0
export function ring(cx, cz, y, r, n, a0, out) {
  const o = out || new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = a0 + (i * TAU) / n;
    o[i * 3] = cx + Math.cos(a) * r;
    o[i * 3 + 1] = y;
    o[i * 3 + 2] = cz + Math.sin(a) * r;
  }
  return o;
}

// Quads between two rings A (below) and B (above) of n points. v0/v1: metric v at each ring. Faces are flat unless
// `smooth`, where each ring point gets the radial normal (tilted by the slope). hint: [hr, hy] = outward weight and up weight.
export function strip(mb, A, B, n, cx, cz, o) {
  const { mat, ao0 = 1, ao1 = 1, v0 = 0, v1 = 1, hr = 1, hy = 0, smooth = false, uOff = 0, closed = true, a0 = 0 } = o;
  // metric u along each ring
  let uA = uOff, uB = uOff;
  const cnt = closed ? n : n - 1;
  // slope for smooth normals
  const dx = Math.hypot(B[0] - cx, B[2] - cz) - Math.hypot(A[0] - cx, A[2] - cz), dy = B[1] - A[1];
  const sl = Math.hypot(dx, dy) || 1;
  const nrR = dy / sl, nrY = -dx / sl; // radial / vertical parts of the surface normal
  for (let i = 0; i < cnt; i++) {
    const j = (i + 1) % n;
    const ax = A[i * 3], ay = A[i * 3 + 1], az = A[i * 3 + 2];
    const bx = A[j * 3], by = A[j * 3 + 1], bz = A[j * 3 + 2];
    const cx2 = B[j * 3], cy2 = B[j * 3 + 1], cz2 = B[j * 3 + 2];
    const dx2 = B[i * 3], dy2 = B[i * 3 + 1], dz2 = B[i * 3 + 2];
    const lA = Math.hypot(bx - ax, bz - az), lB = Math.hypot(cx2 - dx2, cz2 - dz2);
    // face centre direction for the hint
    const mx = (ax + bx + cx2 + dx2) * 0.25 - cx, mz = (az + bz + cz2 + dz2) * 0.25 - cz;
    const ml = Math.hypot(mx, mz) || 1;
    const hx = (mx / ml) * hr, hz = (mz / ml) * hr;
    if (!smooth) {
      mb.quad(ax, ay, az, bx, by, bz, cx2, cy2, cz2, dx2, dy2, dz2, uA, v0, uA + lA, v0, uB + lB, v1, uB, v1, mat, ao0 === ao1 ? ao0 : [ao0, ao0, ao1, ao1], hx, hy, hz);
    } else {
      const aa = a0 + (i * TAU) / n, ab = a0 + ((i + 1) * TAU) / n;
      const P = [ax, ay, az, bx, by, bz, cx2, cy2, cz2, dx2, dy2, dz2];
      const N = [Math.cos(aa) * nrR, nrY, Math.sin(aa) * nrR, Math.cos(ab) * nrR, nrY, Math.sin(ab) * nrR, Math.cos(ab) * nrR, nrY, Math.sin(ab) * nrR, Math.cos(aa) * nrR, nrY, Math.sin(aa) * nrR];
      mb.quadS(P, N, [uA, v0, uA + lA, v0, uB + lB, v1, uB, v1], mat, [ao0, ao0, ao1, ao1], hx, hy, hz);
    }
    uA += lA; uB += lB;
  }
}

// a box with corners (x0..x1, y0..y1, z0..z1) rotated by yaw about its centre column; all five outer faces
export function boxY(mb, cx, cz, yaw, hw, hd, y0, y1, mat, ao = 1, bottom = false, tex = 1) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  // local (u along yaw, w across): world = c*u - s*w, s*u + c*w ; corners
  const pts = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([u, w]) => [cx + c * u - s * w, cz + s * u + c * w]);
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4];
    const mx = (a[0] + b[0]) / 2 - cx, mz = (a[1] + b[1]) / 2 - cz;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    mb.quad(a[0], y0, a[1], b[0], y0, b[1], b[0], y1, b[1], a[0], y1, a[1], 0, y0 * tex, len, y0 * tex, len, y1 * tex, 0, y1 * tex, mat, ao, mx, 0, mz);
  }
  mb.quad(pts[0][0], y1, pts[0][1], pts[1][0], y1, pts[1][1], pts[2][0], y1, pts[2][1], pts[3][0], y1, pts[3][1], 0, 0, hw * 2, 0, hw * 2, hd * 2, 0, hd * 2, mat, ao, 0, 1, 0);
  if (bottom) mb.quad(pts[0][0], y0, pts[0][1], pts[1][0], y0, pts[1][1], pts[2][0], y0, pts[2][1], pts[3][0], y0, pts[3][1], 0, 0, hw * 2, 0, hw * 2, hd * 2, 0, hd * 2, mat, ao * 0.6, 0, -1, 0);
}

// pyramid spike: square base (half width hw) at (cx, y, cz), apex above
export function spike(mb, cx, y, cz, yaw, hw, h, mat, ao = 1, lean = 0) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const pts = [[-hw, -hw], [hw, -hw], [hw, hw], [-hw, hw]].map(([u, w]) => [cx + c * u - s * w, cz + s * u + c * w]);
  const ax = cx + c * lean, az = cz + s * lean, ay = y + h;
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4];
    const mx = (a[0] + b[0]) / 2 - cx, mz = (a[1] + b[1]) / 2 - cz;
    mb.tri3(a[0], y, a[1], b[0], y, b[1], ax, ay, az, 0, 0, hw * 2, 0, hw, h, mat, ao, mx, 0.4, mz);
  }
}

// ------------------------------------------------------------------------------------------------ detail levels
export const LODP = [
  { seg: 14, belts: true, pil: true, rib: true, crock: true, dorm: true, mould: true, ramp: 34, brackets: true, fb: 14, wallDetail: true, slots: true },
  { seg: 36, belts: true, pil: true, rib: true, crock: false, dorm: true, mould: true, ramp: 14, brackets: false, fb: 7, wallDetail: true, slots: false },
  { seg: 150, belts: false, pil: false, rib: false, crock: false, dorm: false, mould: false, ramp: 7, brackets: false, fb: 3, wallDetail: false, slots: false },
];

// ------------------------------------------------------------------------------------------------ towers
function polyRadius(n, r) {
  return r * Math.cos(Math.PI / n); // apothem: where the flat faces are
}

function addWindows(ctx, t, s, a0) {
  const w = s.win;
  if (!w || !ctx.inst) return;
  const n = s.sides;
  const h = s.y1 - s.y0;
  const rows = w.rows;
  const span = Math.max(0, h - w.start - w.end - w.h);
  const faceStep = n >= 12 ? 2 : 1;
  for (let k = 0; k < rows; k++) {
    const yb = s.y0 + w.start + (rows > 1 ? (span * k) / (rows - 1) : span / 2);
    const tt = (yb + w.h / 2 - s.y0) / h;
    const r = lerp(s.r0, s.r1, tt);
    const phi = a0 + s.twist * tt;
    for (let f = 0; f < n; f += faceStep) {
      // a few faces stay blank so the rhythm is not mechanical
      const hh = hash(t.x * 7 + f, Math.round(yb), k);
      const blind = hh < 0.14 && n > 4; // a few faces keep a blind (unglazed) panel so the rhythm is not mechanical
      // face centre direction; windows of alternate rows are staggered on 12+ sided towers
      const off = n >= 12 && k % 2 ? 1 : 0;
      const ff = (f + off) % n;
      const ang = phi + ((ff + 0.5) * TAU) / n;
      const rr = polyRadius(n, r) + 0.12;
      // a wide face carries a row of windows, not one lonely lancet
      const faceW = 2 * rr * Math.tan(Math.PI / n);
      const nw = Math.max(1, Math.min(4, Math.floor(faceW / 20)));
      const sp = faceW / nw;
      for (let q = 0; q < nw; q++) {
        const lat = (q - (nw - 1) / 2) * sp;
        ctx.windows.push([t.x + Math.cos(ang) * rr - Math.sin(ang) * lat, yb, t.z + Math.sin(ang) * rr + Math.cos(ang) * lat, ang, w.w, w.h, hash(ff, k, t.x + q * 13), blind ? 2 : 0]);
      }
    }
  }
}

function pilasters(mb, t, s, a0, lod, ctx) {
  const n = s.sides;
  const pil = Math.min(n, s.pil);
  if (!pil) return;
  const stepC = Math.max(1, Math.round(n / pil));
  const h = s.y1 - s.y0;
  const hw = s.r0 > 30 ? 1.7 : s.r0 > 18 ? 1.4 : 1.0, d = hw * 1.25;
  const L = s.twist ? Math.max(1, Math.ceil(h / LODP[lod].seg)) : 1;
  for (let c = 0; c < n; c += stepC) {
    let prev = null;
    for (let j = 0; j <= L; j++) {
      const tt = j / L;
      const y = s.y0 + h * tt, r = lerp(s.r0, s.r1, tt);
      const ang = a0 + s.twist * tt + (c * TAU) / n;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const bx = t.x + ca * r, bz = t.z + sa * r;
      const tx = -sa, tz = ca;
      const sec = [
        [bx - tx * hw - ca * 0.5, bz - tz * hw - sa * 0.5],
        [bx + ca * d - tx * hw * 0.6, bz + sa * d - tz * hw * 0.6],
        [bx + ca * d + tx * hw * 0.6, bz + sa * d + tz * hw * 0.6],
        [bx + tx * hw - ca * 0.5, bz + tz * hw - sa * 0.5],
      ];
      if (prev) {
        for (let e = 0; e < 3; e++) {
          const p0 = prev.sec[e], p1 = prev.sec[e + 1], q0 = sec[e], q1 = sec[e + 1];
          const mx = (p0[0] + p1[0]) / 2 - bx, mz = (p0[1] + p1[1]) / 2 - bz;
          const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
          mb.quad(p0[0], prev.y, p0[1], p1[0], prev.y, p1[1], q1[0], y, q1[1], q0[0], y, q0[1], e * 2, prev.y, e * 2 + len, prev.y, e * 2 + len, y, e * 2, y, s.mat, 0.82, mx + ca * 0.1, 0, mz + sa * 0.1);
        }
      }
      prev = { sec, y };
    }
    // sloped cap and a little finial
    const sec = prev.sec;
    const ang = a0 + s.twist + (c * TAU) / n;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const ax = (sec[1][0] + sec[2][0]) / 2 - ca * d * 0.3, az = (sec[1][1] + sec[2][1]) / 2 - sa * d * 0.3;
    for (let e = 0; e < 3; e++) {
      const p0 = sec[e], p1 = sec[e + 1];
      mb.tri3(p0[0], prev.y, p0[1], p1[0], prev.y, p1[1], ax, prev.y + hw * 1.5, az, 0, 0, 2, 0, 1, 1.6, s.mat, 0.9, (p0[0] + p1[0]) / 2 - t.x, 0.7, (p0[1] + p1[1]) / 2 - t.z);
    }
    mb.tri3(sec[0][0], prev.y, sec[0][1], sec[3][0], prev.y, sec[3][1], ax, prev.y + hw * 1.5, az, 0, 0, 2, 0, 1, 1.6, s.mat, 0.9, -ca, 0.7, -sa);
  }
}

// a corbelled string course around the tower at height y
function belt(mb, t, y, r, n, a0, mat) {
  const pr = [[r - 0.2, y - 0.7, 0.55], [r + 1.5, y, 0.7], [r + 1.5, y + 1.5, 1], [r + 0.2, y + 2.3, 1]];
  const rings = pr.map(([rr, yy]) => ring(t.x, t.z, yy, rr, n, a0));
  for (let i = 0; i < 3; i++) {
    const hr = i === 0 ? 0.6 : 1, hy = i === 0 ? -0.8 : i === 2 ? 0.8 : 0;
    strip(mb, rings[i], rings[i + 1], n, t.x, t.z, { mat, ao0: pr[i][2], ao1: pr[i + 1][2], v0: pr[i][1], v1: pr[i + 1][1], hr, hy });
  }
}

function buildShaft(mb, t, s, lod, ctx, nextSeg) {
  const n = s.sides;
  const a0 = t.yaw || 0;
  const h = s.y1 - s.y0;
  const phi0 = a0;
  const L = s.twist ? Math.max(1, Math.ceil(h / LODP[lod].seg)) : 1;
  const smooth = n >= 12;
  // a set-back ledge: the annulus between the lower stage's top radius and this stage's base
  if (s.step) {
    const A = ring(t.x, t.z, s.y0 + 0.4, s.step * 0.98, n, phi0), B = ring(t.x, t.z, s.y0 + 0.4, s.r0, n, phi0);
    strip(mb, B, A, n, t.x, t.z, { mat: s.mat, ao0: 0.75, ao1: 0.95, v0: 0, v1: s.step - s.r0, hr: 0, hy: 1 });
  }
  let prev = ring(t.x, t.z, s.y0, s.r0, n, phi0);
  for (let j = 1; j <= L; j++) {
    const tt = j / L;
    const cur = ring(t.x, t.z, s.y0 + h * tt, lerp(s.r0, s.r1, tt), n, phi0 + s.twist * tt);
    // keep the course lines running through the stages: v is the height plus the slope run
    strip(mb, prev, cur, n, t.x, t.z, { mat: s.mat, v0: prev[1] * 1.0, v1: cur[1] * 1.0, smooth, a0: phi0 + s.twist * ((j - 1) / L), ao0: j === 1 && s.step ? 0.8 : 1, ao1: 1 });
    prev = cur;
  }
  if (LODP[lod].belts && s.belt) {
    for (let k = 1; k <= s.belt; k++) {
      const tt = k / (s.belt + 1);
      belt(mb, t, s.y0 + h * tt, lerp(s.r0, s.r1, tt), n, phi0 + s.twist * tt, s.mat);
    }
  }
  // cornice under a set-back or a roof
  if (LODP[lod].belts && nextSeg && (nextSeg.k === 'roof' || nextSeg.k === 'gallery' || (nextSeg.k === 'shaft' && nextSeg.r0 < s.r1 - 1))) {
    belt(mb, t, s.y1 - 2.4, s.r1, n, phi0 + s.twist, MAT.dark);
  }
  if (LODP[lod].pil) pilasters(mb, t, s, phi0, lod, ctx);
  if (ctx.inst) addWindows(ctx, t, s, phi0);
  // the foot of the tower: a flared plinth where the shaft meets the plateau
  if (lod < 2 && s.y0 < 0 && s.y1 > 20 && t.id !== 'keep') {
    const R = lerp(s.r0, s.r1, (0 - s.y0) / h);
    const rr = Math.min(R * 0.2, 6);
    const prof = [[R + rr, -3, 0.7], [R + rr, 4, 0.85], [R + rr * 0.45, 11, 0.95], [R * 1.0, 15, 1]];
    const rings = prof.map(([r, y]) => ring(t.x, t.z, y, r, n, phi0));
    for (let i = 0; i < 3; i++) strip(mb, rings[i], rings[i + 1], n, t.x, t.z, { mat: MAT.dark, ao0: prof[i][2], ao1: prof[i + 1][2], v0: prof[i][1], v1: prof[i + 1][1], hr: 1, hy: i === 2 ? 0.5 : 0.1 });
    // a coping ledge at the top of the flare
    const cap = ring(t.x, t.z, 4, R + rr, n, phi0), capIn = ring(t.x, t.z, 4, R + rr + 0.9, n, phi0);
    strip(mb, cap, capIn, n, t.x, t.z, { mat: MAT.dark, v0: 0, v1: 1, hr: 0, hy: 1 });
  }
}

function buildGallery(mb, t, s, lod, ctx, nextSeg) {
  const n = s.sides;
  const a0 = t.yaw || 0;
  const y0 = s.y0, rIn = s.r0, rOut = s.r1;
  const neck = nextSeg && nextSeg.k === 'shaft' ? nextSeg.r0 : rIn * 0.8;
  const prof = [
    [rIn - 0.1, 0, 0.5], [rIn + (rOut - rIn) * 0.5, 2.6, 0.6], [rOut - 0.9, 5.4, 0.75], [rOut, 6.0, 0.9],
    [rOut, 8.4, 0.95], [rOut + 0.7, 8.6, 0.9], [rOut + 0.7, 9.6, 1], [rOut, 9.8, 1], [rOut, 14, 1],
  ];
  const rings = prof.map(([r, dy]) => ring(t.x, t.z, y0 + dy, r, n, a0));
  const smooth = n >= 12 && lod < 2;
  for (let i = 0; i < prof.length - 1; i++) {
    const [r0, d0, ao0] = prof[i], [r1, d1, ao1] = prof[i + 1];
    // faces that slope under (flare) face outward and down; ledges face up or down by the sign of the radius change
    const hy = r1 > r0 + 0.2 ? -0.7 : r1 < r0 - 0.2 ? 0.7 : 0;
    strip(mb, rings[i], rings[i + 1], n, t.x, t.z, { mat: s.mat, ao0, ao1, v0: y0 + d0, v1: y0 + d1, hr: 1, hy, smooth: smooth && hy === 0 });
  }
  if (lod === 2) { /* silhouette: skip the inside of the walkway */ }
  // parapet top, inner wall, walkway floor and the neck of the shaft above
  const top = ring(t.x, t.z, y0 + 14, rOut, n, a0), topIn = ring(t.x, t.z, y0 + 14, rOut - 2.4, n, a0);
  strip(mb, topIn, top, n, t.x, t.z, { mat: s.mat, v0: 0, v1: 2.4, hr: 0, hy: 1 });
  const inTop = ring(t.x, t.z, y0 + 14, rOut - 2.4, n, a0), inBot = ring(t.x, t.z, y0 + 9.8, rOut - 2.4, n, a0);
  strip(mb, inBot, inTop, n, t.x, t.z, { mat: s.mat, ao0: 0.7, ao1: 0.9, v0: y0 + 9.8, v1: y0 + 14, hr: -1, hy: 0 });
  const floorOut = ring(t.x, t.z, y0 + 9.8, rOut - 2.4, n, a0), floorIn = ring(t.x, t.z, y0 + 9.8, neck, n, a0);
  strip(mb, floorIn, floorOut, n, t.x, t.z, { mat: MAT.dark, ao0: 0.7, ao1: 0.75, v0: 0, v1: rOut - 2.4 - neck, hr: 0, hy: 1 });
  const nk0 = ring(t.x, t.z, y0 + 9.8, neck, n, a0), nk1 = ring(t.x, t.z, y0 + 14.2, neck, n, a0);
  strip(mb, nk0, nk1, n, t.x, t.z, { mat: s.mat, ao0: 0.6, ao1: 0.9, v0: y0 + 9.8, v1: y0 + 14.2, hr: 1, hy: 0 });
  if (lod < 2 && rOut > 30) {
    // corbelled bartizans (little round corner turrets with conical roofs) jutting from the parapet
    const bn = rOut > 60 ? 8 : rOut > 42 ? 6 : 4;
    for (let k = 0; k < bn; k++) {
      const a = a0 + ((k + 0.5) * TAU) / bn;
      bartizan(mb, ctx, t.x + Math.cos(a) * (rOut - 0.2), t.z + Math.sin(a) * (rOut - 0.2), a, y0 + 14, lod);
    }
  }
  if (ctx.inst && s.merlon) {
    // merlons on the parapet, one per ~6.4 m of the ring (not on every face centre: they follow the circle)
    const rc = rOut - 1.2;
    const m = Math.max(8, Math.round((TAU * rc) / 6.4));
    for (let i = 0; i < m; i++) {
      const a = a0 + (i * TAU) / m;
      ctx.merlons.push([t.x + Math.cos(a) * rc, y0 + 14, t.z + Math.sin(a) * rc, a + Math.PI / 2, 1, 1, 1]);
    }
    // dragon-head gargoyles jutting from the machicolation band
    const gn = Math.max(4, Math.round((TAU * rOut) / 9));
    for (let i = 0; i < gn; i++) {
      const a = a0 + ((i + 0.5) * TAU) / gn;
      ctx.gargoyles.push([t.x + Math.cos(a) * (rOut + 0.1), y0 + 7.2, t.z + Math.sin(a) * (rOut + 0.1), a, 0.9 + 0.5 * hash(i, Math.round(t.x), Math.round(y0)), 0, 0]);
    }
  }
}

// a bartizan: a corbelled drum with a window and a spired cone roof, standing on the parapet top at (x, y, z)
function bartizan(mb, ctx, x, z, ang, y, lod) {
  const n = 8, r = 2.7;
  const prof = [[0.8, y - 5.0, 0.55], [2.0, y - 2.4, 0.65], [r, y - 0.2, 0.8], [r, y + 7.2, 1], [r + 0.5, y + 7.2, 0.9], [r + 0.5, y + 8.2, 1], [r + 0.2, y + 8.5, 1]];
  const rings = prof.map(([rr, yy]) => ring(x, z, yy, rr, n, ang));
  for (let i = 0; i < prof.length - 1; i++) {
    const flare = prof[i + 1][0] > prof[i][0] + 0.2;
    strip(mb, rings[i], rings[i + 1], n, x, z, { mat: MAT.ashlar, ao0: prof[i][2], ao1: prof[i + 1][2], v0: prof[i][1], v1: prof[i + 1][1], hr: 1, hy: flare ? -0.7 : 0 });
  }
  const eave = ring(x, z, y + 8.5, r + 0.2, n, ang), roofTop = ring(x, z, y + 14.5, 0.25, n, ang);
  strip(mb, eave, roofTop, n, x, z, { mat: MAT.slate, v0: 0, v1: 7, hr: 1, hy: 0.45 });
  const cap = ring(x, z, y + 8.5, r + 0.2, n, ang);
  void cap;
  spike(mb, x, y + 14.4, z, ang, 0.35, 5.5, MAT.iron, 1);
  if (ctx.inst) {
    // a lancet in the face that looks along the parapet's outward direction (faces are centred half a step round)
    const fa = ang + Math.PI / n;
    ctx.windows.push([x + Math.cos(fa) * (r * Math.cos(Math.PI / n) + 0.1), y + 1.8, z + Math.sin(fa) * (r * Math.cos(Math.PI / n) + 0.1), fa, 1.7, 4.4, hash(Math.round(x), Math.round(y), Math.round(z)), 0]);
  }
}

function buildRoof(mb, t, s, lod, ctx, last) {
  const n = s.sides;
  const a0 = t.yaw || 0;
  const h = s.y1 - s.y0;
  const L = s.twist ? Math.max(1, Math.ceil(h / LODP[lod].seg)) : 1;
  const smooth = n >= 12 && lod < 2;
  const slopeLen = Math.hypot(h, s.r0 - s.r1);
  // soffit under the eaves, then the slate
  const ov = Math.min(1.8, s.r0 * 0.07 + 0.6);
  const e0 = ring(t.x, t.z, s.y0 - 0.5, s.r0 + ov, n, a0), e1 = ring(t.x, t.z, s.y0, s.r0 * 0.98, n, a0);
  strip(mb, e1, e0, n, t.x, t.z, { mat: MAT.dark, ao0: 0.55, ao1: 0.7, v0: 0, v1: ov, hr: 0.5, hy: -1 });
  let prev = ring(t.x, t.z, s.y0 - 0.5, s.r0 + ov, n, a0);
  const slopeY = (s.r0 - s.r1) / h;
  for (let j = 1; j <= L; j++) {
    const tt = j / L;
    const r = lerp(s.r0 + ov, Math.max(s.r1, 0.12), tt);
    const cur = ring(t.x, t.z, s.y0 - 0.5 + (h + 0.5) * tt, r, n, a0 + s.twist * tt);
    strip(mb, prev, cur, n, t.x, t.z, { mat: MAT.slate, v0: slopeLen * ((j - 1) / L), v1: slopeLen * (j / L), hr: 1, hy: Math.max(0.15, slopeY * 0.9), smooth, a0: a0 + s.twist * ((j - 1) / L), ao0: 1, ao1: 1 });
    prev = cur;
  }
  if (LODP[lod].rib && s.rib && s.r0 > 6) {
    // hip ribs from the eaves to the apex, and crockets along them
    for (let c = 0; c < n; c++) {
      let pr = null;
      const crockets = LODP[lod].crock && s.crockets;
      let spikeAt = 5;
      for (let j = 0; j <= L; j++) {
        const tt = j / L;
        const y = s.y0 - 0.5 + (h + 0.5) * tt, r = lerp(s.r0 + ov, Math.max(s.r1, 0.12), tt);
        const ang = a0 + s.twist * tt + (c * TAU) / n;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const bx = t.x + ca * r, bz = t.z + sa * r;
        const hw = Math.max(0.2, Math.min(0.7, r * 0.05)), lift = hw * 1.1;
        const sec = [[bx - sa * hw, y, bz + ca * hw], [bx, y + lift, bz], [bx + sa * hw, y, bz - ca * hw]];
        if (pr) {
          for (let e = 0; e < 2; e++) {
            const a = pr[e], b = pr[e + 1], c2 = sec[e + 1], d = sec[e];
            mb.quad(a[0], a[1], a[2], b[0], b[1], b[2], c2[0], c2[1], c2[2], d[0], d[1], d[2], 0, 0, 1, 0, 1, slopeLen / L, 0, slopeLen / L, MAT.dark, 0.9, ca, 0.5, sa);
          }
        }
        pr = sec;
        if (crockets && j > 0 && j < L) {
          // a crocket every ~9 m up the hip
          const dist = tt * slopeLen;
          if (dist >= spikeAt) {
            spikeAt += 9;
            spike(mb, bx + ca * hw * 0.5, y, bz + sa * hw * 0.5, ang, Math.min(0.8, hw * 1.4), Math.min(3.2, 1.2 + r * 0.06), MAT.dark, 0.9, 0.5);
          }
        }
      }
    }
  }
  if (LODP[lod].dorm && s.dormers) {
    for (let k = 0; k < s.dormers; k++) {
      const f = Math.floor(((k + 0.5) * n) / s.dormers);
      const tt = 0.28;
      const r = lerp(s.r0 + ov, Math.max(s.r1, 0.12), tt) * Math.cos(Math.PI / n);
      const ang = a0 + s.twist * tt + ((f + 0.5) * TAU) / n;
      const y = s.y0 - 0.5 + (h + 0.5) * tt;
      dormer(mb, ctx, t.x + Math.cos(ang) * r, y, t.z + Math.sin(ang) * r, ang, Math.max(3.6, Math.min(6, r * 0.34)), slopeY);
    }
  }
  if (last && s.r1 < 1.5) finial(mb, t.x, s.y1, t.z, lod, s.r0);
}

// a small gabled dormer window on a roof face
function dormer(mb, ctx, x, y, z, ang, w, slopeY) {
  const ca = Math.cos(ang), sa = Math.sin(ang), tx = -sa, tz = ca;
  const hw = w / 2, wallH = w * 1.15, depth = w * 0.7;
  const fx = x + ca * 0.6, fz = z + sa * 0.6; // front plane sits a little proud of the slope
  const base = (u) => [fx + tx * u, fz + tz * u];
  const L = base(-hw), R = base(hw);
  const gy = y + wallH, peak = gy + hw * 0.95;
  // front wall and gable triangle
  mb.quad(L[0], y - 0.5, L[1], R[0], y - 0.5, R[1], R[0], gy, R[1], L[0], gy, L[1], 0, 0, w, 0, w, wallH, 0, wallH, MAT.ashlar, 0.95, ca, 0, sa);
  mb.tri3(L[0], gy, L[1], R[0], gy, R[1], fx, peak, fz, 0, 0, w, 0, hw, hw, MAT.ashlar, 0.95, ca, 0, sa);
  // roof planes (slate) running back into the slope
  const bx = fx - ca * depth, bz = fz - sa * depth, by = peak + slopeY * -depth * 0.5;
  for (const sg of [-1, 1]) {
    const e = base(sg * hw);
    mb.tri3(e[0], gy, e[1], fx, peak, fz, e[0] - ca * depth, gy - depth * 0.35, e[1] - sa * depth, 0, 0, hw, 0, 0, depth, MAT.dark, 0.7, tx * sg, 0, tz * sg);
    mb.quad(e[0], gy, e[1], fx, peak, fz, bx, by, bz, e[0] - ca * depth, gy - depth * 0.35, e[1] - sa * depth, 0, 0, hw * 1.4, 0, hw * 1.4, depth, 0, depth, MAT.slate, 1, tx * sg * 0.6, 1, tz * sg * 0.6);
  }
  spike(mb, fx + ca * 0.1, peak, fz + sa * 0.1, ang, 0.35, 2.4, MAT.iron, 1);
  ctx.windows.push([fx + ca * 0.1, y + 0.4, fz + sa * 0.1, ang, w * 0.5, wallH * 0.82, hash(Math.round(x), Math.round(y), Math.round(z)), 0]);
}

// needle finial: four-sided spike with a ball
function finial(mb, x, y, z, lod, r0) {
  const len = Math.max(10, Math.min(26, r0 * 4 + 8));
  const rad = Math.max(0.5, Math.min(1.4, r0 * 0.1 + 0.4));
  spike(mb, x, y - 0.3, z, 0.4, rad, len, MAT.iron, 1);
  if (lod < 2) {
    // ball: octahedron
    const by = y + len * 0.28, br = rad * 1.5;
    const pts = [[br, 0, 0], [-br, 0, 0], [0, 0, br], [0, 0, -br]];
    for (let i = 0; i < 4; i++) {
      const a = pts[i], b = pts[(i + 1) % 4];
      mb.tri3(x + a[0], by, z + a[2], x + b[0], by, z + b[2], x, by + br * 1.2, z, 0, 0, 1, 0, 0.5, 1, MAT.iron, 1, a[0] + b[0], 1, a[2] + b[2]);
      mb.tri3(x + a[0], by, z + a[2], x + b[0], by, z + b[2], x, by - br * 1.2, z, 0, 0, 1, 0, 0.5, 1, MAT.iron, 0.7, a[0] + b[0], -1, a[2] + b[2]);
    }
  }
}

// the spiral ramp wound around a tower: a deck with a parapet on the outside, a stone fascia and a sloped soffit
function buildRamp(mb, t, r, lod, ctx) {
  const steps = Math.max(8, Math.round(r.turns * LODP[lod].ramp));
  const prof = (rin, W) => [
    // [radial offset from rin, dy, material, ao, outward hint r, hint y]
    [-0.8, -1.2], [W, -4.8], [W, 0], [W, 3.4], [W - 1.7, 3.4], [W - 1.7, 0], [-0.8, 0],
  ];
  let prev = null;
  let u = 0;
  for (let i = 0; i <= steps; i++) {
    const s = i / steps;
    const ang = r.phase + r.dir * s * r.turns * TAU;
    const y = r.y0 + (r.y1 - r.y0) * s;
    const rin = towerRadiusAt(t, y) * 0.93;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const P = prof(rin, r.width).map(([dr, dy]) => [t.x + ca * (rin + dr), y + dy, t.z + sa * (rin + dr)]);
    if (prev) {
      const seglen = Math.hypot(P[1][0] - prev.P[1][0], P[1][2] - prev.P[1][2]);
      // strips: 0 soffit, 1 outer fascia, 2 parapet outer, 3 parapet top, 4 parapet inner, 5 deck
      const hints = [[0, -1], [1, 0], [1, 0], [0, 1], [-1, 0], [0, 1]];
      const mats = [MAT.dark, MAT.ashlar, MAT.ashlar, MAT.ashlar, MAT.ashlar, MAT.wood];
      const aos = [0.55, 0.9, 1, 1, 0.85, 1];
      const nA = LODP[lod].ramp > 10 ? 6 : 3;
      for (let e = 0; e < 6; e++) {
        if (lod === 2 && (e === 0 || e === 4)) continue;
        const a = prev.P[e], b = prev.P[e + 1], c2 = P[e + 1], d = P[e];
        const mx = (a[0] + b[0] + c2[0] + d[0]) / 4 - t.x, mz = (a[2] + b[2] + c2[2] + d[2]) / 4 - t.z, ml = Math.hypot(mx, mz) || 1;
        const [hr, hy] = hints[e];
        const eu = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        const uu = e === 5 ? seglen : seglen;
        mb.quad(a[0], a[1], a[2], b[0], b[1], b[2], c2[0], c2[1], c2[2], d[0], d[1], d[2], u, 0, u, eu, u + seglen, eu, u + seglen, 0, mats[e], aos[e], (mx / ml) * hr, hy, (mz / ml) * hr);
      }
      u += seglen;
      // brackets under the deck, every ~4 steps
      if (LODP[lod].brackets && i % 3 === 0) {
        const a2 = ang;
        const c = Math.cos(a2), sn = Math.sin(a2);
        const x0 = t.x + c * (rin - 0.5), z0 = t.z + sn * (rin - 0.5);
        const x1 = t.x + c * (rin + r.width * 0.75), z1 = t.z + sn * (rin + r.width * 0.75);
        // a triangular corbel under the soffit
        const tx = -sn * 1.3, tz = c * 1.3;
        for (const sg of [-1, 1]) {
          mb.tri3(x0 + tx * sg, y - 1.2, z0 + tz * sg, x1 + tx * sg, y - 4.8, z1 + tz * sg, x0 + tx * sg, y - 6.5, z0 + tz * sg, 0, 0, 5, 0, 0, 5, MAT.dark, 0.7, tx * sg, 0, tz * sg);
        }
        mb.quad(x0 - tx, y - 6.5, z0 - tz, x0 + tx, y - 6.5, z0 + tz, x1 + tx, y - 4.8, z1 + tz, x1 - tx, y - 4.8, z1 - tz, 0, 0, 2.6, 0, 2.6, 5, 0, 5, MAT.dark, 0.5, 0, -1, 0);
      }
    }
    prev = { P };
  }
  // an arched doorway landing at the top: the observation balcony
  if (lod < 2 && ctx.inst) {
    const endAng = r.phase + r.dir * r.turns * TAU;
    ctx.braziers.push([t.x + Math.cos(endAng) * (towerRadiusAt(t, r.y1) * 0.93 + r.width - 2), r.y1 + 3.4, t.z + Math.sin(endAng) * (towerRadiusAt(t, r.y1) * 0.93 + r.width - 2), 0]);
  }
}

export function buildTower(mb, t, lod, ctx) {
  const segs = t.segs;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const next = segs[i + 1];
    if (s.k === 'shaft') buildShaft(mb, t, s, lod, ctx, next);
    else if (s.k === 'gallery') buildGallery(mb, t, s, lod, ctx, next);
    else buildRoof(mb, t, s, lod, ctx, !next || next.k !== 'roof');
  }
  if (t.ramp) buildRamp(mb, t, t.ramp, lod, ctx);
}
