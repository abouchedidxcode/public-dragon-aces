// Geometry toolkit for the procedural dragon (dragon-code.js): small vector helpers, a vertex pool ("Part"),
// lofted tubes with arbitrary cross-sections, bezier horns, grid sheets, normals, ambient occlusion and
// skinning weights. Pure JavaScript (no three.js, no DOM) so it also runs in node.
//
// Coordinates here are the Blender-style ones the old rig was authored in: X is the dragon's right,
// Y forward and Z up. dragon-code.js converts to three.js axes (x, z, -y) once, at the very end.

export const TAU = Math.PI * 2;
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const sstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const gauss = (x, c, w) => {
  const d = (x - c) / w;
  return Math.exp(-d * d);
};
export const sgnpow = (x, e) => (x < 0 ? -Math.pow(-x, e) : Math.pow(x, e));

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- 3-vectors as plain arrays
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a) => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const mirrorX = (p) => [-p[0], p[1], p[2]];
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const madd = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

export function segDist(p, a, b) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const l2 = abx * abx + aby * aby + abz * abz || 1e-9;
  const t = clamp(((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / l2, 0, 1);
  return Math.hypot(p[0] - a[0] - abx * t, p[1] - a[1] - aby * t, p[2] - a[2] - abz * t);
}

/** Smooth interpolation through table rows [x, v0, v1, ...] (Catmull-Rom with non-uniform knots). */
export function table(rows) {
  const n = rows.length, m = rows[0].length - 1;
  const tang = rows.map((r, i) => {
    const a = rows[Math.max(0, i - 1)], b = rows[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0] || 1;
    const t = [];
    for (let k = 1; k <= m; k++) t.push((b[k] - a[k]) / dx);
    return t;
  });
  return (x) => {
    const out = new Array(m);
    let i = 0;
    if (x <= rows[0][0]) i = 0;
    else if (x >= rows[n - 1][0]) i = n - 2;
    else {
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (rows[mid][0] <= x) lo = mid;
        else hi = mid;
      }
      i = lo;
    }
    const r0 = rows[i], r1 = rows[i + 1], h = r1[0] - r0[0];
    const t = clamp((x - r0[0]) / h, 0, 1), t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
    for (let k = 0; k < m; k++) out[k] = h00 * r0[k + 1] + h10 * h * tang[i][k] + h01 * r1[k + 1] + h11 * h * tang[i + 1][k];
    return out;
  };
}

/** Cubic bezier through four control points. */
export function bezier(c, t) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
  return [a * c[0][0] + b * c[1][0] + d * c[2][0] + e * c[3][0], a * c[0][1] + b * c[1][1] + d * c[2][1] + e * c[3][1], a * c[0][2] + b * c[1][2] + d * c[2][2] + e * c[3][2]];
}

/** Catmull-Rom spline through points, t in 0..1. */
export function spline(pts, t) {
  const n = pts.length - 1;
  const x = clamp(t, 0, 1) * n;
  const i = Math.min(n - 1, Math.floor(x)), f = x - i;
  const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n, i + 2)];
  const f2 = f * f, f3 = f2 * f;
  const o = [0, 0, 0];
  for (let k = 0; k < 3; k++) o[k] = 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * f + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * f2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * f3);
  return o;
}

