// The Citadel's walls, arch walls (gate, viaducts, bridges), flying buttresses, instance lists and the courtyard,
// plus the entry point that assembles every structure at a given detail level. See castle-geo.js for the tower
// modules and the mesh builder.
import { archOutline, buttressPath, castleSpec, CASTLE, towerRadiusAt } from '../../../shared/castle.js';
import { boxY, buildTower, hash, LODP, MAT, MeshBuilder, ring, spike, strip } from './castle-geo.js';

const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;

// ------------------------------------------------------------------------------------------------ straight wall
export function buildWall(mb, w, lod, ctx, centre = [0, 0]) {
  const dx = w.x2 - w.x1, dz = w.z2 - w.z1;
  const L = Math.hypot(dx, dz);
  const ux = dx / L, uz = dz / L;
  let nx = -uz, nz = ux;
  const mx = (w.x1 + w.x2) / 2 - centre[0], mz = (w.z1 + w.z2) / 2 - centre[1];
  if (nx * mx + nz * mz < 0) { nx = -nx; nz = -nz; }
  const hw = w.t / 2, y0 = w.y0, y1 = w.y1;
  const batter = 4.2;
  const P = (s, off, y) => [w.x1 + ux * s + nx * off, y, w.z1 + uz * s + nz * off];
  // outer and inner faces (battered), top, end caps
  for (const side of [1, -1]) {
    const a = P(0, side * (hw + batter), y0), b = P(L, side * (hw + batter), y0), c = P(L, side * (hw - 0.4), y1), d = P(0, side * (hw - 0.4), y1);
    mb.quad(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2], 0, y0, L, y0, L, y1, 0, y1, MAT.rubble, 1, nx * side, 0, nz * side);
  }
  const t0 = P(0, hw, y1), t1 = P(L, hw, y1), t2 = P(L, -hw, y1), t3 = P(0, -hw, y1);
  mb.quad(t0[0], y1, t0[2], t1[0], y1, t1[2], t2[0], y1, t2[2], t3[0], y1, t3[2], 0, 0, L, 0, L, w.t, 0, w.t, MAT.dark, 0.9, 0, 1, 0);
  for (const s of [0, L]) {
    const a = P(s, hw + batter, y0), b = P(s, -hw - batter, y0), c = P(s, -hw + 0.4, y1), d = P(s, hw - 0.4, y1);
    mb.quad(a[0], y0, a[2], b[0], y0, b[2], c[0], y1, c[2], d[0], y1, d[2], 0, y0, w.t, y0, w.t, y1, 0, y1, MAT.rubble, 0.8, ux * (s ? 1 : -1), 0, uz * (s ? 1 : -1));
  }
  // machicolated outer parapet (overhanging, with a sloped underside) and a low inner one
  const up = 5.4;
  const po = hw + 1.6;
  const m0 = P(0, hw - 0.4, y1 - 4), m1 = P(L, hw - 0.4, y1 - 4), m2 = P(L, po, y1 - 0.4), m3 = P(0, po, y1 - 0.4);
  mb.quad(m0[0], m0[1], m0[2], m1[0], m1[1], m1[2], m2[0], m2[1], m2[2], m3[0], m3[1], m3[2], 0, 0, L, 0, L, 4, 0, 4, MAT.dark, 0.55, nx, -0.9, nz);
  const o0 = P(0, po, y1 - 0.4), o1 = P(L, po, y1 - 0.4), o2 = P(L, po, y1 + up), o3 = P(0, po, y1 + up);
  mb.quad(o0[0], o0[1], o0[2], o1[0], o1[1], o1[2], o2[0], o2[1], o2[2], o3[0], o3[1], o3[2], 0, y1, L, y1, L, y1 + up + 0.4, 0, y1 + up + 0.4, MAT.ashlar, 1, nx, 0, nz);
  const pi = po - 2.4;
  const i0 = P(0, pi, y1), i1 = P(L, pi, y1), i2 = P(L, pi, y1 + up), i3 = P(0, pi, y1 + up);
  mb.quad(i0[0], i0[1], i0[2], i1[0], i1[1], i1[2], i2[0], i2[1], i2[2], i3[0], i3[1], i3[2], 0, y1, L, y1, L, y1 + up, 0, y1 + up, MAT.ashlar, 0.8, -nx, 0, -nz);
  const tp0 = P(0, po, y1 + up), tp1 = P(L, po, y1 + up), tp2 = P(L, pi, y1 + up), tp3 = P(0, pi, y1 + up);
  mb.quad(tp0[0], tp0[1], tp0[2], tp1[0], tp1[1], tp1[2], tp2[0], tp2[1], tp2[2], tp3[0], tp3[1], tp3[2], 0, 0, L, 0, L, 2.4, 0, 2.4, MAT.ashlar, 1, 0, 1, 0);
  // low inner parapet
  const qi = -hw - 0.2, qo = qi + 1.8;
  const l0 = P(0, qi, y1), l1 = P(L, qi, y1), l2 = P(L, qi, y1 + 2.6), l3 = P(0, qi, y1 + 2.6);
  mb.quad(l0[0], l0[1], l0[2], l1[0], l1[1], l1[2], l2[0], l2[1], l2[2], l3[0], l3[1], l3[2], 0, y1, L, y1, L, y1 + 2.6, 0, y1 + 2.6, MAT.ashlar, 0.9, -nx, 0, -nz);
  const l4 = P(0, qo, y1 + 2.6), l5 = P(L, qo, y1 + 2.6);
  mb.quad(l3[0], l3[1], l3[2], l2[0], l2[1], l2[2], l5[0], l5[1], l5[2], l4[0], l4[1], l4[2], 0, 0, L, 0, L, 1.8, 0, 1.8, MAT.ashlar, 1, 0, 1, 0);
  const l6 = P(0, qo, y1), l7 = P(L, qo, y1);
  mb.quad(l4[0], l4[1], l4[2], l5[0], l5[1], l5[2], l7[0], l7[1], l7[2], l6[0], l6[1], l6[2], 0, y1, L, y1, L, y1 + 2.6, 0, y1 + 2.6, MAT.ashlar, 0.8, nx, 0, nz);
  const yaw = Math.atan2(uz, ux);
  if (lod === 0) {
    // a row of corbels under the machicolations
    const nc = Math.floor(L / 3.4);
    for (let k = 0; k < nc; k++) {
      const s0 = (k + 0.5) * (L / nc);
      if (hash(k, Math.round(w.x1), Math.round(w.z1)) < 0.1) continue;
      const c = P(s0, po - 0.9, 0);
      boxY(mb, c[0], c[2], yaw, 0.5, 0.9, y1 - 3.6, y1 - 0.5, MAT.dark, 0.75);
    }
  }
  if (lod < 2) {
    // timber hoardings projecting over the outer parapet here and there
    const nh = Math.floor(L / 70);
    for (let k = 0; k < nh; k++) {
      const s0 = (k + 0.5) * (L / nh);
      const hl = 7.5, out = 3.4, y_b = y1 + 0.5, y_t = y1 + up + 3.6;
      const a = P(s0 - hl, po, y_b), b = P(s0 + hl, po, y_b), c = P(s0 + hl, po + out, y_b - 1.2), d = P(s0 - hl, po + out, y_b - 1.2);
      mb.quad(a[0], y_b, a[2], b[0], y_b, b[2], c[0], c[1], c[2], d[0], d[1], d[2], 0, 0, hl * 2, 0, hl * 2, out, 0, out, MAT.wood, 0.6, nx * 0.5, -1, nz * 0.5);
      const f0 = P(s0 - hl, po + out, y_b - 1.2), f1 = P(s0 + hl, po + out, y_b - 1.2), f2 = P(s0 + hl, po + out, y_t - 1.0), f3 = P(s0 - hl, po + out, y_t - 1.0);
      mb.quad(f0[0], f0[1], f0[2], f1[0], f1[1], f1[2], f2[0], f2[1], f2[2], f3[0], f3[1], f3[2], 0, 0, hl * 2, 0, hl * 2, y_t - y_b, 0, y_t - y_b, MAT.wood, 0.95, nx, 0, nz);
      const r0 = P(s0 - hl - 0.4, po - 0.2, y_t + 1.2), r1 = P(s0 + hl + 0.4, po - 0.2, y_t + 1.2), r2 = P(s0 + hl + 0.4, po + out + 0.9, y_t - 1.3), r3 = P(s0 - hl - 0.4, po + out + 0.9, y_t - 1.3);
      mb.quad(r0[0], r0[1], r0[2], r1[0], r1[1], r1[2], r2[0], r2[1], r2[2], r3[0], r3[1], r3[2], 0, 0, hl * 2, 0, hl * 2, 6, 0, 6, MAT.slate, 1, nx * 0.5, 1, nz * 0.5);
      for (const e of [-hl, hl]) {
        const e0 = P(s0 + e, po, y_b), e1 = P(s0 + e, po + out, y_b - 1.2), e2 = P(s0 + e, po + out, y_t - 1.0), e3 = P(s0 + e, po, y_t + 1.0);
        mb.quad(e0[0], e0[1], e0[2], e1[0], e1[1], e1[2], e2[0], e2[1], e2[2], e3[0], e3[1], e3[2], 0, 0, out, 0, out, y_t - y_b, 0, y_t - y_b, MAT.wood, 0.8, ux * Math.sign(e), 0, uz * Math.sign(e));
      }
    }
  }
  if (LODP[lod].wallDetail) {
    // stepped buttress piers on both faces every ~32 m, away from the ends
    const count = Math.max(0, Math.floor((L - 90) / 32));
    const start = (L - count * 32) / 2;
    for (let k = 0; k <= count; k++) {
      const s = start + k * 32;
      if (s < 44 || s > L - 44) continue;
      for (const side of [1, -1]) {
        const base = hw + batter * 0.55;
        const c1 = P(s, side * (base + 2.6), 0);
        boxY(mb, c1[0], c1[2], yaw, 3.1, 3.4, y0, y1 * 0.64, MAT.rubble, 0.95);
        const c2 = P(s, side * (base + 1.4), 0);
        boxY(mb, c2[0], c2[2], yaw, 2.2, 2.4, y1 * 0.64, y1 - 1.2, MAT.rubble, 0.95);
        spike(mb, c2[0], y1 - 1.2, c2[2], yaw, 2.0, 6.5, MAT.dark, 0.95);
      }
    }
  }
  if (ctx.inst) {
    // merlons along the outer parapet, arrow slits along the face
    const m = Math.max(2, Math.floor(L / 6.2));
    for (let k = 0; k < m; k++) {
      const s = ((k + 0.5) * L) / m;
      const p = P(s, po - 1.2, y1 + up);
      ctx.merlons.push([p[0], y1 + up, p[2], yaw, 1, 1, 1]);
    }
    const sl = Math.floor(L / 15);
    for (let k = 0; k < sl; k++) {
      const s = ((k + 0.5) * L) / sl;
      const outAng = Math.atan2(nz, nx);
      const px = w.x1 + ux * s + nx * (hw + 2.0), pz = w.z1 + uz * s + nz * (hw + 2.0);
      ctx.windows.push([px, y1 * 0.46, pz, outAng, 1.0, 7, hash(Math.round(px), Math.round(pz)), 1]);
    }
  }
}

