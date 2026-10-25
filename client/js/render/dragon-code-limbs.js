// Legs, wing arms, fingers and the wing membranes of the procedural dragon (see dragon-code-geo.js).
import {
  TAU, clamp, lerp, sstep, gauss, norm, sub, add, mul, dot, cross, len, mix, madd, dist, mirrorX, segDist,
  Part, loft, horn, pathFrames, spline, bezier, setSkin, skinRigid, chainWeights, distWeights, rng,
} from './dragon-code-util.js';
import { BI, LAYOUT, SPINE, spineWeights } from './dragon-code-geo.js';

const { WING, HIND, FORE } = LAYOUT;
const sideTag = (s) => (s > 0 ? 'R' : 'L');
const mx = (p, s) => [p[0] * s, p[1], p[2]];

/** UV of the wing membrane, shared with the vein texture (dragon-code.js): both wings use the right wing's map */
export const wingUV = (x, y) => [Math.abs(x) / 13.0, (2.4 - y) / 8.4];

// ------------------------------------------------------------------------------------------------------
// generic tube along a spline with a radius profile; used for limbs, arm bones and fingers
function tube(part, keys, o) {
  const n = o.rings ?? 12;
  const pts = [];
  for (let i = 0; i < n; i++) pts.push(o.straight ? mix(keys[0], keys[1], i / (n - 1)) : spline(keys, i / (n - 1)));
  const fr = pathFrames(pts, o.ref || [1, 0, 0]);
  const arc = [0];
  for (let i = 1; i < n; i++) arc.push(arc[i - 1] + dist(pts[i], pts[i - 1]));
  const rings = pts.map((c, i) => ({ c, R: fr[i].R, U: fr[i].U, cell: o.cell ?? 0.14, t: i / (n - 1), arc: arc[i] }));
  const info = loft(part, {
    rings, N: o.seg ?? 12, cap0: o.cap0 ?? true, cap1: o.cap1 ?? true,
    sec: (i, th, s, r) => {
      const rad = o.rad(r.t, r.arc);
      const rx = Array.isArray(rad) ? rad[0] : rad, rz = Array.isArray(rad) ? rad[1] : rad;
      let a = Math.sin(th) * rx, b = -Math.cos(th) * rz;
      if (o.bump) {
        const d = o.bump(r.t, s, th);
        const l = Math.hypot(a, b) || 1;
        a += (a / l) * d;
        b += (b / l) * d;
      }
      return [a, b];
    },
    attr: (i, k, th, s, r) => (o.attr ? o.attr(r.t, s) : [0, 0, 0, 0]),
  });
  info.arc = arc;
  info.pts = pts;
  info.keys = keys;
  return info;
}

/** keyed weights along a tube: bones is [[boneIndex, arcStart]...] ascending, hw the blend half-width */
function skinTube(part, info, bones, hw = 0.2) {
  const chain = bones.map((b) => b[0]);
  const trans = bones.slice(1).map((b) => b[1]);
  for (let i = 0; i < info.NR; i++) {
    const w = chainWeights(info.arc[i], chain, trans, () => hw);
    for (let k = 0; k < info.N; k++) setSkin(part, info.base + i * info.N + k, w);
  }
  const extra = part.count - (info.base + info.NR * info.N);
  for (let e = 0; e < Math.max(0, extra); e++) {
    // cap centres (at most two)
    const vi = info.base + info.NR * info.N + e;
    const w = chainWeights(e === 0 ? info.arc[0] : info.arc[info.NR - 1], chain, trans, () => hw);
    setSkin(part, vi, w);
  }
}

