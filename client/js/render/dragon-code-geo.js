// The dragon's body, built from code: skeleton description, the continuous torso/neck/head/tail skin (one lofted
// surface from the tail tip to the snout), jaw, teeth, tongue and eyes. Limbs, wings and horns live in
// dragon-code-limbs.js and dragon-code-extras.js. Coordinates: X right, Y forward, Z up (see dragon-code-util.js).
import {
  TAU, clamp, lerp, sstep, gauss, sgnpow, table, norm, sub, add, mul, dot, cross, len, mix, madd, dist,
  Part, loft, horn, pathFrames, bezier, setSkin, skinRigid, chainWeights, bakeAO, gridCavityAO, rng,
} from './dragon-code-util.js';

// ------------------------------------------------------------------------------------------------------
// skeleton. Same names, hierarchy and pivots as the Blender rig (tools/build_dragon.py), so DragonView drives it
// unchanged. head = joint position (world, rest pose), tail = where the bone ends (used for weights and tips).
const bone = (name, parent, head, tail) => ({ name, parent, head, tail });
const WING = {
  shoulder: [0.85, 1.6, 0.55], elbow: [3.4, 0.5, 0.85], wrist: [6.0, 1.75, 0.95],
  tips: [[11.6, 0.4, 0.45], [10.4, -2.4, 0.3], [8.0, -4.3, 0.35], [4.8, -4.6, 0.45]],
  hip: [0.75, -2.3, 0.2],
};
const HIND = [[0.7, -1.7, -0.35], [1.02, -0.85, -1.0], [0.95, -2.55, -1.22], [0.85, -3.55, -1.05]];
const FORE = [[0.75, 2.4, -0.55], [0.88, 1.55, -1.15], [0.62, 2.45, -1.32], [0.5, 2.95, -1.28]];
export const LAYOUT = { WING, HIND, FORE };
const mx = (p, s) => [p[0] * s, p[1], p[2]];

export const BONES = (() => {
  const b = [
    bone('root', null, [0, 0, 0], [0, 0.6, 0]),
    bone('chest', 'root', [0, 0.8, -0.08], [0, 2.1, -0.15]),
    bone('belly', 'chest', [0, 0.8, -0.08], [0, -0.5, -0.05]),
    bone('hips', 'belly', [0, -0.5, -0.05], [0, -3.0, 0.05]),
    bone('tail1', 'hips', [0, -3.0, 0.05], [0, -4.3, 0.1]),
    bone('tail2', 'tail1', [0, -4.3, 0.1], [0, -5.6, 0.1]),
    bone('tail3', 'tail2', [0, -5.6, 0.1], [0, -6.9, 0.08]),
    bone('tail4', 'tail3', [0, -6.9, 0.08], [0, -8.1, 0.05]),
    bone('tail5', 'tail4', [0, -8.1, 0.05], [0, -9.2, 0.02]),
    bone('tail6', 'tail5', [0, -9.2, 0.02], [0, -10.0, 0]),
    bone('tail7', 'tail6', [0, -10.0, 0], [0, -12.5, 0]),
    bone('neck1', 'chest', [0, 2.1, -0.15], [0, 3.2, -0.05]),
    bone('neck2', 'neck1', [0, 3.2, -0.05], [0, 4.1, 0.1]),
    bone('neck3', 'neck2', [0, 4.1, 0.1], [0, 5.0, 0.3]),
    bone('neck4', 'neck3', [0, 5.0, 0.3], [0, 5.8, 0.5]),
    bone('head', 'neck4', [0, 5.8, 0.5], [0, 8.4, 0.3]),
    bone('jaw', 'head', [0, 5.85, 0.3], [0, 8.15, 0.12]),
  ];
  for (const [tag, s] of [['R', 1], ['L', -1]]) {
    b.push(bone(`upperarm.${tag}`, 'chest', mx(WING.shoulder, s), mx(WING.elbow, s)));
    b.push(bone(`forearm.${tag}`, `upperarm.${tag}`, mx(WING.elbow, s), mx(WING.wrist, s)));
    WING.tips.forEach((t, k) => b.push(bone(`finger${k + 1}.${tag}`, `forearm.${tag}`, mx(WING.wrist, s), mx(t, s))));
    b.push(bone(`thigh.${tag}`, 'hips', mx(HIND[0], s), mx(HIND[1], s)));
    b.push(bone(`shin.${tag}`, `thigh.${tag}`, mx(HIND[1], s), mx(HIND[2], s)));
    b.push(bone(`foot.${tag}`, `shin.${tag}`, mx(HIND[2], s), mx(HIND[3], s)));
    b.push(bone(`upperleg.${tag}`, 'chest', mx(FORE[0], s), mx(FORE[1], s)));
    b.push(bone(`foreleg.${tag}`, `upperleg.${tag}`, mx(FORE[1], s), mx(FORE[2], s)));
    b.push(bone(`hand.${tag}`, `foreleg.${tag}`, mx(FORE[2], s), mx(FORE[3], s)));
  }
  return b;
})();
export const BI = {};
BONES.forEach((b, i) => (BI[b.name] = i));