// ------------------------------------------------------------------------------------------------ arch walls
// an extruded outline: quads between consecutive outline points, from depth w0 to w1
function bayFrame(b) {
  const cs = Math.cos(b.yaw), sn = Math.sin(b.yaw);
  return { cs, sn, P: (u, w, y) => [b.x + cs * u - sn * w, y, b.z + sn * u + cs * w] };
}

export function buildBay(mb, b, lod, ctx) {
  const { cs, sn, P } = bayFrame(b);
  const hl = b.len / 2, hw = b.thick / 2;
  const y0 = b.y0, y1 = b.y1;
  const o = b.open;
  const wx = -sn, wz = cs; // across the bay
  const mat = b.sky ? MAT.ashlar : MAT.ashlar;
  const quadAt = (u0, y_0, u1, y_1, w, side, m, ao) => {
    const A = P(u0, w, y_0), B = P(u1, w, y_0), C = P(u1, w, y_1), D = P(u0, w, y_1);
    const uo = side > 0 ? 0 : 300;
    mb.quad(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2], D[0], D[1], D[2], uo + u0, y_0, uo + u1, y_0, uo + u1, y_1, uo + u0, y_1, m, ao, wx * side, 0, wz * side);
  };
  const outlinePts = o ? archOutline(o.a, o.spring, o.rise, o.type, lod === 2 ? 5 : 12) : null;
  for (const side of [1, -1]) {
    const w = side * hw;
    if (!o) {
      quadAt(-hl, y0, hl, y1, w, side, mat, 1);
      continue;
    }
    quadAt(-hl, y0, -o.a, y1, w, side, mat, 1);
    quadAt(o.a, y0, hl, y1, w, side, mat, 1);
    // the wall above the opening, in strips that follow the arch
    const arc = outlinePts.filter((p) => p[1] >= o.spring - 1e-6);
    for (let i = 0; i < arc.length - 1; i++) {
      const a = arc[i], c = arc[i + 1];
      const A = P(a[0], w, o.floor + a[1]), B = P(c[0], w, o.floor + c[1]), C = P(c[0], w, y1), D = P(a[0], w, y1);
      const uo = side > 0 ? 0 : 300;
      mb.quad(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2], D[0], D[1], D[2], uo + a[0], o.floor + a[1], uo + c[0], o.floor + c[1], uo + c[0], y1, uo + a[0], y1, mat, 1, wx * side, 0, wz * side);
    }
  }
  // end faces
  for (const e of [-1, 1]) {
    const A = P(e * hl, -hw, y0), B = P(e * hl, hw, y0), C = P(e * hl, hw, y1), D = P(e * hl, -hw, y1);
    mb.quad(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2], D[0], D[1], D[2], 0, y0, b.thick, y0, b.thick, y1, 0, y1, MAT.rubble, 0.8, cs * e, 0, sn * e);
  }
  // the passage itself: intrados and jambs, and a paved floor where the opening starts at the ground
  if (o) {
    const cuv = P(0, 0, o.floor + o.spring + o.rise * 0.4);
    let arcLen = 0;
    for (let i = 0; i < outlinePts.length - 1; i++) {
      const a = outlinePts[i], c = outlinePts[i + 1];
      const seg = Math.hypot(c[0] - a[0], c[1] - a[1]);
      const A = P(a[0], -hw, o.floor + a[1]), B = P(a[0], hw, o.floor + a[1]), C = P(c[0], hw, o.floor + c[1]), D = P(c[0], -hw, o.floor + c[1]);
      const mxw = (A[0] + B[0] + C[0] + D[0]) / 4, myw = (A[1] + B[1] + C[1] + D[1]) / 4, mzw = (A[2] + B[2] + C[2] + D[2]) / 4;
      mb.quad(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2], D[0], D[1], D[2], 0, arcLen, b.thick, arcLen, b.thick, arcLen + seg, 0, arcLen + seg, MAT.ashlar, 0.6, cuv[0] - mxw, cuv[1] - myw, cuv[2] - mzw);
      arcLen += seg;
    }
    if (y0 < o.floor - 1 && b.floor !== false && (o.floor === 0 || b.paved)) {
      const fy = o.floor + 0.25;
      const A = P(-o.a, -hw - 12, fy), B = P(o.a, -hw - 12, fy), C = P(o.a, hw + 12, fy), D = P(-o.a, hw + 12, fy);
      mb.quad(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2], D[0], D[1], D[2], 0, 0, o.a * 2, 0, o.a * 2, b.thick + 24, 0, b.thick + 24, MAT.dark, 0.85, 0, 1, 0);
    }
    // archivolt mouldings: stepped rings that stand proud of both faces
    if (LODP[lod].mould && b.mould) {
      const mOut = (k) => archOutline(o.a + (k + 1) * 2.3, o.spring, o.rise + (k + 1) * 2.9, o.type, lod === 2 ? 5 : 12);
      let inner = outlinePts, innerD = 0;
      for (let k = 0; k < b.mould; k++) {
        const outer = mOut(k);
        const d = 0.9 + k * 0.5 > 2.4 ? 2.4 : 0.9 + k * 0.5; // each ring stands a little further out than the one inside it
        for (const side of [1, -1]) {
          for (let i = 0; i < inner.length - 1; i++) {
            const a0 = inner[i], a1 = inner[i + 1], c0 = outer[i], c1 = outer[i + 1];
            const wf = side * (hw + d), wi = side * (hw + innerD);
            // face of the ring
            const A = P(a0[0], wf, o.floor + a0[1]), B = P(a1[0], wf, o.floor + a1[1]), C = P(c1[0], wf, o.floor + c1[1]), D = P(c0[0], wf, o.floor + c0[1]);
            mb.quad(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2], D[0], D[1], D[2], a0[0], a0[1], a1[0], a1[1], c1[0], c1[1], c0[0], c0[1], MAT.dark, 0.95, wx * side, 0, wz * side);
            // reveal on the opening side (from the face of the ring back to the previous level)
            const R0 = P(a0[0], wf, o.floor + a0[1]), R1 = P(a1[0], wf, o.floor + a1[1]), R2 = P(a1[0], wi, o.floor + a1[1]), R3 = P(a0[0], wi, o.floor + a0[1]);
            mb.quad(R0[0], R0[1], R0[2], R1[0], R1[1], R1[2], R2[0], R2[1], R2[2], R3[0], R3[1], R3[2], 0, 0, 1, 0, 1, 1, 0, 1, MAT.dark, 0.7, cuv[0] - (R0[0] + R2[0]) / 2, cuv[1] - (R0[1] + R2[1]) / 2, cuv[2] - (R0[2] + R2[2]) / 2);
            // outer edge (back to the wall)
            const E0 = P(c0[0], wf, o.floor + c0[1]), E1 = P(c1[0], wf, o.floor + c1[1]), E2 = P(c1[0], side * hw, o.floor + c1[1]), E3 = P(c0[0], side * hw, o.floor + c0[1]);
            mb.quad(E0[0], E0[1], E0[2], E1[0], E1[1], E1[2], E2[0], E2[1], E2[2], E3[0], E3[1], E3[2], 0, 0, 1, 0, 1, 1, 0, 1, MAT.dark, 0.8, (E0[0] + E2[0]) / 2 - cuv[0], (E0[1] + E2[1]) / 2 - cuv[1], (E0[2] + E2[2]) / 2 - cuv[2]);
          }
        }
        inner = outer; innerD = d;
      }
    }
  }
  // the top: deck (boards on bridges, stone on gatehouses), parapets, merlons, pinnacles
  const deckMat = b.deck ? MAT.wood : MAT.dark;
  {
    const A = P(-hl, -hw, y1), B = P(hl, -hw, y1), C = P(hl, hw, y1), D = P(-hl, hw, y1);
    mb.quad(A[0], y1, A[2], B[0], y1, B[2], C[0], y1, C[2], D[0], y1, D[2], 0, 0, b.len, 0, b.len, b.thick, 0, b.thick, deckMat, 0.95, 0, 1, 0);
  }
  if (b.parapet) {
    const up = 5.2;
    for (const side of [1, -1]) {
      const wo = side * hw, wi = side * (hw - 2.2);
      const o0 = P(-hl, wo, y1), o1 = P(hl, wo, y1), o2 = P(hl, wo, y1 + up), o3 = P(-hl, wo, y1 + up);
      mb.quad(o0[0], y1, o0[2], o1[0], y1, o1[2], o2[0], y1 + up, o2[2], o3[0], y1 + up, o3[2], 0, y1, b.len, y1, b.len, y1 + up, 0, y1 + up, MAT.ashlar, 1, wx * side, 0, wz * side);
      const i0 = P(-hl, wi, y1), i1 = P(hl, wi, y1), i2 = P(hl, wi, y1 + up), i3 = P(-hl, wi, y1 + up);
      mb.quad(i0[0], y1, i0[2], i1[0], y1, i1[2], i2[0], y1 + up, i2[2], i3[0], y1 + up, i3[2], 0, y1, b.len, y1, b.len, y1 + up, 0, y1 + up, MAT.ashlar, 0.8, -wx * side, 0, -wz * side);
      const t0 = P(-hl, wo, y1 + up), t1 = P(hl, wo, y1 + up), t2 = P(hl, wi, y1 + up), t3 = P(-hl, wi, y1 + up);
      mb.quad(t0[0], y1 + up, t0[2], t1[0], y1 + up, t1[2], t2[0], y1 + up, t2[2], t3[0], y1 + up, t3[2], 0, 0, b.len, 0, b.len, 2.2, 0, 2.2, MAT.ashlar, 1, 0, 1, 0);
      if (ctx.inst) {
        const m = Math.max(2, Math.floor(b.len / 6.2));
        for (let k = 0; k < m; k++) {
          const u = -hl + ((k + 0.5) * b.len) / m;
          const p = P(u, side * (hw - 1.1), y1 + up);
          ctx.merlons.push([p[0], y1 + up, p[2], b.yaw, 1, 1, 1]);
        }
      }
    }
  }
  if (b.parapet && lod < 2) {
    // a pinnacle on each corner of the deck
    for (const e of [-1, 1]) {
      for (const side of [-1, 1]) {
        const p = P(e * (hl - 1.3), side * (hw - 1.3), y1 + 5.2);
        boxY(mb, p[0], p[2], b.yaw, 1.3, 1.3, y1 + 4.8, y1 + 7.2, MAT.ashlar, 1);
        spike(mb, p[0], y1 + 7.2, p[2], b.yaw, 1.0, 8 + 3 * hash(Math.round(p[0]), Math.round(p[2])), MAT.dark, 1);
      }
    }
  }
  if (b.gable) {
    // a row of pinnacles along the crown; the middle one is the tallest
    const n = b.len > 90 ? 7 : 5;
    for (let k = 0; k < n; k++) {
      const f = k / (n - 1);
      const u = lerp(-hl * 0.86, hl * 0.86, f);
      const h = 16 + 30 * (1 - Math.abs(f - 0.5) * 2) * (b.len > 90 ? 1.0 : 0.7);
      const p = P(u, 0, y1 + 5.2);
      boxY(mb, p[0], p[2], b.yaw, 2.2, 2.2, y1 + 5.2, y1 + 9, MAT.ashlar, 1);
      spike(mb, p[0], y1 + 9, p[2], b.yaw, 1.5, h, MAT.dark, 1);
      const q = P(u, 0, y1 + 9 + h * 0.6);
      spike(mb, q[0], q[1], q[2], b.yaw + Math.PI / 4, 0.4, 5, MAT.iron, 1);
    }
    if (ctx.inst && b.len > 90) {
      // tall windows in the wall above the passage
      for (const side of [1, -1]) {
        for (let k = -3; k <= 3; k++) {
          if (Math.abs(k) < 1 && false) continue;
          const u = k * 12;
          if (o && Math.abs(u) + 6 > hl - 3) continue;
          const apex = o ? o.floor + o.spring + o.rise : 0;
          const wy = apex + 12;
          if (wy + 24 > y1) continue;
          const p = P(u, side * (hw + 0.1), wy);
          ctx.windows.push([p[0], wy, p[2], Math.atan2(wz * side, wx * side), 6.4, 22, hash(k, Math.round(b.x), side), 0]);
        }
      }
    }
  }
  if (b.portcullis && o && lod < 2) {
    // a raised portcullis: iron bars hanging in the top of the mouth
    const apex = o.floor + o.spring + o.rise;
    const bars = 15;
    for (let k = 0; k < bars; k++) {
      const u = lerp(-o.a * 0.86, o.a * 0.86, k / (bars - 1));
      const top = apex - 1.5 - archHalfAt(o, u);
      const bot = apex - 20 + Math.abs(u) * 0.35;
      if (top - bot < 3) continue;
      for (const side of [1, -1]) {
        const p = P(u, side * (hw - 5), 0);
        boxY(mb, p[0], p[2], b.yaw, 0.4, 0.4, bot, top, MAT.iron, 0.9);
        spike(mb, p[0], bot - 3.2, p[2], b.yaw, 0.4, 3.2, MAT.iron, 0.9);
      }
    }
    for (const yy of [apex - 6, apex - 13]) {
      for (const side of [1, -1]) {
        const p = P(0, side * (hw - 5), yy);
        const wid = o.a * 1.75;
        boxY(mb, p[0], p[2], b.yaw, wid / 2, 0.45, yy - 0.4, yy + 0.4, MAT.iron, 0.9);
      }
    }
  }
}