function ball(part, c, r, o = {}) {
  const nu = o.nu ?? 10, nv = o.nv ?? 7, base = part.count;
  for (let j = 0; j <= nv; j++) {
    const ph = (j / nv) * Math.PI;
    for (let i = 0; i <= nu; i++) {
      const th = (i / nu) * TAU;
      const sx = o.sx ?? 1, sy = o.sy ?? 1, sz = o.sz ?? 1;
      const p = [c[0] + Math.sin(ph) * Math.cos(th) * r * sx, c[1] + Math.cos(ph) * r * sy, c[2] + Math.sin(ph) * Math.sin(th) * r * sz];
      part.vert(p[0], p[1], p[2], i / nu * (r / 0.14) * 2, j / nv * (r / 0.14) * 2, o.belly ?? 0, o.keratin ?? 0, 0, 0);
    }
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = base + j * (nu + 1) + i, b = a + 1, c2 = a + nu + 1, d = c2 + 1;
    part.tri(a, b, c2);
    part.tri(b, d, c2);
  }
  return base;
}

function clawAt(part, root, dir, len, bone, o = {}) {
  const d = norm(dir), side = o.curl ?? [0, 0, -1];
  const mid1 = madd(root, d, len * 0.4), mid2 = madd(madd(root, d, len * 0.75), side, len * 0.12), tip = madd(madd(root, d, len), side, len * (o.hook ?? 0.34));
  const s0 = part.count;
  horn(part, [root, mid1, mid2, tip], { r0: o.r ?? 0.075, tipR: 0.004, rings: o.rings ?? 6, seg: o.seg ?? 6, taper: 1.15, c0: 0.55, c1: 1, ref: side });
  skinRigid(part, s0, part.count, bone);
}

// ------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------
// a toe: a bezier tube with knuckles and a claw
function toe(part, base, dir, len, r, bone, o = {}) {
  const d = norm(dir), down = o.down ?? [0, 0, -1];
  const ctrl = [base, madd(madd(base, d, len * 0.33), down, len * 0.02), madd(madd(base, d, len * 0.68), down, len * 0.1), madd(madd(base, d, len), down, len * 0.24)];
  const rings = o.rings ?? 9, seg = o.seg ?? 8;
  const pts = [];
  for (let i = 0; i < rings; i++) pts.push(bezier(ctrl, i / (rings - 1)));
  const fr = pathFrames(pts, [1, 0, 0]);
  const s0 = part.count;
  loft(part, {
    rings: pts.map((c, i) => ({ c, R: fr[i].R, U: fr[i].U, cell: 0.09 })), N: seg, cap0: true, cap1: true,
    sec: (i, th) => {
      const t = i / (rings - 1);
      const rr = r * (1 - 0.4 * t) * (1 + 0.2 * gauss(t, 0.36, 0.07) + 0.16 * gauss(t, 0.7, 0.06));
      return [Math.sin(th) * rr * 1.05, -Math.cos(th) * rr * (-Math.cos(th) > 0 ? 0.8 : 1)];
    },
    attr: () => [0, 0, 0, 0],
  });
  skinRigid(part, s0, part.count, bone);
  const tip = ctrl[3], td = norm(sub(ctrl[3], ctrl[2]));
  clawAt(part, madd(tip, td, -0.02), td, o.claw ?? 0.34, bone, { r: r * 0.85, curl: down, hook: 0.5, seg: o.seg ?? 8 });
}