// spine chain (ascending Y) and the joints between consecutive bones
const SPINE_CHAIN = ['tail7', 'tail6', 'tail5', 'tail4', 'tail3', 'tail2', 'tail1', 'hips', 'belly', 'chest', 'neck1', 'neck2', 'neck3', 'neck4', 'head'].map((n) => BI[n]);
const SPINE_JOINTS = [-10.0, -9.2, -8.1, -6.9, -5.6, -4.3, -3.0, -0.5, 0.8, 2.1, 3.2, 4.1, 5.0, 5.8];

/** weights for a point on the spine skin at axis position y with local radius r */
export function spineWeights(y, r) {
  return chainWeights(y, SPINE_CHAIN, SPINE_JOINTS, () => clamp(0.5 * r + 0.12, 0.2, 0.7));
}

// ------------------------------------------------------------------------------------------------------
// the spine profile: y, centre height, half width, extent above, extent below, squareness above, squareness below
export const SPINE = table([
  [-12.5, 0.0, 0.02, 0.02, 0.02, 2.0, 2.0],
  [-12.2, 0.0, 0.045, 0.045, 0.04, 2.0, 2.0],
  [-11.0, 0.0, 0.08, 0.075, 0.07, 2.1, 2.1],
  [-10.0, 0.0, 0.13, 0.12, 0.11, 2.2, 2.2],
  [-9.2, 0.02, 0.18, 0.165, 0.15, 2.2, 2.2],
  [-8.1, 0.05, 0.255, 0.235, 0.2, 2.2, 2.3],
  [-6.9, 0.08, 0.35, 0.33, 0.27, 2.2, 2.4],
  [-5.6, 0.1, 0.5, 0.48, 0.37, 2.2, 2.4],
  [-4.3, 0.1, 0.66, 0.65, 0.48, 2.2, 2.4],
  [-3.0, 0.05, 0.86, 0.86, 0.64, 2.2, 2.4],
  [-1.8, 0.0, 0.98, 1.02, 0.86, 2.3, 2.4],
  [-0.5, -0.04, 1.17, 1.2, 1.1, 2.3, 2.4],
  [0.8, -0.08, 1.32, 1.32, 1.27, 2.3, 2.4],
  [2.1, -0.15, 1.4, 1.3, 1.45, 2.3, 2.5],
  [2.7, -0.08, 0.98, 1.0, 1.06, 2.3, 2.4],
  [3.3, 0.0, 0.82, 0.84, 0.84, 2.2, 2.3],
  [3.9, 0.1, 0.65, 0.72, 0.67, 2.2, 2.3],
  [4.5, 0.24, 0.56, 0.64, 0.58, 2.2, 2.3],
  [5.1, 0.38, 0.51, 0.59, 0.53, 2.2, 2.3],
  [5.5, 0.47, 0.5, 0.58, 0.51, 2.3, 2.5],
  [5.9, 0.6, 0.5, 0.52, 0.46, 2.6, 3.8],
  [6.4, 0.72, 0.53, 0.4, 0.41, 3.6, 6.0],
  [6.9, 0.66, 0.45, 0.35, 0.36, 4.2, 6.5],
  [7.4, 0.5, 0.29, 0.21, 0.21, 4.0, 6.5],
  [7.9, 0.38, 0.21, 0.155, 0.15, 3.8, 6.5],
  [8.3, 0.31, 0.18, 0.135, 0.13, 3.2, 5.0],
  [8.5, 0.29, 0.145, 0.115, 0.105, 2.8, 4.0],
  [8.6, 0.28, 0.09, 0.07, 0.065, 2.3, 3.0],
  [8.65, 0.28, 0.03, 0.03, 0.03, 2.0, 2.0],
]);
// uv cell size (world units): scales are small on the head and the tail tip, big on the back
const CELL = table([
  [-12.5, 0.045], [-10, 0.085], [-6, 0.17], [-3, 0.27], [0, 0.38], [2, 0.38], [3.2, 0.26], [5, 0.14], [5.9, 0.075], [6.8, 0.048], [8.65, 0.034],
]);
// belly plate half angle (radians from the ventral midline) along the body
const BELLYW = table([[-12.5, 0.9], [-8, 0.9], [-3, 1.0], [0, 1.15], [2, 1.2], [3.5, 0.95], [5.6, 0.7], [6, 0.5], [8.5, 0.4]]);