// how far the arch crown descends from its apex at lateral offset u (so portcullis bars stop under the curve)
function archHalfAt(o, u) {
  const a = Math.abs(u);
  if (a >= o.a) return o.rise + o.spring;
  const cx = (o.rise * o.rise - o.a * o.a) / (2 * o.a);
  const R = o.a + cx;
  // height of the arch curve above spring at lateral a: sqrt(R^2 - (a + cx)^2)
  const q = R * R - (a + cx) * (a + cx);
  const h = q > 0 ? Math.sqrt(q) : 0;
  return o.rise - h; // drop below the apex
}

// ------------------------------------------------------------------------------------------------ flying buttress
export function buildButtress(mb, f, lod, ctx) {
  const n = LODP[lod].fb;
  const pts = buttressPath(f, n);
  const hw = f.w / 2, ht = f.t / 2;
  let prev = null;
  let u = 0;
  for (let i = 0; i <= n; i++) {
    const p = pts[i];
    const q = pts[Math.min(n, i + 1)], r0 = pts[Math.max(0, i - 1)];
    let tx = q[0] - r0[0], ty = q[1] - r0[1], tz = q[2] - r0[2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    // side = horizontal perpendicular, vertical = side x tangent
    const hl = Math.hypot(tx, tz) || 1;
    const sx = -tz / hl, sz = tx / hl;
    const vx = -sz * ty, vy = sz * tx - sx * tz, vz = sx * ty;
    const taper = lerp(1.0, 0.72, i / n);
    const corners = [[-hw * taper, -ht * taper], [hw * taper, -ht * taper], [hw * taper, ht * taper], [-hw * taper, ht * taper]].map(([a, b]) => [CASTLE_X + p[0] + sx * a + vx * b, p[1] + vy * b, CASTLE_Z + p[2] + sz * a + vz * b]);
    if (prev) {
      const seg = Math.hypot(p[0] - prev.p[0], p[1] - prev.p[1], p[2] - prev.p[2]);
      for (let e = 0; e < 4; e++) {
        const a = prev.c[e], b = prev.c[(e + 1) % 4], c = corners[(e + 1) % 4], d = corners[e];
        // outward hint: from the centre of the section
        const mx = (a[0] + b[0]) / 2 - (CASTLE_X + prev.p[0]), my = (a[1] + b[1]) / 2 - prev.p[1], mz = (a[2] + b[2]) / 2 - (CASTLE_Z + prev.p[2]);
        mb.quad(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2], u, e * 3, u, e * 3 + 3, u + seg, e * 3 + 3, u + seg, e * 3, MAT.ashlar, e === 0 ? 0.65 : 1, mx, my, mz);
      }
      u += seg;
      if (LODP[lod].crock && i % 2 === 0 && i < n) {
        const top = [CASTLE_X + p[0] + vx * ht * taper, p[1] + vy * ht * taper, CASTLE_Z + p[2] + vz * ht * taper];
        spike(mb, top[0], top[1] - 0.3, top[2], 0.3, 0.9, 3.2, MAT.dark, 1);
      }
    }
    prev = { p, c: corners };
  }
}
const CASTLE_X = CASTLE.x, CASTLE_Z = CASTLE.z;