function hindLeg(part, side, detail) {
  const tag = sideTag(side);
  const [H0, K, A, T] = HIND.map((p) => mx(p, side));
  const s = (n) => BI[`${n}.${tag}`];
  const seg = detail >= 0.8 ? 16 : 8;
  // thigh: a big muscle mass that starts inside the haunch
  const start = [side * 0.5, -2.05, 0.02];
  const t0 = tube(part, [start, H0, K], {
    rings: detail >= 0.8 ? 14 : 7, seg, ref: [1, 0, 0], cell: 0.16,
    rad: (t) => {
      const r = lerp(0.68, 0.3, sstep(0.3, 1, t)) + 0.12 * gauss(t, 0.35, 0.2);
      return [r * 1.05, r * 0.92];
    },
    bump: (t, sa) => 0.05 * gauss(t, 0.5, 0.25) * gauss(sa, 2.4, 0.5), // quad
  });
  skinTube(part, t0, [[BI.hips, 0], [s('thigh'), t0.arc[Math.round((t0.NR - 1) * 0.3)]]], 0.4);
  // knee cap and shin
  const kb = ball(part, K, 0.3, { nu: seg >> 1 | 0, nv: 6, sy: 1.0 });
  for (let i = kb; i < part.count; i++) setSkin(part, i, [[s('thigh'), 0.5], [s('shin'), 0.5]]);
  const sh = tube(part, [mix(K, A, -0.05), mix(K, A, 0.4), mix(K, A, 0.8), A], {
    rings: detail >= 0.8 ? 12 : 6, seg: seg >> 1, ref: [1, 0, 0], cell: 0.12, cap0: false,
    rad: (t) => lerp(0.27, 0.11, Math.pow(t, 0.7)) + 0.07 * gauss(t, 0.18, 0.12),
  });
  skinTube(part, sh, [[s('shin'), 0]], 0.2);
  const ab = ball(part, A, 0.14, { nu: 7, nv: 5 });
  for (let i = ab; i < part.count; i++) setSkin(part, i, [[s('shin'), 0.5], [s('foot'), 0.5]]);
  const ft = tube(part, [A, mix(A, T, 0.55), T], {
    rings: 6, seg: seg >> 1, ref: [1, 0, 0], cell: 0.1, cap0: false,
    rad: (t) => lerp(0.1, 0.09, t),
  });
  skinTube(part, ft, [[s('foot'), 0]], 0.2);
  // toes: three forward toes fanned out, a hallux, all folded back in the flight tuck
  const rnd = rng(5);
  const toeDefs = [
    { d: [-0.35 * side, -1, -0.15], l: 0.8, r: 0.075 },
    { d: [0.0 * side, -1, -0.25], l: 0.95, r: 0.085 },
    { d: [0.42 * side, -0.95, -0.2], l: 0.8, r: 0.075 },
    { d: [-0.2 * side, 0.9, -0.5], l: 0.45, r: 0.055 },
  ];
  for (const td of toeDefs) toe(part, madd(T, [0, 0, 0], 1), td.d, td.l, td.r, s('foot'), { rings: detail >= 0.8 ? 9 : 4, seg: detail >= 0.8 ? 8 : 5, claw: 0.3 });
  // knee spike, heel spur
  const k0 = part.count;
  horn(part, [madd(K, [side, 0.1, 0.2], 0.2), madd(K, [side, 0.3, 0.3], 0.38), madd(K, [side, 0.7, 0.2], 0.55), madd(K, [side, 1.2, 0.0], 0.7)], { r0: 0.1, tipR: 0.008, rings: 7, seg: 6, flare: 0.5, c0: 0.5, c1: 1 });
  skinRigid(part, k0, part.count, s('shin'));
  const h0 = part.count;
  horn(part, [madd(A, [side * 0.3, 0, 0], 0.1), madd(A, [side * 0.3, -0.5, 0.2], 0.2), madd(A, [side * 0.3, -1, 0.1], 0.3), madd(A, [side * 0.3, -1, -0.2], 0.45)], { r0: 0.07, tipR: 0.006, rings: 6, seg: 6, flare: 0.4 });
  skinRigid(part, h0, part.count, s('foot'));
}

function foreLeg(part, side, detail) {
  const tag = sideTag(side);
  const [S, E, W, T] = FORE.map((p) => mx(p, side));
  const s = (n) => BI[`${n}.${tag}`];
  const seg = detail >= 0.8 ? 12 : 8;
  const up = tube(part, [mix(S, E, -0.35), S, E], {
    rings: detail >= 0.8 ? 10 : 5, seg, ref: [1, 0, 0], cell: 0.13,
    rad: (t) => lerp(0.38, 0.2, sstep(0.3, 1, t)) + 0.05 * gauss(t, 0.3, 0.15),
  });
  skinTube(part, up, [[BI.chest, 0], [s('upperleg'), up.arc[Math.round((up.NR - 1) * 0.28)]]], 0.3);
  const eb = ball(part, E, 0.2, { nu: 8, nv: 5 });
  for (let i = eb; i < part.count; i++) setSkin(part, i, [[s('upperleg'), 0.5], [s('foreleg'), 0.5]]);
  const fl = tube(part, [mix(E, W, -0.05), mix(E, W, 0.5), W], {
    rings: detail >= 0.8 ? 9 : 5, seg: seg >> 1, ref: [1, 0, 0], cell: 0.11, cap0: false,
    rad: (t) => lerp(0.19, 0.1, t) + 0.04 * gauss(t, 0.2, 0.15),
  });
  skinTube(part, fl, [[s('foreleg'), 0]], 0.2);
  const hb = ball(part, W, 0.11, { nu: 7, nv: 5 });
  for (let i = hb; i < part.count; i++) setSkin(part, i, [[s('foreleg'), 0.5], [s('hand'), 0.5]]);
  for (const td of [{ d: [-0.3 * side, 1, -0.25], l: 0.5 }, { d: [0.05 * side, 1, -0.3], l: 0.58 }, { d: [0.4 * side, 0.9, -0.28], l: 0.5 }]) {
    toe(part, W, td.d, td.l, 0.055, s('hand'), { rings: detail >= 0.8 ? 6 : 4, seg: detail >= 0.8 ? 7 : 5, claw: 0.24 });
  }
}