const LIP_S = 1.03; // the mouth line, as an angle from the underside
const BUMPS = [
  // y0, s0 (rad from the underside), sy, ss, amplitude (world units)
  // torso
  [1.9, 0.95, 1.0, 0.55, 0.2], // pectorals
  [2.3, 0.0, 1.3, 0.3, 0.17], // breast keel
  [1.5, 2.2, 0.85, 0.55, 0.3], // shoulder mass
  [0.7, 2.5, 1.0, 0.4, 0.13], // scapula
  [0.0, 1.9, 1.3, 0.6, 0.1], // flank
  [-1.5, 1.85, 0.95, 0.55, 0.3], // haunch
  [-0.3, 0.0, 1.4, 0.7, 0.07], // belly
  // neck
  [3.6, 2.15, 1.3, 0.28, 0.07],
  [3.9, 0.6, 1.4, 0.35, 0.05],
  [4.8, 1.6, 0.8, 0.5, 0.045],
];
// the head's relief: y0, s0 (rad from the underside), sy, sw (width in world units), amplitude
const HEADB = [
  // brow ridge from the horn base down the nose, heavy over the eye
  [6.45, 2.82, 0.34, 0.22, 0.24], [6.8, 2.72, 0.28, 0.2, 0.38], [7.12, 2.52, 0.26, 0.16, 0.28], [7.5, 2.3, 0.28, 0.13, 0.16],
  [6.35, 2.9, 0.25, 0.2, 0.12], // post-orbital horn base
  [6.9, 2.02, 0.2, 0.2, -0.22], [6.9, 2.0, 0.34, 0.34, -0.08], // eye socket
  [6.9, 1.5, 0.22, 0.14, 0.2], [7.25, 1.42, 0.2, 0.11, 0.12], // cheekbone under the eye
  [6.5, 1.3, 0.42, 0.22, 0.22], [6.15, 1.2, 0.3, 0.2, 0.16], // cheek plate
  [6.3, 1.85, 0.5, 0.35, 0.09], // jaw muscle
  [6.2, 2.85, 0.35, 0.25, 0.08], // temple
  [7.35, Math.PI, 0.75, 0.12, 0.08], [6.25, Math.PI, 0.4, 0.17, 0.11], // nasal crest, parietal crest
  [8.15, 2.5, 0.2, 0.1, 0.07], [8.22, 2.62, 0.07, 0.06, -0.12], // nostril boss and pit
  [8.3, Math.PI, 0.16, 0.13, 0.1], [8.0, Math.PI, 0.2, 0.1, 0.05],
  [7.6, 1.15, 0.6, 0.12, 0.05], // upper lip swell
  [7.55, 1.75, 0.5, 0.2, -0.035], // dished muzzle sides
];
// eyelids: a ring of small bumps around the eye socket
for (let i = 0; i < 8; i++) {
  const a = (i / 8) * Math.PI * 2;
  HEADB.push([6.9 + Math.cos(a) * 0.22, 2.02 + Math.sin(a) * 0.34, 0.1, 0.1, i === 2 || i === 3 ? 0.07 : 0.05]);
}
export const EYE = { c: [0.41, 6.9, 0.87], r: 0.155, gaze: norm([0.62, 0.55, 0.38]) };

/**
 * Radial displacement (muscle atlas, ridges, scutes, the head's relief) at axis y and ventral angle s. Everything that
 * only depends on y is folded into a per-ring cache of gaussian items [s0, width, amplitude]; evaluating a vertex
 * is then a short loop.
 */