// ------------------------------------------------------------------------------------------------ instances
// Everything repeated: merlons come from the structures above; here are the spec-driven ones (banners, braziers,
// chains) and nothing else needs the structures.
function towerById(S, id) {
  return S.towers.find((t) => t.id === id);
}

function surfaceRadius(t, y) {
  for (const s of t.segs) {
    if (y < s.y0 - 1e-6 || y > s.y1 + 1e-6) continue;
    if (s.k === 'gallery') return y > s.y0 + 5.5 ? s.r1 + 0.7 : towerRadiusAt(t, y) * Math.cos(Math.PI / t.n);
    return towerRadiusAt(t, y) * Math.cos(Math.PI / (s.sides || t.n));
  }
  return 0;
}

export function buildSpecInstances(ctx) {
  const S = castleSpec();
  for (const b of S.banners) {
    const t = towerById(S, b.tower);
    if (!t) continue;
    const r = surfaceRadius(t, b.y) + 1.3;
    const x = t.x + Math.cos(b.ang) * r, z = t.z + Math.sin(b.ang) * r;
    ctx.banners.push([x, b.y, z, b.ang, b.w, b.h, b.mat, hash(Math.round(x), Math.round(z))]);
  }
  for (const b of S.braziers) {
    const t = towerById(S, b.tower);
    if (!t) continue;
    const g = t.segs.find((s) => s.k === 'gallery' && b.y >= s.y0 && b.y <= s.y1 + 0.5);
    if (!g) continue;
    const r = g.r1 - 4.6;
    const y = g.y0 + 9.8;
    ctx.braziers.push([t.x + Math.cos(b.ang) * r, y, t.z + Math.sin(b.ang) * r, 1]);
  }
  for (const [x, z] of S.avenue) ctx.braziers.push([x, 12.6, z, 3.2]);
  for (const c of S.chains) ctx.chains.push(c);
}