// ------------------------------------------------------------------------------------------------------
// vertex pool
// Colour channels (shared with the GLB dragon, see dragon.js): R belly, G keratin (0.5 root .. 1 tip, 0.3 crest
// webbing), B scale class (unused by the code dragon), A mouth interior 1 / tongue 0.75 / crystal 0.25.
export class Part {
  constructor() {
    this.p = [];
    this.n = [];
    this.uv = [];
    this.c = [];
    this.ao = [];
    this.idx = [];
    this.sk = []; // 8 numbers per vertex: i0 w0 i1 w1 i2 w2 i3 w3 (filled by skin*)
  }
  get count() {
    return this.p.length / 3;
  }
  vert(x, y, z, u = 0, v = 0, c0 = 0, c1 = 0, c2 = 0, c3 = 0) {
    const i = this.p.length / 3;
    this.p.push(x, y, z);
    this.n.push(0, 0, 1);
    this.uv.push(u, v);
    this.c.push(c0, c1, c2, c3);
    this.ao.push(1);
    this.sk.push(0, 0, 0, 0, 0, 0, 0, 0);
    return i;
  }
  tri(a, b, c) {
    this.idx.push(a, b, c);
  }
  quad(a, b, c, d) {
    this.idx.push(a, b, c, a, c, d);
  }
  pos(i) {
    return [this.p[i * 3], this.p[i * 3 + 1], this.p[i * 3 + 2]];
  }
  get tris() {
    return this.idx.length / 3;
  }
  append(o) {
    const base = this.count;
    for (const k of ['p', 'n', 'uv', 'c', 'ao', 'sk']) for (let i = 0; i < o[k].length; i++) this[k].push(o[k][i]);
    for (let i = 0; i < o.idx.length; i++) this.idx.push(o.idx[i] + base);
    return base;
  }
  /** flips triangles whose winding disagrees with their vertex normals (for meshes that set normals themselves) */
  orient(from = 0) {
    const p = this.p, n = this.n, idx = this.idx;
    for (let t = 0; t < idx.length; t += 3) {
      if (idx[t] < from) continue;
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
      if (gx * (n[a] + n[b] + n[c]) + gy * (n[a + 1] + n[b + 1] + n[c + 1]) + gz * (n[a + 2] + n[b + 2] + n[c + 2]) < 0) {
        const tmp = idx[t + 1];
        idx[t + 1] = idx[t + 2];
        idx[t + 2] = tmp;
      }
    }
  }
  /** Area-weighted smooth normals over vertices [from, count). */
  normals(from = 0) {
    const p = this.p, n = this.n, idx = this.idx;
    for (let i = from * 3; i < n.length; i++) n[i] = 0;
    for (let t = 0; t < idx.length; t += 3) {
      const ia = idx[t];
      if (ia < from) continue;
      const a = ia * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      n[a] += nx; n[a + 1] += ny; n[a + 2] += nz;
      n[b] += nx; n[b + 1] += ny; n[b + 2] += nz;
      n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
    }
    for (let i = from * 3; i < n.length; i += 3) {
      const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
      n[i] /= l;
      n[i + 1] /= l;
      n[i + 2] /= l;
    }
  }
}

/** Joins parts into one with typed arrays (much cheaper than append for the big meshes). */
export function mergeParts(list) {
  let nv = 0, ni = 0;
  for (const q of list) {
    nv += q.count;
    ni += q.idx.length;
  }
  const m = new Part();
  m.p = new Float32Array(nv * 3);
  m.n = new Float32Array(nv * 3);
  m.uv = new Float32Array(nv * 2);
  m.c = new Float32Array(nv * 4);
  m.ao = new Float32Array(nv);
  m.sk = new Float32Array(nv * 8);
  m.idx = new Uint32Array(ni);
  let vo = 0, io = 0;
  for (const q of list) {
    const c = q.count;
    m.p.set(q.p, vo * 3);
    m.n.set(q.n, vo * 3);
    m.uv.set(q.uv, vo * 2);
    m.c.set(q.c, vo * 4);
    m.ao.set(q.ao, vo);
    m.sk.set(q.sk, vo * 8);
    for (let i = 0; i < q.idx.length; i++) m.idx[io + i] = q.idx[i] + vo;
    vo += c;
    io += q.idx.length;
  }
  return m;
}

/**
 * Tangent frames from the uv layout: xyz is the direction of +u (made perpendicular to the normal), w is the
 * handedness so that cross(normal, tangent) * w points along +v. Returns Float32Array(count * 4).
 */