function dispCache(y, v) {
  const items = [];
  for (let i = 0; i < BUMPS.length; i++) {
    const b = BUMPS[i];
    const dy = (y - b[0]) / b[2];
    if (dy > 3 || dy < -3) continue;
    items.push(b[1], b[3], b[4] * Math.exp(-dy * dy));
  }
  if (y > 5.8) {
    const P = SPINE(y);
    const R = 0.5 * (P[1] + P[2]) || 0.4;
    for (let i = 0; i < HEADB.length; i++) {
      const b = HEADB[i];
      const dy = (y - b[0]) / b[2];
      if (dy > 3 || dy < -3) continue;
      items.push(b[1], b[3] / R, b[4] * Math.exp(-dy * dy));
    }
  }
  // ribs under the skin
  if (y > -1.0 && y < 1.9) items.push(1.95, 0.6, 0.032 * Math.cos(((y + 1.0) / 0.36) * TAU) * sstep(-1.0, -0.4, y) * (1 - sstep(1.2, 1.9, y)));
  // dorsal ridge with vertebral humps, strongest on the neck and the back, fading to the tail tip
  const ridge = 0.05 + 0.06 * sstep(-11, -5, y) + 0.05 * sstep(-3, 1, y) * (1 - sstep(5, 6.4, y));
  items.push(Math.PI, 0.2, ridge * (0.6 + 0.4 * Math.abs(Math.cos((y * Math.PI) / 0.5))));
  // tail: lateral and ventral ridges
  if (y < -2.5) {
    const f = sstep(-12, -9, y) * (1 - sstep(-4, -2.5, y));
    items.push(1.75, 0.25, 0.035 * f, 0, 0.3, 0.04 * f);
  }
  // mouth: lip ridge and the arched palate
  if (y > 5.9) {
    const hf = sstep(5.9, 6.3, y) * (1 - sstep(8.45, 8.6, y));
    items.push(LIP_S, 0.09, 0.04 * hf, 0.2, 0.5, -0.1 * hf * sstep(6.2, 6.8, y));
  }
  // belly scutes: transverse bands with a forward overlap, in step with the shader's plate rows
  let band = 0, bw = 1;
  if (y < 5.4 && y > -11.5) {
    bw = BELLYW(y)[0];
    const ph = (((v / 0.95 - 0.3) % 1) + 1) % 1;
    band = 0.02 * (ph < 0.82 ? ph / 0.82 : (1 - ph) / 0.18) * sstep(-11.5, -9, y);
  }
  return { items, band, bw };
}
function evalDisp(c, s) {
  const it = c.items;
  let d = 0;
  for (let i = 0; i < it.length; i += 3) {
    const ds = (s - it[i]) / it[i + 1];
    d += it[i + 2] * Math.exp(-ds * ds);
  }
  if (c.band) d += c.band * (1 - sstep(c.bw - 0.3, c.bw + 0.15, s));
  return d;
}
function coreDisp(y, s) {
  return evalDisp(dispCache(y, 0), s);
}

/** world position on the spine skin at axis y, outline angle th (same maths as the loft's section function) */
export function corePos(y, th) {
  const P = SPINE(y);
  const s = th <= Math.PI ? th : TAU - th;
  const sx = Math.sin(th), cy = -Math.cos(th);
  const up = cy > 0;
  const e = 2 / (up ? P[4] : P[5]);
  let a = P[1] * sgnpow(sx, e), b = (up ? P[2] : P[3]) * sgnpow(cy, e);
  const r = Math.hypot(a, b) || 1;
  const d = coreDisp(y, s);
  a += (a / r) * d;
  b += (b / r) * d;
  const dz = (SPINE(y + 0.05)[0] - SPINE(y - 0.05)[0]) / 0.1;
  const h = Math.hypot(1, dz);
  return [a, y - (b * dz) / h, P[0] + b / h];
}