// ------------------------------------------------------------------------------------------------ courtyard
// Paving inside the curtain wall: concentric copies of the wall polygon (pulled in by the wall's thickness), a
// little above the plateau, darker toward the walls where the baker also adds occlusion.
export function buildFloor(mb) {
  const S = castleSpec();
  const ids = ['g2', 'se', 'e', 'ne', 'nw', 'w', 'sw', 'g1'];
  const poly = ids.map((id) => {
    const t = S.towers.find((q) => q.id === id);
    const l = Math.hypot(t.x, t.z + 0) || 1;
    const k = 1 - 17 / l;
    return [CASTLE.x + t.x * k, CASTLE.z + t.z * k];
  });
  const scales = [0.2, 0.38, 0.56, 0.72, 0.86, 0.95, 1.0];
  const level = (k) => {
    const r = new Float32Array(poly.length * 3);
    poly.forEach((p, i) => { r[i * 3] = CASTLE.x + (p[0] - CASTLE.x) * k; r[i * 3 + 1] = 0.3; r[i * 3 + 2] = CASTLE.z + (p[1] - CASTLE.z) * k; });
    return r;
  };
  const rings = scales.map(level);
  // each polygon edge is subdivided so the baked lighting has vertices to sit on
  const subdiv = (r) => {
    const n = poly.length, m = 6;
    const out = new Float32Array(n * m * 3);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      for (let q = 0; q < m; q++) {
        const f = q / m;
        out[(i * m + q) * 3] = lerp(r[i * 3], r[j * 3], f);
        out[(i * m + q) * 3 + 1] = 0.3;
        out[(i * m + q) * 3 + 2] = lerp(r[i * 3 + 2], r[j * 3 + 2], f);
      }
    }
    return out;
  };
  const fine = rings.map(subdiv);
  const n = poly.length * 6;
  for (let i = 0; i < scales.length - 1; i++) {
    strip(mb, fine[i], fine[i + 1], n, CASTLE.x, CASTLE.z, { mat: MAT.dark, v0: scales[i] * 250, v1: scales[i + 1] * 250, hr: 0, hy: 1, ao0: 1, ao1: i === scales.length - 2 ? 0.7 : 1 });
  }
  // pedestals for the avenue's fire bowls
  for (const [x, z] of S.avenue) {
    boxY(mb, x, z, 0, 2.5, 2.5, -1, 10.6, MAT.ashlar, 1);
    boxY(mb, x, z, Math.PI / 4, 3.1, 3.1, 10.6, 12.6, MAT.dark, 1, true);
    boxY(mb, x, z, 0, 3.3, 3.3, 0.2, 2.2, MAT.dark, 0.9);
  }
  // the inner ring closes over the keep's plinth (hidden under it)
  const first = fine[0];
  const cx = CASTLE.x, cz = CASTLE.z;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    mb.tri3(cx, 0.3, cz, first[j * 3], 0.3, first[j * 3 + 2], first[i * 3], 0.3, first[i * 3 + 2], 0, 0, 1, 0, 0, 1, MAT.dark, 1, 0, 1, 0);
  }
}