export function computeTangents(part) {
  const n = part.count, p = part.p, uv = part.uv, nr = part.n, idx = part.idx;
  const tan = new Float32Array(n * 3), bit = new Float32Array(n * 3);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const e1x = p[b * 3] - p[a * 3], e1y = p[b * 3 + 1] - p[a * 3 + 1], e1z = p[b * 3 + 2] - p[a * 3 + 2];
    const e2x = p[c * 3] - p[a * 3], e2y = p[c * 3 + 1] - p[a * 3 + 1], e2z = p[c * 3 + 2] - p[a * 3 + 2];
    const du1 = uv[b * 2] - uv[a * 2], dv1 = uv[b * 2 + 1] - uv[a * 2 + 1];
    const du2 = uv[c * 2] - uv[a * 2], dv2 = uv[c * 2 + 1] - uv[a * 2 + 1];
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-12) continue;
    const r = 1 / det;
    const tx = (e1x * dv2 - e2x * dv1) * r, ty = (e1y * dv2 - e2y * dv1) * r, tz = (e1z * dv2 - e2z * dv1) * r;
    const bx = (e2x * du1 - e1x * du2) * r, by = (e2y * du1 - e1y * du2) * r, bz = (e2z * du1 - e1z * du2) * r;
    for (const v of [a, b, c]) {
      tan[v * 3] += tx; tan[v * 3 + 1] += ty; tan[v * 3 + 2] += tz;
      bit[v * 3] += bx; bit[v * 3 + 1] += by; bit[v * 3 + 2] += bz;
    }
  }
  const out = new Float32Array(n * 4);
  for (let v = 0; v < n; v++) {
    const nx = nr[v * 3], ny = nr[v * 3 + 1], nz = nr[v * 3 + 2];
    let tx = tan[v * 3], ty = tan[v * 3 + 1], tz = tan[v * 3 + 2];
    const d = tx * nx + ty * ny + tz * nz;
    tx -= nx * d; ty -= ny * d; tz -= nz * d;
    let l = Math.hypot(tx, ty, tz);
    if (l < 1e-9) {
      // no uv area here (a cap or a pole): any vector perpendicular to the normal
      tx = Math.abs(nx) < 0.9 ? 1 : 0; ty = tx ? 0 : 1; tz = 0;
      const d2 = tx * nx + ty * ny + tz * nz;
      tx -= nx * d2; ty -= ny * d2; tz -= nz * d2;
      l = Math.hypot(tx, ty, tz) || 1;
    }
    tx /= l; ty /= l; tz /= l;
    const cx = ny * tz - nz * ty, cy = nz * tx - nx * tz, cz = nx * ty - ny * tx;
    out[v * 4] = tx; out[v * 4 + 1] = ty; out[v * 4 + 2] = tz;
    out[v * 4 + 3] = cx * bit[v * 3] + cy * bit[v * 3 + 1] + cz * bit[v * 3 + 2] < 0 ? -1 : 1;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------
// frames along a path (parallel transport)
export function pathFrames(pts, ref = [1, 0, 0]) {
  const n = pts.length, out = [];
  let R = ref;
  let Tprev = null;
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    const T = norm(sub(b, a));
    if (Tprev) {
      // rotate R by the rotation that takes Tprev to T
      const ax = cross(Tprev, T);
      const s = len(ax), c = dot(Tprev, T);
      if (s > 1e-7) {
        const k = mul(ax, 1 / s);
        R = add(add(mul(R, c), mul(cross(k, R), s)), mul(k, dot(k, R) * (1 - c)));
      }
    }
    // orthonormalise R against T
    R = norm(sub(R, mul(T, dot(R, T))));
    const U = cross(R, T);
    out.push({ T, R, U });
    Tprev = T;
  }
  return out;
}