// ring y positions: dense on the head, relaxed along the torso and tail
function ringYs(detail) {
  const ys = [];
  const seg = [[-12.5, -10.0, 0.3], [-10.0, -3.0, 0.24], [-3.0, 2.1, 0.17], [2.1, 5.5, 0.12], [5.5, 8.0, 0.055], [8.0, 8.65, 0.04]];
  for (const [a, b, step] of seg) {
    const st = step / detail;
    const n = Math.max(1, Math.round((b - a) / st));
    for (let i = 0; i < n; i++) ys.push(a + ((b - a) * i) / n);
  }
  ys.push(8.65);
  return ys;
}

export function buildCore(detail = 1) {
  const part = new Part();
  const N = detail >= 0.8 ? 56 : detail >= 0.5 ? 32 : 14;
  const lipK = Math.round((N * LIP_S) / TAU);
  const ys = ringYs(detail);
  const rings = ys.map((y) => {
    const P = SPINE(y);
    const dz = (SPINE(y + 0.05)[0] - SPINE(y - 0.05)[0]) / 0.1;
    const T = norm([0, 1, dz]);
    return { y, P, c: [0, y, P[0]], R: [1, 0, 0], U: [0, -T[2], T[1]], cell: CELL(y)[0], bw: BELLYW(y)[0] };
  });
  // the loft's own v (cells along the body), so plate rows and relief line up
  let vAcc = 0;
  rings.forEach((r, i) => {
    if (i) vAcc += Math.hypot(r.c[1] - rings[i - 1].c[1], r.c[2] - rings[i - 1].c[2]) / (0.5 * (r.cell + rings[i - 1].cell));
    r.dc = dispCache(r.y, vAcc);
  });
  const info = loft(part, {
    rings, N, cap0: true, cap1: true,
    sec: (i, th, s, r) => {
      const P = r.P;
      const sx = Math.sin(th), cy = -Math.cos(th);
      const up = cy > 0;
      const e = 2 / (up ? P[4] : P[5]);
      let a = P[1] * sgnpow(sx, e), b = (up ? P[2] : P[3]) * sgnpow(cy, e);
      const rr = Math.hypot(a, b) || 1;
      const d = evalDisp(r.dc, s);
      return [a + (a / rr) * d, b + (b / rr) * d];
    },
    attr: (i, k, th, s, r) => {
      const y = r.y;
      const belly = (1 - sstep(r.bw - 0.4, r.bw + 0.2, s)) * (1 - sstep(5.3, 6.1, y)) * sstep(-11.8, -10, y);
      const mouth = y > 5.95 && y < 8.55 && s < LIP_S - 0.12 ? 1 : 0;
      const plates = detail < 0.5 ? 0 : sstep(1.7, 2.4, s) * sstep(5.7, 6.3, y) * (1 - sstep(8.3, 8.5, y));
      return [belly, 0, plates, mouth];
    },
  });
  part.normals(0);
  gridCavityAO(part, info);
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    const rad = Math.max(ring.P[1], ring.P[2]);
    const w = spineWeights(ring.y, rad);
    for (let k = 0; k < N; k++) setSkin(part, info.base + r * N + k, w);
  }
  // cap centres
  for (let i = info.base + info.NR * N; i < part.count; i++) setSkin(part, i, spineWeights(i === info.base + info.NR * N ? rings[0].y : rings[rings.length - 1].y, 0.05));
  part.core = { info, N, lipK, rings };
  return part;
}

/** lip line point (R side) at y, on the loft's own vertices when possible */
export function lipPoint(y, side = 1) {
  const th = side > 0 ? LIP_S : TAU - LIP_S;
  return corePos(y, th);
}