// the monumental stair up to the keep's plinth, facing the gate (south): a broad flight between cheek walls with
// pinnacles at the foot
function buildKeepStairs(mb, keep) {
  const plinth = keep.segs[0];
  const yTop = plinth.y1 - 0.4;
  const apothem = plinth.r1 * Math.cos(Math.PI / 8) - 0.5; // where the plinth's south face is
  const cx = keep.x, cz = keep.z + apothem;
  const steps = 24, rise = (yTop - 0.3) / steps, tread = 1.9, half = 16;
  for (let i = 0; i < steps; i++) {
    const z = cz + (steps - i - 0.5) * tread;
    boxY(mb, cx, z, 0, half, tread / 2, -2, 0.3 + rise * (i + 1), MAT.ashlar, 0.9);
  }
  for (const sx of [-1, 1]) {
    const x = cx + sx * (half + 2.4);
    // the cheek wall steps down with the flight
    for (let i = 0; i < 4; i++) {
      const z0 = cz + (steps - (i + 1) * 6) * tread, d = 3 * tread;
      boxY(mb, x, z0 + d, 0, 2.4, d, -2, 0.3 + rise * (steps - i * 6) + 3.4, MAT.dark, 0.85);
    }
    spike(mb, x, 0.3 + 5.5, cz + steps * tread + 2, 0.3, 1.8, 13, MAT.dark, 1);
  }
}