export function buildLimbs(detail = 1) {
  const part = new Part();
  for (const side of [1, -1]) {
    hindLeg(part, side, detail);
    foreLeg(part, side, detail);
  }
  part.normals(0);
  return part;
}

/** the far LOD: plain tapered tubes, one bone each */
export function buildLimbsLod() {
  const part = new Part();
  for (const side of [1, -1]) {
    const tag = sideTag(side);
    const b = (n) => BI[`${n}.${tag}`];
    const [H0, K, A, T] = HIND.map((p) => mx(p, side));
    const [S, E, W, F] = FORE.map((p) => mx(p, side));
    const run = (keys, rad, bone, rings = 3, seg = 5) => {
      const s0 = part.count;
      tube(part, keys, { rings, seg, straight: keys.length === 2, rad, ref: [1, 0, 0], cell: 0.2 });
      skinRigid(part, s0, part.count, bone);
    };
    run([[side * 0.5, -2.05, 0.02], K], (t) => lerp(0.62, 0.3, t), b('thigh'), 4, 6);
    run([K, A], (t) => lerp(0.26, 0.11, t), b('shin'));
    run([A, madd(T, [0, -1, -0.2], 0.9)], (t) => lerp(0.1, 0.03, t), b('foot'), 3, 4);
    run([S, E], (t) => lerp(0.36, 0.2, t), b('upperleg'), 3, 5);
    run([E, mix(W, F, 1.2)], (t) => lerp(0.18, 0.04, t), b('foreleg'), 3, 4);
  }
  part.normals(0);
  return part;
}

// ------------------------------------------------------------------------------------------------------
// wing arms: humerus, forearm, wrist with a thumb claw, four fingers with knuckles
export function fingerPoint(side, k, s) {
  const W = mx(WING.wrist, side), T = mx(WING.tips[k], side);
  const p = mix(W, T, s);
  // fingers bow forward and droop toward the tips
  p[1] += 0.3 * Math.sin(Math.PI * s) * (k === 0 ? 1 : 0.6);
  p[2] -= 0.22 * s * s;
  return p;
}

export function buildWingArmsLod() {
  const part = new Part();
  for (const side of [1, -1]) {
    const tag = sideTag(side);
    const b = (n) => BI[`${n}.${tag}`];
    const S = mx(WING.shoulder, side), E = mx(WING.elbow, side), W = mx(WING.wrist, side);
    const run = (keys, rad, bone, rings = 3, seg = 5) => {
      const s0 = part.count;
      tube(part, keys, { rings, seg, straight: true, rad, ref: [0, 1, 0], cell: 0.2 });
      skinRigid(part, s0, part.count, bone);
    };
    run([mix(S, E, -0.2), E], (t) => lerp(0.6, 0.3, t), b('upperarm'), 3, 6);
    run([E, W], (t) => lerp(0.29, 0.15, t), b('forearm'), 3, 6);
    for (let k = 0; k < 4; k++) run([W, mx(WING.tips[k], side)], (t) => lerp(0.14, 0.02, t), b(`finger${k + 1}`), 3, 4);
  }
  part.normals(0);
  return part;
}