// ------------------------------------------------------------------------------------------------------
// jaw: a U-shaped tube tucked under the lip line, with a flat top that is the floor of the mouth
const JAW_Y0 = 6.0, JAW_Y1 = 8.5;
const JAWD = table([[5.9, 0.2], [6.15, 0.3], [6.5, 0.36], [7.0, 0.26], [7.6, 0.17], [8.1, 0.12], [8.5, 0.09]]);
export function jawDims(y) {
  const lp = corePos(y, LIP_S);
  const t = (y - JAW_Y0) / (JAW_Y1 - JAW_Y0);
  return { x: Math.max(0.1, lp[0] - 0.045), zTop: lp[2] - 0.02, depth: JAWD(y)[0] };
}
export function buildJaw(detail = 1) {
  const part = new Part();
  const N = detail >= 0.8 ? 32 : 8;
  const ys = [];
  const n = detail >= 0.8 ? 34 : 5;
  for (let i = 0; i <= n; i++) ys.push(JAW_Y0 + ((JAW_Y1 - JAW_Y0) * i) / n);
  const rings = ys.map((y) => {
    const d = jawDims(y);
    const T = norm([0, 1, -0.05]);
    return { y, d, c: [0, y, d.zTop - 0.03], R: [1, 0, 0], U: [0, 0, 1], cell: 0.1 };
  });
  const info = loft(part, {
    rings, N, cap0: true, cap1: true,
    sec: (i, th, s, r) => {
      const sx = Math.sin(th), cy = -Math.cos(th);
      const up = cy > 0;
      const e = 2 / (up ? 6 : 2.3);
      let a = r.d.x * sgnpow(sx, e), b = (up ? 0.03 : r.d.depth) * sgnpow(cy, e);
      // chin and jaw angle
      const t = (r.y - JAW_Y0) / (JAW_Y1 - JAW_Y0);
      if (!up) b *= 1 + 0.25 * gauss(t, 0.0, 0.2) + 0.12 * gauss(s, 0, 0.5) * 0;
      const d = 0.05 * Math.exp(-(((s - 0.55) / 0.25) ** 2)) * sstep(0.0, 0.25, t); // jawline
      return [a + (a === 0 ? 0 : Math.sign(a)) * d, b - (b < 0 ? d * 0.5 : 0)];
    },
    attr: (i, k, th, s, r) => {
      const inside = s > 2.0 ? 1 : 0; // the flat top of the tube
      const belly = (1 - sstep(0.5, 1.0, s)) * (r.y > 6.3 ? 1 : 0.5);
      return [belly * 0.5, 0, 0, inside];
    },
  });
  part.normals(0);
  for (let i = 0; i < part.count; i++) setSkin(part, i, [[BI.jaw, 1]]);
  // the rear end is buried inside the skull; blend it into the head bone a little for a clean hinge
  for (let i = 0; i < part.count; i++) {
    const y = part.p[i * 3 + 1];
    if (y < 6.2) setSkin(part, i, [[BI.jaw, sstep(5.95, 6.2, y)], [BI.head, 1 - sstep(5.95, 6.2, y)]]);
  }
  return part;
}

// ------------------------------------------------------------------------------------------------------
// teeth along both lips, a pair of fangs, and the tongue
export function buildTeeth(detail = 1, fangScale = 1) {
  const part = new Part();
  const rnd = rng(11);
  const seg = detail >= 0.8 ? 6 : 4;
  const rows = detail >= 0.8 ? 4 : 3;
  for (const side of [1, -1]) {
    // upper row: roots on the lip line, pointing down; lengths peak at the canines
    const ys = [];
    for (let y = 8.4; y > 6.45; y -= 0.15 + (8.4 - y) * 0.03) ys.push(y);
    ys.forEach((y, i) => {
      const lp = corePos(y, side > 0 ? LIP_S : TAU - LIP_S);
      const canine = i === 2 || i === 3 ? 1 : 0;
      const t = i / ys.length;
      const L = (0.09 + 0.1 * (1 - t) * (1 - t) + canine * 0.17 * fangScale) * (0.8 + rnd() * 0.4);
      const x0 = lp[0] - side * 0.015;
      const base = [x0, y, lp[2] + 0.025];
      const ctrl = [base, [x0 + side * 0.01, y + 0.01, base[2] - L * 0.35], [x0 + side * 0.015, y + 0.03, base[2] - L * 0.7], [x0 + side * 0.01, y + 0.045 + canine * 0.03, base[2] - L]];
      const s0 = part.count;
      horn(part, ctrl, { r0: 0.034 + canine * 0.02 + 0.015 * (1 - t), tipR: 0.004, rings: rows + 1, seg, taper: 1.3, c0: 0.55, c1: 1, cap0: true, ref: [1, 0, 0] });
      skinRigid(part, s0, part.count, BI.head);
    });
    // lower row: from the jaw's lip edge, pointing up, interleaved
    const yj = [];
    for (let y = 8.38; y > 6.5; y -= 0.15 + (8.38 - y) * 0.03) yj.push(y - 0.07);
    yj.forEach((y, i) => {
      const jd = jawDims(y);
      const t = i / yj.length;
      const canine = i === 1 ? 1 : 0;
      const L = (0.08 + 0.09 * (1 - t) * (1 - t) + canine * 0.17 * fangScale) * (0.8 + rnd() * 0.4);
      const x0 = side * (jd.x - 0.005);
      const base = [x0, y, jd.zTop - 0.01];
      const ctrl = [base, [x0 - side * 0.005, y + 0.01, base[2] + L * 0.35], [x0 - side * 0.015, y + 0.03, base[2] + L * 0.7], [x0 - side * 0.02, y + 0.05, base[2] + L]];
      const s0 = part.count;
      horn(part, ctrl, { r0: 0.03 + canine * 0.02 + 0.012 * (1 - t), tipR: 0.004, rings: rows + 1, seg, taper: 1.3, c0: 0.55, c1: 1, cap0: true, ref: [1, 0, 0] });
      skinRigid(part, s0, part.count, BI.jaw);
    });
  }
  part.normals(0);
  return part;
}