// ------------------------------------------------------------------------------------------------ assembly
function quadrant(x, z) {
  return Math.floor(((Math.atan2(z, x) + Math.PI) / (Math.PI / 2)) % 4);
}

export function groupOfTower(t) {
  if (t.id === 'g1' || t.id === 'g2') return 'gate-towers';
  if (t.id.startsWith('wt-')) return 'wtowers-' + quadrant(t.x, t.z);
  if (t.id.startsWith('pier')) return 'piers';
  return t.id;
}

export function groupOfBay(b) {
  if (b.id === 'gate' || b.id === 'tri') return b.id;
  if (b.id === 'vd' || b.id === 'vh') return b.id;
  if (/^v[abcf]-/.test(b.id)) return 'v' + b.id[1];
  return 'walls-' + quadrant(b.x, b.z);
}

// Build every structure at one detail level. Returns { groups: Map(id -> MeshBuilder), ctx } where ctx holds the
// instance lists (filled only for level 0).
export function buildCastle(lod) {
  const S = castleSpec();
  const ctx = { inst: lod === 0, merlons: [], windows: [], banners: [], braziers: [], chains: [], gargoyles: [] };
  const groups = new Map();
  const get = (id) => {
    let g = groups.get(id);
    if (!g) {
      g = new MeshBuilder();
      g.maxEdge = [20, 36, 80][lod]; // lighting comes from the volume now: vertices only need to follow the shapes
      groups.set(id, g);
    }
    return g;
  };
  for (const t of S.towers) buildTower(get(groupOfTower(t)), t, lod, ctx);
  if (lod < 2) buildKeepStairs(get('keep'), S.towers.find((t) => t.id === 'keep'));
  for (const w of S.walls) buildWall(get('walls-' + quadrant((w.x1 + w.x2) / 2, (w.z1 + w.z2) / 2)), w, lod, ctx);
  for (const b of S.bays) buildBay(get(groupOfBay(b)), b, lod, ctx);
  const fbMB = get('piers');
  for (const f of S.buttresses) buildButtress(fbMB, f, lod, ctx);
  if (lod === 0) buildSpecInstances(ctx);
  return { groups, ctx };
}

// ------------------------------------------------------------------------------------------------ chains
// Link transforms along a hanging chain (a parabola between its anchors): [x, y, z, tx, ty, tz, roll, size] per link,
// alternate links turned a quarter turn.
export function chainLinks(c) {
  const pts = [];
  const N = 240;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    pts.push([lerp(c.a[0], c.b[0], t), lerp(c.a[1], c.b[1], t) - c.sag * 4 * t * (1 - t), lerp(c.a[2], c.b[2], t)]);
  }
  const cum = [0];
  for (let i = 1; i <= N; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
  const total = cum[N];
  const pitch = c.link * 1.55;
  const n = Math.floor(total / pitch);
  const out = new Float32Array(n * 8);
  let seg = 0;
  for (let j = 0; j < n; j++) {
    const s = (j + 0.5) * (total / n);
    while (seg < N - 1 && cum[seg + 1] < s) seg++;
    const f = (s - cum[seg]) / Math.max(1e-6, cum[seg + 1] - cum[seg]);
    const a = pts[seg], b = pts[seg + 1];
    const tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    out.set([lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f), tx / tl, ty / tl, tz / tl, (j % 2) * (Math.PI / 2), c.link], j * 8);
  }
  return out;
}