export function buildWingArms(detail = 1) {
  const part = new Part();
  const seg = detail >= 0.8 ? 14 : 8;
  for (const side of [1, -1]) {
    const tag = sideTag(side);
    const S = mx(WING.shoulder, side), E = mx(WING.elbow, side), W = mx(WING.wrist, side);
    const b = (n) => BI[`${n}.${tag}`];
    // humerus
    const dirSE = norm(sub(E, S));
    const h = tube(part, [madd(S, dirSE, -0.5), S, E], {
      rings: detail >= 0.8 ? 14 : 6, seg, ref: [0, 1, 0], cell: 0.14,
      rad: (t) => {
        const r = lerp(0.62, 0.3, sstep(0.25, 1.0, t)) + 0.07 * gauss(t, 0.3, 0.14);
        return [r * 1.05, r * 0.88];
      },
      bump: (t, sa) => 0.04 * gauss(t, 0.45, 0.2) * gauss(sa, 0.3, 0.7),
    });
    skinTube(part, h, [[BI.chest, 0], [b('upperarm'), h.arc[Math.round((h.NR - 1) * 0.28)]]], 0.3);
    const eb = ball(part, E, 0.3, { nu: 10, nv: 7 });
    for (let i = eb; i < part.count; i++) setSkin(part, i, [[b('upperarm'), 0.5], [b('forearm'), 0.5]]);
    // forearm
    const f = tube(part, [mix(E, W, -0.04), mix(E, W, 0.5), W], {
      rings: detail >= 0.8 ? 12 : 6, seg, ref: [0, 1, 0], cell: 0.12, cap0: false, cap1: false,
      rad: (t) => {
        const r = lerp(0.29, 0.15, Math.pow(t, 0.8)) + 0.05 * gauss(t, 0.15, 0.12);
        return [r * 1.1, r * 0.85];
      },
    });
    skinTube(part, f, [[b('forearm'), 0]], 0.2);
    // wrist knuckle, thumb claw
    const wb = ball(part, W, 0.24, { nu: 10, nv: 7 });
    for (let i = wb; i < part.count; i++) setSkin(part, i, [[b('forearm'), 1]]);
    const c0 = part.count;
    horn(part, [madd(W, [side * 0.1, 0.15, 0.3], 1), madd(W, [side * 0.25, 0.5, 0.5], 1), madd(W, [side * 0.45, 0.95, 0.62], 1), madd(W, [side * 0.7, 1.35, 0.5], 1)], { r0: 0.1, tipR: 0.008, rings: 9, seg: 7, flare: 0.3, c0: 0.5, c1: 1, ridges: 5 });
    skinRigid(part, c0, part.count, b('forearm'));
    // elbow spike (pointing back and up)
    const e0 = part.count;
    horn(part, [madd(E, [side * 0.1, -0.6, 0.1], 0.2), madd(E, [side * 0.5, -1.2, 0.2], 0.2), madd(E, [side * 0.9, -2.0, 0.4], 0.3), madd(E, [side * 1.4, -2.9, 0.4], 0.4)], { r0: 0.15, tipR: 0.01, rings: 8, seg: 7, flare: 0.5, c0: 0.5, c1: 1 });
    skinRigid(part, e0, part.count, b('upperarm'));
    // fingers
    for (let k = 0; k < 4; k++) {
      const rings = detail >= 0.8 ? 13 : 5;
      const keys = [];
      for (let i = 0; i < 5; i++) keys.push(fingerPoint(side, k, i / 4));
      const len0 = dist(W, mx(WING.tips[k], side));
      const th = k === 0 ? 1.0 : 0.82;
      const fg = tube(part, keys, {
        rings, seg: detail >= 0.8 ? 8 : 5, ref: [0, 1, 0], cell: 0.1, cap0: false, cap1: true,
        rad: (t) => {
          const r = th * (0.15 * Math.pow(1 - t, 0.9) + 0.022) * (1 + 0.28 * gauss(t, 0.34, 0.05) + 0.2 * gauss(t, 0.68, 0.045));
          return [r * 1.15, r * 0.9];
        },
      });
      skinTube(part, fg, [[b('forearm'), 0], [b(`finger${k + 1}`), 0.45]], 0.35);
      // tip claw
      const T = keys[4], dT = norm(sub(keys[4], keys[3]));
      const cl = part.count;
      horn(part, [madd(T, dT, -0.05), madd(T, dT, 0.22), madd(madd(T, dT, 0.5), [0, 0, -1], 0.06), madd(madd(T, dT, 0.78), [0, 0, -1], 0.22)], { r0: 0.04, tipR: 0.004, rings: 5, seg: 5, c0: 0.5, c1: 1 });
      skinRigid(part, cl, part.count, b(`finger${k + 1}`));
    }
  }
  part.normals(0);
  return part;
}