export function buildTongue(detail = 1) {
  const part = new Part();
  const n = Math.round(14 * detail) + 4;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, y = lerp(6.25, 8.0, t);
    pts.push([0, y, jawDims(y).zTop - 0.1 + 0.03 * Math.sin(t * 3.1)]);
  }
  const rings = pts.map((c, i) => ({ c, R: [1, 0, 0], U: [0, 0, 1], cell: 0.08 }));
  const info = loft(part, {
    rings, N: 12, cap0: true, cap1: true,
    sec: (i, th, s) => {
      const t = i / n;
      const w = (0.2 - 0.13 * t * t) * (1 - 0.7 * Math.pow(Math.max(0, t - 0.88) / 0.12, 2));
      const sx = Math.sin(th), cy = -Math.cos(th);
      // forked tip
      const fork = t > 0.9 ? 1 - 0.5 * gauss(sx, 0, 0.25) * (t - 0.9) * 10 : 1;
      return [sx * w, cy * (cy > 0 ? 0.07 : 0.05) * fork];
    },
    attr: () => [0, 0, 0, 0.75],
  });
  part.normals(0);
  for (let i = 0; i < part.count; i++) {
    const y = part.p[i * 3 + 1];
    setSkin(part, i, [[BI.jaw, sstep(6.2, 6.8, y)], [BI.head, 1 - sstep(6.2, 6.8, y)]]);
  }
  return part;
}

// ------------------------------------------------------------------------------------------------------
// eyes: glossy balls. The UVs are the gaze-axis projection (what createEyeMaterial expects)
export function buildEyes(detail = 1) {
  const part = new Part();
  const nu = detail >= 0.8 ? 18 : 8, nv = detail >= 0.8 ? 10 : 4;
  for (const side of [1, -1]) {
    const c = [EYE.c[0] * side, EYE.c[1], EYE.c[2]];
    const g = [EYE.gaze[0] * side, EYE.gaze[1], EYE.gaze[2]];
    const up = norm(sub([0, 0, 1], mul(g, g[2])));
    const rt = norm(cross(g, up));
    const base = part.count;
    for (let j = 0; j <= nv; j++) {
      const ph = (j / nv) * Math.PI;
      for (let i = 0; i <= nu; i++) {
        const th = (i / nu) * TAU;
        const n = norm(add(add(mul(g, Math.cos(ph)), mul(rt, Math.sin(ph) * Math.cos(th))), mul(up, Math.sin(ph) * Math.sin(th))));
        const p = madd(c, n, EYE.r);
        // gaze projection: the disk seen along the gaze axis (the back hemisphere is hidden inside the head)
        const u = 0.5 + 0.5 * dot(n, rt);
        const v = 0.5 + 0.5 * dot(n, up);
        part.vert(p[0], p[1], p[2], u, v);
        part.n[(part.count - 1) * 3] = n[0];
        part.n[(part.count - 1) * 3 + 1] = n[1];
        part.n[(part.count - 1) * 3 + 2] = n[2];
      }
    }
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        const a = base + j * (nu + 1) + i, b = a + 1, c2 = a + nu + 1, d = c2 + 1;
        part.tri(a, c2, b);
        part.tri(b, c2, d);
      }
  }
  part.orient(0);
  for (let i = 0; i < part.count; i++) setSkin(part, i, [[BI.head, 1]]);
  return part;
}