/**
 * Lofted tube. o = {
 *   rings: [{ c:[x,y,z], R, U, cell }]   centre and frame (outline point = c + a R + b U), uv cell size (world units)
 *   N: vertices around (even; vertex 0 is the ventral/inner midline, N/2 the dorsal one)
 *   sec(i, th, s, ring) -> [a, b]       outline point; s = min(th, TAU - th)
 *   attr(i, k, th, s, ring) -> [c0,c1,c2,c3]
 *   cap0, cap1: close the ends with a fan
 * }
 * u runs from the ventral midline (0) to the dorsal midline and is mirrored, so left and right match and the
 * pattern has no seam; v is the distance along the path. Both are counted in cells of ring.cell world units.
 */
export function loft(part, o) {
  const { rings, N, sec, attr } = o;
  const NR = rings.length, half = N >> 1;
  const base = part.count;
  let v = o.v0 || 0;
  const ths = new Float64Array(N);
  for (let k = 0; k < N; k++) ths[k] = (TAU * k) / N;
  const A = new Float64Array(N), Bv = new Float64Array(N), ul = new Float64Array(half + 1);
  for (let i = 0; i < NR; i++) {
    const r = rings[i];
    if (i > 0) {
      const q = rings[i - 1];
      v += Math.hypot(r.c[0] - q.c[0], r.c[1] - q.c[1], r.c[2] - q.c[2]) / (0.5 * ((r.cell || 0.3) + (q.cell || 0.3)));
    }
    for (let k = 0; k < N; k++) {
      const th = ths[k], s = k <= half ? th : TAU - th;
      const ab = sec(i, th, s, r);
      A[k] = ab[0];
      Bv[k] = ab[1];
    }
    ul[0] = 0;
    for (let k = 1; k <= half; k++) ul[k] = ul[k - 1] + Math.hypot(A[k] - A[k - 1], Bv[k] - Bv[k - 1]);
    const cell = r.cell || 0.3;
    for (let k = 0; k < N; k++) {
      const th = ths[k], s = k <= half ? th : TAU - th;
      const a = A[k], b = Bv[k];
      const x = r.c[0] + a * r.R[0] + b * r.U[0], y = r.c[1] + a * r.R[1] + b * r.U[1], z = r.c[2] + a * r.R[2] + b * r.U[2];
      const c = attr ? attr(i, k, th, s, r) : [0, 0, 0, 0];
      part.vert(x, y, z, ul[Math.min(k, N - k)] / cell, v, c[0], c[1], c[2], c[3]);
    }
  }
  const flip = o.flip ? 1 : 0;
  for (let i = 0; i < NR - 1; i++) {
    for (let k = 0; k < N; k++) {
      const k1 = (k + 1) % N;
      const a = base + i * N + k, b = base + i * N + k1, c = base + (i + 1) * N + k1, d = base + (i + 1) * N + k;
      if (flip) part.quad(a, b, c, d);
      else part.quad(a, d, c, b);
    }
  }
  for (const end of [0, 1]) {
    if (!(end ? o.cap1 : o.cap0)) continue;
    const i = end ? NR - 1 : 0, r = rings[i];
    const c = part.vert(r.c[0], r.c[1], r.c[2], 0, end ? v : o.v0 || 0, ...(attr ? attr(i, 0, 0, 0, r) : [0, 0, 0, 0]));
    for (let k = 0; k < N; k++) {
      const a = base + i * N + k, b = base + i * N + ((k + 1) % N);
      if ((end === 1) !== !!flip) part.tri(c, a, b);
      else part.tri(c, b, a);
    }
  }
  return { base, N, NR, v };
}