// ------------------------------------------------------------------------------------------------------
// membranes
const SCALLOP = [0.31, 0.34, 0.29]; // trailing-edge depth of the three finger panels

function bodyAttach(y) {
  const P = SPINE(y);
  const z = lerp(0.55, 0.2, clamp((1.6 - y) / 3.9, 0, 1));
  const q = clamp((z - P[0]) / P[2], -0.95, 0.95);
  return [0.9 * P[1] * Math.sqrt(1 - q * q), y, z];
}

/** the right wing's parametric pieces; used for the mesh and for drawing the vein texture */
export function wingModel() {
  const S = WING.shoulder, E = WING.elbow, W = WING.wrist, H = [0.8, -3.2, 0.14];
  const F = (k, s) => fingerPoint(1, k, s);
  const tips = [0, 1, 2, 3].map((k) => F(k, 1));
  const arm = (a) => spline([S, E, W], a);
  const L = (b) => {
    const y = lerp(S[1], H[1], b);
    const p = bodyAttach(y);
    return b < 0.04 ? mix(S, p, b / 0.04) : p;
  };
  const trail = (a) => {
    const p = mix(H, tips[3], a);
    // concave arc and a little sag toward the body
    return [p[0], p[1] + 0.2 * Math.sin(Math.PI * a), p[2] - 0.12 * Math.sin(Math.PI * a)];
  };
  const coons = (a, b) => {
    const B0 = arm(a), T0 = trail(a), L0 = L(b), R0 = F(3, b);
    const out = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      out[i] = (1 - b) * B0[i] + b * T0[i] + (1 - a) * L0[i] + a * R0[i]
        - ((1 - a) * (1 - b) * arm(0)[i] + a * (1 - b) * arm(1)[i] + (1 - a) * b * trail(0)[i] + a * b * trail(1)[i]);
    }
    return out;
  };
  const sMax = (k, t) => 1 - SCALLOP[k] * Math.pow(Math.sin(Math.PI * t), 0.8);
  const fingerPanel = (k, sigma, t) => {
    // between finger k and k+1 (0-based), sigma 0 (wrist) .. 1 (trailing edge), t 0 (finger k) .. 1 (finger k+1)
    const s = sigma * sMax(k, t);
    const p = mix(F(k, s), F(k + 1, s), t);
    p[2] -= 0.2 * Math.pow(Math.sin(Math.PI * t), 1.0) * Math.pow(sigma, 1.4);
    return p;
  };
  const prop = (a, b) => {
    const A = arm(a), Lp = mix(S, W, a);
    const p = mix(A, [Lp[0], Lp[1] + 0.05, Lp[2] - 0.05 * Math.sin(Math.PI * a)], b);
    return p;
  };
  return { S, E, W, H, F, tips, arm, L, trail, coons, sMax, fingerPanel, prop };
}