/** A tapered, curved horn / spike / tooth / claw following a bezier. ctrl: 4 points. */
export function horn(part, ctrl, o = {}) {
  const r0 = o.r0 ?? 0.2, tipR = o.tipR ?? 0.008, rings = o.rings ?? 14, seg = o.seg ?? 8;
  const taper = o.taper ?? 1.2, ratio = o.ratio ?? 1, flare = o.flare ?? 0, ridges = o.ridges ?? 0, ridgeAmp = o.ridgeAmp ?? 0.06;
  const grooves = o.grooves ?? 0, grooveAmp = o.grooveAmp ?? 0.08, c0 = o.c0 ?? 0.5, c1 = o.c1 ?? 1.0;
  const pts = [];
  for (let i = 0; i < rings; i++) pts.push(bezier(ctrl, i / (rings - 1)));
  let ref = o.ref || [0, 0, 1];
  const T0 = norm(sub(pts[1], pts[0]));
  if (Math.abs(dot(ref, T0)) > 0.95) ref = [1, 0, 0];
  const fr = pathFrames(pts, ref);
  let L = 0;
  for (let i = 1; i < rings; i++) L += dist(pts[i], pts[i - 1]);
  const rr = pts.map((_, i) => {
    const t = i / (rings - 1);
    let r = tipR + (r0 - tipR) * Math.pow(1 - t, taper);
    r *= 1 + flare * Math.exp(-t * 14);
    if (ridges) r *= 1 + ridgeAmp * Math.sin(t * L * ridges * 1.0) * (1 - t * 0.5) * Math.min(1, t * 10);
    return r;
  });
  const extra = o.attr;
  const info = loft(part, {
    N: seg,
    rings: pts.map((c, i) => ({ c, R: fr[i].R, U: fr[i].U, cell: o.cell ?? 0.2 })),
    sec: (i, th, s) => {
      const t = i / (rings - 1);
      let r = rr[i];
      if (grooves) r *= 1 + grooveAmp * Math.cos(th * grooves) * (1 - t * 0.6);
      return [Math.sin(th) * r * (o.wide ?? 1), -Math.cos(th) * r * ratio];
    },
    attr: (i, k, th, s, r) => {
      const t = i / (rings - 1);
      const c = [o.belly ?? 0, c0 + (c1 - c0) * t, o.cls ?? 0, o.mouth ?? 0];
      return extra ? extra(c, t, i, k) || c : c;
    },
    cap0: o.cap0 ?? true,
    cap1: true,
    v0: 0,
  });
  info.length = L;
  return info;
}

// ------------------------------------------------------------------------------------------------------
// ambient occlusion from a handful of sphere occluders (cheap contact shadows where parts meet)
export function bakeAO(part, spheres, from = 0, to = part.count, selfSkip = null) {
  for (let i = from; i < to; i++) {
    const px = part.p[i * 3], py = part.p[i * 3 + 1], pz = part.p[i * 3 + 2];
    const nx = part.n[i * 3], ny = part.n[i * 3 + 1], nz = part.n[i * 3 + 2];
    let ao = part.ao[i];
    for (const s of spheres) {
      const dx = s.c[0] - px, dy = s.c[1] - py, dz = s.c[2] - pz;
      const d2 = dx * dx + dy * dy + dz * dz, d = Math.sqrt(d2);
      if (d > s.r * 3.2 || d < s.r * 0.98) continue; // outside its reach, or inside it (its own surface)
      const cosang = (nx * dx + ny * dy + nz * dz) / d;
      if (cosang <= 0) continue;
      const k = (s.r * s.r) / d2;
      ao *= 1 - clamp(cosang * k * (s.w ?? 0.8), 0, 0.8);
    }
    part.ao[i] = ao;
  }
}

/** cavity AO from the loft grid: vertices whose neighbours sit above the tangent plane (sockets, creases) get darker */
export function gridCavityAO(part, info, k = 7, maxv = 0.6) {
  const { base, N, NR } = info;
  const p = part.p, n = part.n;
  for (let i = 0; i < NR; i++) {
    for (let j = 0; j < N; j++) {
      const v = base + i * N + j;
      const nb = [];
      if (i > 0) nb.push(v - N);
      if (i < NR - 1) nb.push(v + N);
      nb.push(base + i * N + ((j + 1) % N), base + i * N + ((j + N - 1) % N));
      let ax = 0, ay = 0, az = 0;
      for (const q of nb) {
        ax += p[q * 3];
        ay += p[q * 3 + 1];
        az += p[q * 3 + 2];
      }
      ax = ax / nb.length - p[v * 3];
      ay = ay / nb.length - p[v * 3 + 1];
      az = az / nb.length - p[v * 3 + 2];
      const c = ax * n[v * 3] + ay * n[v * 3 + 1] + az * n[v * 3 + 2];
      part.ao[v] *= 1 - clamp(c * k, 0, maxv);
    }
  }
}