export function buildMembranes(detail = 1) {
  const part = new Part();
  const M = wingModel();
  const nS = detail >= 0.8 ? 14 : 4, nT = detail >= 0.8 ? 12 : 4;
  const nA = detail >= 0.8 ? 22 : 6, nB = detail >= 0.8 ? 12 : 3;
  for (const side of [1, -1]) {
    const tag = sideTag(side);
    const bone = (n) => BI[`${n}.${tag}`];
    const cand = [
      { i: BI.belly, a: [0, 0.8, -0.08], b: [0, -0.5, -0.05], r: 1.0, k: 1 },
      { i: BI.hips, a: [0, -0.5, -0.05], b: [0, -3.0, 0.05], r: 0.7, k: 1 },
      { i: bone('upperarm'), a: mx(WING.shoulder, side), b: mx(WING.elbow, side), r: 0.3, k: 1 },
      { i: bone('forearm'), a: mx(WING.elbow, side), b: mx(WING.wrist, side), r: 0.2, k: 1 },
      ...[0, 1, 2, 3].map((k) => ({ i: bone(`finger${k + 1}`), a: mx(WING.wrist, side), b: mx(WING.tips[k], side), r: 0.1, k: 1 })),
    ];
    const addGrid = (nu, nv, fn, thin, flipFor) => {
      const base = part.count, idx0 = part.idx.length;
      for (let j = 0; j <= nv; j++) {
        for (let i = 0; i <= nu; i++) {
          const p0 = fn(i / nu, j / nv), p = mx(p0, side);
          const uv = wingUV(p[0], p[1]);
          part.vert(p[0], p[1], p[2], uv[0], uv[1], 0, 0, 0, 0);
        }
      }
      for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
        const a = base + j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
        part.tri(a, b, c);
        part.tri(b, d, c);
      }
      // wind so the normals point up (+Z)
      const pa = part.pos(base), pb = part.pos(base + 1), pc = part.pos(base + nu + 1);
      const nz = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
      if (nz < 0) for (let t = idx0; t < part.idx.length; t += 3) { const x = part.idx[t + 1]; part.idx[t + 1] = part.idx[t + 2]; part.idx[t + 2] = x; }
      return base;
    };
    const first = part.count;
    // finger panels
    for (let k = 0; k < 3; k++) addGrid(nS, nT, (sg, t) => M.fingerPanel(k, sg, t), 1, side > 0);
    // inner panel (arm, finger 4, trailing edge, body)
    addGrid(nA, nB, (a, b) => M.coons(a, b), 1, side < 0);
    // propatagium along the leading edge
    addGrid(nA >> 1, 2, (a, b) => M.prop(a, b), 1, side < 0);
    // weights and thinness
    for (let i = first; i < part.count; i++) {
      const p = part.pos(i);
      const w = distWeights(p, cand, 0.85);
      setSkin(part, i, w);
      let dmin = 1e9;
      for (const c of cand) {
        if (c.i === BI.belly || c.i === BI.hips) continue;
        dmin = Math.min(dmin, segDist(p, c.a, c.b) - c.r);
      }
      // distance to the body edge counts too (the membrane is thick where it is anchored)
      part.c[i * 4] = sstep(0.05, 1.4, Math.max(0, dmin));
    }
    // hem: a thin rolled edge along the trailing edge (and along the leading edge)
    const hems = [];
    for (let k = 0; k < 3; k++) {
      const pts = [];
      for (let i = 0; i <= nT * 2; i++) pts.push(mx(M.fingerPanel(k, 1, i / (nT * 2)), side));
      hems.push(pts);
    }
    {
      const pts = [];
      for (let i = 0; i <= nA; i++) pts.push(mx(M.coons(i / nA, 1), side));
      hems.push(pts);
    }
    for (const pts of hems) {
      const fr = pathFrames(pts, [0, 0, 1]);
      const h0 = part.count;
      loft(part, {
        rings: pts.map((c, i) => ({ c, R: fr[i].R, U: fr[i].U, cell: 0.1 })), N: detail >= 0.8 ? 6 : 3, cap0: detail >= 0.8, cap1: detail >= 0.8,
        sec: (i, th) => [Math.sin(th) * 0.035, -Math.cos(th) * 0.03],
        attr: () => [0, 0, 0, 0],
      });
      for (let i = h0; i < part.count; i++) {
        const p = part.pos(i);
        setSkin(part, i, distWeights(p, cand, 0.5));
        part.c[i * 4] = 0.0;
      }
    }
  }
  part.normals(0);
  return part;
}