// ------------------------------------------------------------------------------------------------------
// skinning
const _w = [];
/** weights from a list of [boneIndex, weight]; keeps the four strongest, normalised (does not modify the list) */
export function setSkin(part, vi, list) {
  let i0 = -1, i1 = -1, i2 = -1, i3 = -1;
  let w0 = 0, w1 = 0, w2 = 0, w3 = 0;
  for (let k = 0; k < list.length; k++) {
    const b = list[k][0], w = list[k][1];
    if (w > w0) { i3 = i2; w3 = w2; i2 = i1; w2 = w1; i1 = i0; w1 = w0; i0 = b; w0 = w; }
    else if (w > w1) { i3 = i2; w3 = w2; i2 = i1; w2 = w1; i1 = b; w1 = w; }
    else if (w > w2) { i3 = i2; w3 = w2; i2 = b; w2 = w; }
    else if (w > w3) { i3 = b; w3 = w; }
  }
  let sum = w0 + w1 + w2 + w3;
  if (sum <= 1e-9) {
    i0 = list[0][0];
    w0 = 1;
    sum = 1;
  }
  const o = vi * 8, s = part.sk;
  s[o] = Math.max(i0, 0); s[o + 1] = w0 / sum;
  s[o + 2] = Math.max(i1, 0); s[o + 3] = w1 / sum;
  s[o + 4] = Math.max(i2, 0); s[o + 5] = w2 / sum;
  s[o + 6] = Math.max(i3, 0); s[o + 7] = w3 / sum;
}

/** Rigid binding of every vertex in [from, to) to one bone. */
export function skinRigid(part, from, to, bone) {
  for (let i = from; i < to; i++) setSkin(part, i, [[bone, 1]]);
}

/**
 * Smooth weights along a chain. chain = [boneIndex...] in ascending order of `axis` value, trans[i] is the axis
 * position of the joint between chain[i] and chain[i+1], hw(a, i) the half-width of the blend there.
 */
export function chainWeights(a, chain, trans, hw) {
  const m = chain.length;
  _w.length = 0;
  let prev = 1;
  for (let i = 0; i < m; i++) {
    // weight of bone i = (1 - s_i) * product of previous s
    const s = i < m - 1 ? sstep(trans[i] - hw(a, i), trans[i] + hw(a, i), a) : 1;
    const w = prev * (1 - s);
    prev *= s;
    if (w > 1e-4) _w.push([chain[i], w]);
  }
  if (!_w.length) _w.push([chain[m - 1], 1]);
  return _w.map((x) => [x[0], x[1]]);
}

/** Distance-falloff weights to bone capsules: cand = [{ i, a, b, r, k }] (a, b ends, r radius, k stiffness). */
export function distWeights(p, cand, sigma) {
  const n = cand.length;
  let dmin = Infinity;
  const ds = distWeights.buf || (distWeights.buf = new Float64Array(32));
  for (let j = 0; j < n; j++) {
    const c = cand[j];
    const d = Math.max(0, segDist(p, c.a, c.b) - (c.r || 0));
    ds[j] = d;
    if (d < dmin) dmin = d;
  }
  const out = [];
  const inv = 1 / (2 * sigma * sigma);
  for (let j = 0; j < n; j++) {
    const w = (cand[j].k ?? 1) * Math.exp(-(ds[j] * ds[j] - dmin * dmin) * inv);
    if (w > 1e-3) out.push([cand[j].i, w]);
  }
  return out;
}
