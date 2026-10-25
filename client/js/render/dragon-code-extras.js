// Breed extras of the procedural dragon: horns, antlers, crests, crystals, tail ornaments, fins and hoods, plus the
// head spikes every breed shares. Same contract as the GLB: Extra_<breed> (skin, shares the body material) and
// WExtra_<breed> (membrane, shares the wing material). Coordinates: X right, Y forward, Z up.
import {
  TAU, clamp, lerp, sstep, gauss, norm, sub, add, mul, dot, cross, mix, madd, dist,
  Part, loft, horn, pathFrames, bezier, spline, setSkin, skinRigid, rng,
} from './dragon-code-util.js';
import { BI, corePos, spineWeights, SPINE } from './dragon-code-geo.js';

const mx = (p, s) => [p[0] * s, p[1], p[2]];
const dorsal = (y) => corePos(y, Math.PI);

/** common knobs for a given level of detail */
function lod(detail) {
  const hi = detail >= 0.8;
  return { hi, seg: hi ? 8 : 4, r: (n) => (hi ? Math.max(4, Math.round(n)) : Math.max(3, Math.round(n * 0.3))), stride: hi ? 1 : 2.2 };
}

function skinWith(part, from, w) {
  for (let i = from; i < part.count; i++) setSkin(part, i, w);
}

/** a spike rooted on the dorsal midline at spine position y, swept back, rigid with the spine bone there */
function spineSpike(part, y, h, o, L) {
  const root = dorsal(y);
  const sweep = o.sweep ?? 0.5, lean = o.lean ?? 0;
  const base = [root[0], root[1], root[2] - 0.06];
  const d = [lean, -sweep * h, h];
  const ctrl = [base, madd(base, d, 0.34), madd(madd(base, d, 0.7), [0, -1, 0], h * (o.curve ?? 0.15)), madd(madd(base, d, 1.0), [0, -1, 0], h * (o.curve ?? 0.15) * 2.2)];
  const s0 = part.count;
  horn(part, ctrl, {
    r0: o.r0 ?? 0.06 + 0.07 * h, tipR: 0.006, rings: L.r(o.rings ?? 8), seg: L.seg, flare: o.flare ?? 0.5, taper: o.taper ?? 1.15,
    ridges: o.ridges ?? 0, ratio: o.ratio ?? 1, c0: 0.5, c1: 1, ref: [1, 0, 0],
  });
  skinWith(part, s0, spineWeights(y, 0.5));
}

/** spikes along the spine between y0 and y1, heights given by hfn(y) */
function spineRow(part, y0, y1, step, hfn, o, L, rnd) {
  for (let y = y0; y > y1; y -= step * L.stride) {
    const h = hfn(y) * (0.92 + 0.16 * (rnd ? rnd() : 0.5));
    spineSpike(part, y, h, o, L);
  }
}

// ------------------------------------------------------------------------------------------------------
// head spikes shared by every breed: brow spikes, cheek spikes, jaw spikes, chin barbels
export function buildHeadSpikes(detail = 1) {
  const part = new Part();
  const L = lod(detail);
  const rnd = rng(77);
  for (const s of [1, -1]) {
    // brow spike over each eye, swept back
    let s0 = part.count;
    horn(part, [[s * 0.52, 6.55, 1.0], [s * 0.62, 6.3, 1.4], [s * 0.7, 6.0, 1.62], [s * 0.78, 5.62, 1.66]], { r0: 0.1, tipR: 0.006, rings: L.r(9), seg: L.seg, flare: 0.6, c0: 0.5, c1: 1, ref: [0, 0, 1] });
    skinRigid(part, s0, part.count, BI.head);
    // cheek spikes along the jaw hinge, curving back and growing toward the rear
    for (let i = 0; i < 3; i++) {
      s0 = part.count;
      const y = 6.55 - i * 0.3, z = 0.52 - i * 0.14, x = s * (0.64 + i * 0.03);
      horn(part, [[x, y, z], [x + s * 0.12, y - 0.15, z + 0.05], [x + s * 0.3, y - 0.4, z + 0.04 - i * 0.04], [x + s * 0.5, y - 0.8 - i * 0.12, z - 0.1 - i * 0.1]], { r0: 0.08 - i * 0.012, tipR: 0.006, rings: L.r(7), seg: L.seg, flare: 0.5, c0: 0.5, c1: 1 });
      skinRigid(part, s0, part.count, BI.head);
    }
    // jaw spikes
    for (let i = 0; i < 2; i++) {
      s0 = part.count;
      const y = 6.55 + i * 0.6, x = s * (0.4 - i * 0.07);
      horn(part, [[x, y, -0.06], [x + s * 0.1, y - 0.1, -0.2], [x + s * 0.2, y - 0.3, -0.4], [x + s * 0.28, y - 0.55, -0.66]], { r0: 0.06, tipR: 0.005, rings: L.r(6), seg: L.seg, flare: 0.4, c0: 0.5, c1: 1 });
      skinRigid(part, s0, part.count, BI.jaw);
    }
    // nose horn nubs
    s0 = part.count;
    horn(part, [[s * 0.14, 8.0, 0.5], [s * 0.15, 8.0, 0.62], [s * 0.16, 7.95, 0.7], [s * 0.17, 7.85, 0.8]], { r0: 0.05, tipR: 0.006, rings: L.r(5), seg: L.seg, flare: 0.4, c0: 0.5, c1: 1 });
    skinRigid(part, s0, part.count, BI.head);
  }
  // chin barbels
  for (const s of [1, -1]) {
    const s0 = part.count;
    horn(part, [[s * 0.1, 8.1, -0.0], [s * 0.1, 8.15, -0.15], [s * 0.1, 8.1, -0.32], [s * 0.1, 7.95, -0.48]], { r0: 0.04, tipR: 0.005, rings: L.r(5), seg: L.seg, c0: 0.5, c1: 1 });
    skinRigid(part, s0, part.count, BI.jaw);
  }
  part.normals(0);
  return part;
}

// ------------------------------------------------------------------------------------------------------
// fins and hoods: ribs (tapered horns) with a scalloped membrane between them
function fan(ribs, mem, root, tips, o, L, bone) {
  const nT = o.nT ?? 6, nS = o.nS ?? 6;
  const ctrl = (tip) => [root, madd(root, sub(tip, root), 0.35), madd(root, sub(tip, root), 0.7), tip];
  tips.forEach((tip, k) => {
    const s0 = ribs.count;
    const c = ctrl(tip);
    c[1][2] += o.rise ?? 0;
    horn(ribs, c, { r0: o.rib ?? 0.06, tipR: 0.006, rings: L.r(8), seg: L.seg, flare: 0.3, c0: 0.5, c1: 1 });
    skinRigid(ribs, s0, ribs.count, bone);
  });
  const base = mem.count;
  for (let k = 0; k < tips.length - 1; k++) {
    const b0 = mem.count;
    const a = tips[k], b = tips[k + 1];
    for (let j = 0; j <= nT; j++) {
      const t = j / nT;
      const edge = mix(a, b, t);
      const sMax = 1 - (o.scallop ?? 0.2) * Math.sin(Math.PI * t);
      for (let i = 0; i <= nS; i++) {
        const sg = i / nS;
        const p = madd(root, sub(edge, root), sg * sMax);
        p[2] += (o.sag ?? 0.08) * Math.sin(Math.PI * t) * sg;
        const thin = clamp(sg * 1.3, 0, 1) * (0.35 + 0.65 * Math.sin(Math.PI * t));
        mem.vert(p[0], p[1], p[2], p[0] * 0.2 + 0.5, p[1] * 0.2 + 0.5, thin, 1, 0, 0);
      }
    }
    for (let j = 0; j < nT; j++) for (let i = 0; i < nS; i++) {
      const v0 = b0 + j * (nS + 1) + i;
      mem.tri(v0, v0 + 1, v0 + nS + 1);
      mem.tri(v0 + 1, v0 + nS + 2, v0 + nS + 1);
    }
  }
  skinRigid(mem, base, mem.count, bone);
}

// ------------------------------------------------------------------------------------------------------
// tail ornaments
function leafBlade(part, y0, y1, wmax, o, L, bone) {
  const n = L.r(30);
  const rings = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1), y = lerp(y0, y1, t);
    rings.push({ c: [0, y, o.z ?? 0.0], R: [1, 0, 0], U: [0, 0, 1], cell: 0.12, t });
  }
  const s0 = part.count;
  loft(part, {
    rings, N: L.hi ? 16 : 6, cap0: true, cap1: true,
    sec: (i, th, s, r) => {
      const t = r.t;
      const w = o.width(t) * wmax;
      const thick = (o.thick ?? 0.06) * (1 - 0.5 * t) + 0.012;
      const x = Math.sin(th);
      // a raised midrib, thin skin toward the edges
      return [x * w, -Math.cos(th) * thick * (0.55 + 1.1 * Math.pow(1 - Math.abs(x), 3))];
    },
    attr: (i, k, th, s, r) => [0, o.keratin ?? 0.3, 0, 0],
  });
  skinRigid(part, s0, part.count, bone);
}

function spadeTail(part, L) {
  // a stalk, then a broad pointed blade with a raised midrib, ringed by hooked barbs
  leafBlade(part, -11.6, -14.1, 0.95, { width: (t) => (t < 0.13 ? 0.09 : t < 0.3 ? 0.09 + 0.91 * sstep(0.13, 0.3, t) : Math.pow(Math.max(0, 1 - (t - 0.3) / 0.7), 1.25)) + 0.015, thick: 0.1, keratin: 0.3 }, L, BI.tail7);
  for (const s of [1, -1]) {
    for (const [y, ln, hook] of [[-12.5, 0.8, 0.4], [-13.0, 1.0, 0.5], [-13.5, 0.7, 0.45]]) {
      const b = part.count;
      const x = s * 0.6 * Math.max(0.15, 1 - (-(y + 12.1) / 2.6) * 0.9);
      horn(part, [[x, y, 0], [x + s * 0.3, y - 0.05, 0.03], [x + s * 0.6, y + 0.2, 0.06], [x + s * 0.75, y + 0.5 * ln, 0.15 + hook * 0.2]], { r0: 0.06, tipR: 0.005, rings: L.r(7), seg: L.seg, flare: 0.3, c0: 0.5, c1: 1 });
      skinRigid(part, b, part.count, BI.tail7);
    }
  }
}

function swallowTail(part, wing, L) {
  // two long pointed blades diverging from the tail end, with a membrane (the wing material) between them
  const sheet = [];
  for (const s of [1, -1]) {
    const n = L.r(26);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      pts.push([s * 2.0 * Math.pow(t, 1.4), lerp(-11.8, -14.8, t), 0.04 + 0.06 * Math.sin(t * 3)]);
    }
    sheet.push(pts);
    const fr = pathFrames(pts, [0, 0, 1]);
    const s0 = part.count;
    loft(part, {
      rings: pts.map((c, i) => ({ c, R: fr[i].R, U: fr[i].U, cell: 0.12, t: i / (n - 1) })), N: L.hi ? 12 : 6, cap0: true, cap1: true,
      sec: (i, th, s2, r) => {
        const t = r.t;
        const w = (0.08 + 0.2 * Math.sin(Math.PI * Math.min(1, t * 1.2))) * (1 - Math.pow(t, 3)) + 0.012;
        return [Math.sin(th) * w, -Math.cos(th) * w * 0.7];
      },
      attr: (i, k, th, s2, r) => [0, 0.5 + 0.5 * r.t, 0, 0],
    });
    skinRigid(part, s0, part.count, BI.tail7);
  }
  // webbing: single sheet, scalloped between the blades
  const nS = 8, nT = L.hi ? 12 : 5, base = wing.count;
  for (let j = 0; j <= nT; j++) {
    for (let i = 0; i <= nS; i++) {
      const q = i / nS;
      const tEnd = 0.28 + 0.64 * Math.pow(Math.abs(2 * q - 1), 1.2);
      const t = (j / nT) * tEnd;
      const f = t * (sheet[0].length - 1), i0 = Math.min(sheet[0].length - 2, Math.floor(f)), fr = f - i0;
      const p = mix(mix(sheet[0][i0], sheet[0][i0 + 1], fr), mix(sheet[1][i0], sheet[1][i0 + 1], fr), q);
      p[1] += Math.sin(Math.PI * q) * 0.25 * (1 - t);
      p[2] -= 0.1 * Math.sin(Math.PI * q) * (j / nT);
      wing.vert(p[0], p[1], p[2], p[0] * 0.2 + 0.5, p[1] * 0.2 + 0.5, clamp((j / nT) * 1.2, 0, 1) * (0.4 + 0.6 * Math.sin(Math.PI * q)), 1, 0, 0);
    }
  }
  for (let j = 0; j < nT; j++) for (let i = 0; i < nS; i++) {
    const v0 = base + j * (nS + 1) + i;
    wing.tri(v0, v0 + 1, v0 + nS + 1);
    wing.tri(v0 + 1, v0 + nS + 2, v0 + nS + 1);
  }
  skinRigid(wing, base, wing.count, BI.tail7);
}

function stinger(part, L) {
  let s0 = part.count;
  horn(part, [[0, -11.9, 0.0], [0, -12.6, 0.15], [0, -13.1, 0.6], [0, -13.0, 1.25]], { r0: 0.14, tipR: 0.01, rings: L.r(14), seg: L.seg, flare: 0.2, c0: 0.5, c1: 1, ridges: 4, taper: 0.9 });
  skinRigid(part, s0, part.count, BI.tail7);
  for (const [dy, dz, s] of [[0.4, 0.35, 1], [0.4, 0.35, -1], [0.7, 0.2, 0]]) {
    s0 = part.count;
    const b = [0, -13.05 + dy * -0.5, 0.85 + dz * 0.3];
    horn(part, [madd(b, [0, 0, 0], 1), madd(b, [s * 0.25, -0.15, 0.05], 1), madd(b, [s * 0.5, -0.35, -0.1], 1), madd(b, [s * 0.65, -0.65, -0.35], 1)], { r0: 0.05, tipR: 0.005, rings: L.r(6), seg: L.seg, c0: 0.5, c1: 1 });
    skinRigid(part, s0, part.count, BI.tail7);
  }
  // a row of hooked thorns along the last stretch of tail
  for (let y = -6.5; y > -11.5; y -= 0.8) spineSpike(part, y, 0.5 - (y + 6.5) * -0.04 * 0.4, { sweep: 0.5, curve: 0.3 }, L);
}

// ------------------------------------------------------------------------------------------------------
// crystals
function crystal(part, base, d, r, len, bone, L, o = {}) {
  const dd = norm(d);
  const tip = madd(base, dd, len);
  const s0 = part.count;
  horn(part, [base, madd(base, dd, len * 0.33), madd(base, dd, len * 0.66), tip], {
    r0: r, tipR: r * 0.04, rings: L.hi ? o.rings ?? 5 : 3, seg: L.hi ? 6 : 4, taper: 0.18, c0: 0, c1: 0, mouth: 0.25, cap0: true, ref: o.ref || [0, 0, 1],
  });
  if (bone !== null && bone !== undefined) skinRigid(part, s0, part.count, bone);
  return s0;
}

function crystalCluster(part, y, side, n, scale, rnd, L) {
  if (!L.hi) n = Math.max(1, Math.round(n * 0.4));
  const root = side === 0 ? dorsal(y) : corePos(y, side > 0 ? 2.3 : TAU - 2.3);
  const w = spineWeights(y, 0.5);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rnd() * 0.5, tilt = 0.25 + rnd() * 0.5;
    const up = side === 0 ? [0, 0, 1] : norm([side * 0.7, 0, 0.7]);
    const d = norm(add(up, [Math.cos(a) * tilt, Math.sin(a) * tilt - 0.15, 0]));
    const len = scale * (0.55 + rnd() * 0.9), r = scale * (0.1 + rnd() * 0.07);
    const s0 = crystal(part, madd(root, up, -0.08), d, r, len, null, L, { ref: [1, 0, 0] });
    for (let k = s0; k < part.count; k++) setSkin(part, k, w.map((x) => x.slice()));
  }
}

// ------------------------------------------------------------------------------------------------------
function extrasEmber(L) {
  const rnd = rng(1);
  const body = new Part(), wing = new Part();
  // two swept-back ridged horns on each side
  for (const s of [1, -1]) {
    let s0 = body.count;
    horn(body, [[s * 0.34, 6.2, 1.12], [s * 0.74, 5.5, 1.85], [s * 1.12, 4.4, 2.15], [s * 1.2, 3.0, 1.7]], { r0: 0.2, tipR: 0.01, rings: L.r(26), seg: L.hi ? 12 : 6, flare: 0.35, c0: 0.5, c1: 1, ridges: 5.2, ridgeAmp: 0.09, grooves: 5, grooveAmp: 0.06, taper: 1.0, ref: [0, 0, 1] });
    skinRigid(body, s0, body.count, BI.head);
    s0 = body.count;
    horn(body, [[s * 0.56, 6.0, 1.0], [s * 0.98, 5.55, 1.3], [s * 1.38, 4.9, 1.3], [s * 1.7, 4.2, 0.95]], { r0: 0.11, tipR: 0.008, rings: L.r(14), seg: L.seg, flare: 0.4, c0: 0.5, c1: 1, ridges: 5, ridgeAmp: 0.08, ref: [0, 0, 1] });
    skinRigid(body, s0, body.count, BI.head);
  }
  // dorsal spikes: small on the neck, tall at the shoulders, shrinking down the tail
  spineRow(body, 5.3, -9.2, 0.62, (y) => {
    if (y > 2.2) return lerp(0.55, 1.15, sstep(5.3, 2.4, y));
    if (y > -1) return lerp(1.15, 0.8, sstep(2.2, -1, y));
    return lerp(0.8, 0.14, sstep(-1, -9.2, y));
  }, { sweep: 0.55, curve: 0.18, ridges: 4 }, L, rnd);
  spadeTail(body, L);
  // ear fins behind the eyes
  for (const s of [1, -1]) {
    const root = [s * 0.5, 6.4, 0.9];
    const tips = [[s * 1.9, 5.4, 1.5], [s * 2.3, 5.2, 0.95], [s * 2.4, 5.3, 0.4], [s * 2.0, 5.5, -0.15]];
    fan(body, wing, root, tips, { rib: 0.05, nT: 7, nS: 6, scallop: 0.22, sag: 0.05 }, L, BI.head);
  }
  return { body, wing };
}

function extrasFrost(L) {
  const rnd = rng(2);
  const body = new Part();
  // branching antlers
  for (const s of [1, -1]) {
    const beam = [[s * 0.32, 6.2, 1.15], [s * 0.7, 5.6, 1.9], [s * 1.0, 4.7, 2.3], [s * 1.1, 3.6, 2.2]];
    let s0 = body.count;
    horn(body, beam, { r0: 0.17, tipR: 0.01, rings: L.r(24), seg: L.hi ? 10 : 6, flare: 0.4, c0: 0, c1: 0, mouth: 0.25, ridges: 4, ridgeAmp: 0.05, taper: 0.9, ref: [0, 0, 1] });
    skinRigid(body, s0, body.count, BI.head);
    const tines = [[0.18, 0.9, 0.9], [0.36, 0.8, 1.15], [0.55, 0.7, 1.35], [0.74, 0.55, 1.4]];
    for (const [t, outw, ln] of tines) {
      const b = bezier(beam, t), b2 = bezier(beam, t + 0.02);
      const dir = norm(sub(b2, b));
      const out = norm([s * outw, 0.2, 0.9]);
      const d = norm(add(mul(out, 0.9), mul(dir, -0.35)));
      s0 = body.count;
      horn(body, [b, madd(b, d, ln * 0.33), madd(madd(b, d, ln * 0.7), [0, 0.2, 0.2], 0.25), madd(madd(b, d, ln), [0, 0.5, 0.25], 0.3)], { r0: 0.09 - t * 0.05, tipR: 0.007, rings: L.r(10), seg: L.seg, flare: 0.5, c0: 0, c1: 0, mouth: 0.25, ref: [0, 0, 1] });
      skinRigid(body, s0, body.count, BI.head);
    }
    // small brow tines
    s0 = body.count;
    horn(body, [[s * 0.5, 7.0, 1.0], [s * 0.6, 7.05, 1.25], [s * 0.65, 7.0, 1.5], [s * 0.62, 6.85, 1.8]], { r0: 0.08, tipR: 0.007, rings: L.r(8), seg: L.seg, flare: 0.5, c0: 0, c1: 0, mouth: 0.25 });
    skinRigid(body, s0, body.count, BI.head);
  }
  // ice crystals: a crown on the nape, clusters on the shoulders and back, along the tail
  crystalCluster(body, 5.0, 0, 5, 0.65, rnd, L);
  crystalCluster(body, 3.6, 0, 4, 0.6, rnd, L);
  for (const y of [1.8, 0.2, -1.4]) crystalCluster(body, y, 0, 6, 0.95, rnd, L);
  for (const y of [1.6, -0.2]) for (const s of [1, -1]) crystalCluster(body, y, s, 4, 0.55, rnd, L);
  for (let y = -3.4; y > -9.2; y -= 1.1) crystalCluster(body, y, 0, 3, lerp(0.7, 0.25, sstep(-3, -9.2, y)), rnd, L);
  // elbow crystals
  for (const s of [1, -1]) {
    const E = [s * 3.4, 0.5, 0.85];
    for (let i = 0; i < 3; i++) {
      const s0 = crystal(body, madd(E, [0, 0, 1], 0.1), norm([s * (0.2 + i * 0.4), -0.5 + i * 0.5, 1]), 0.1, 0.7 - i * 0.12, null, L, { ref: [1, 0, 0] });
      for (let k = s0; k < body.count; k++) setSkin(body, k, [[BI[`upperarm.${s > 0 ? 'R' : 'L'}`], 0.5], [BI[`forearm.${s > 0 ? 'R' : 'L'}`], 0.5]]);
    }
  }
  // ice mace on the tail: a fist of crystals
  const tip = [0, -11.9, 0];
  for (let i = 0; i < (L.hi ? 9 : 4); i++) {
    const a = (i / 9) * TAU * (L.hi ? 1 : 2.2);
    const d = i === 0 ? [0, -1, 0] : norm([Math.cos(a) * 0.9, -0.55, Math.sin(a) * 0.9]);
    crystal(body, tip, d, 0.26 + (i === 0 ? 0.12 : 0), (i === 0 ? 2.1 : 1.3 + rnd() * 0.5), BI.tail7, L, { rings: 5 });
  }
  const mid = [0, -12.2, 0];
  for (let i = 0; i < (L.hi ? 6 : 0); i++) {
    const a = (i / 6) * TAU + 0.5;
    crystal(body, mid, norm([Math.cos(a), -0.1, Math.sin(a)]), 0.22, 1.2, BI.tail7, L, { rings: 4 });
  }
  return { body, wing: null };
}

function extrasStorm(L) {
  const rnd = rng(3);
  const body = new Part(), wing = new Part();
  // rapier horns: long, thin, nearly straight
  for (const s of [1, -1]) {
    let s0 = body.count;
    horn(body, [[s * 0.3, 6.25, 1.15], [s * 0.6, 4.6, 1.75], [s * 0.85, 2.4, 2.1], [s * 1.0, -0.4, 2.15]], { r0: 0.13, tipR: 0.006, rings: L.r(34), seg: L.hi ? 10 : 5, flare: 0.5, c0: 0.5, c1: 1, ridges: 3.4, ridgeAmp: 0.05, taper: 1.0, ref: [0, 0, 1] });
    skinRigid(body, s0, body.count, BI.head);
    s0 = body.count;
    horn(body, [[s * 0.5, 6.7, 1.0], [s * 0.7, 6.9, 1.3], [s * 0.85, 7.4, 1.5], [s * 0.9, 8.1, 1.5]], { r0: 0.085, tipR: 0.006, rings: L.r(12), seg: L.seg, flare: 0.5, c0: 0.5, c1: 1, ref: [0, 0, 1] });
    skinRigid(body, s0, body.count, BI.head);
  }
  // sail: tall slim spines along the back with a membrane stretched between them
  const ys = [];
  for (let y = 4.6; y > -6.5; y -= 0.78) ys.push(y);
  const H = (y) => (y > 1 ? lerp(1.3, 2.5, sstep(4.6, 1.2, y)) : lerp(2.5, 0.6, sstep(1, -6.5, y)));
  const tipsP = [], rootsP = [];
  ys.forEach((y) => {
    const h = H(y), r = dorsal(y);
    const base = [r[0], r[1], r[2] - 0.05];
    const tip = [0, base[1] - h * 0.5, base[2] + h];
    rootsP.push(base);
    tipsP.push(tip);
    const s0 = body.count;
    horn(body, [base, madd(base, sub(tip, base), 0.35), madd(madd(base, sub(tip, base), 0.7), [0, -0.1, 0], 1), tip], { r0: 0.06, tipR: 0.005, rings: L.r(12), seg: L.seg, flare: 0.5, c0: 0.5, c1: 1, ref: [1, 0, 0] });
    skinWith(body, s0, spineWeights(y, 0.5));
  });
  for (let i = 0; i < ys.length - 1; i++) {
    const b0 = wing.count, nT = 4, nS = 8;
    for (let j = 0; j <= nT; j++) {
      const t = j / nT;
      const r = mix(rootsP[i], rootsP[i + 1], t), tp = mix(tipsP[i], tipsP[i + 1], t);
      const sMax = 1 - 0.45 * Math.pow(Math.sin(Math.PI * t), 0.8);
      for (let k = 0; k <= nS; k++) {
        const sg = k / nS;
        const p = madd(r, sub(tp, r), sg * sMax);
        wing.vert(p[0], p[1], p[2], p[0] * 0.2 + 0.5, p[1] * 0.2 + 0.5, clamp(sg * 1.4, 0, 1) * (0.4 + 0.6 * Math.sin(Math.PI * t)), 1, 0, 0);
      }
    }
    for (let j = 0; j < nT; j++) for (let k = 0; k < nS; k++) {
      const v0 = b0 + j * (nS + 1) + k;
      wing.tri(v0, v0 + 1, v0 + nS + 1);
      wing.tri(v0 + 1, v0 + nS + 2, v0 + nS + 1);
    }
    const w = spineWeights((ys[i] + ys[i + 1]) / 2, 0.5);
    skinWith(wing, b0, w);
  }
  swallowTail(body, wing, L);
  // big ear fins
  for (const s of [1, -1]) {
    const root = [s * 0.5, 6.45, 0.95];
    const tips = [[s * 1.6, 5.2, 2.3], [s * 2.6, 4.9, 1.6], [s * 3.0, 5.0, 0.7], [s * 2.6, 5.4, -0.1], [s * 1.8, 5.9, -0.6]];
    fan(body, wing, root, tips, { rib: 0.05, nT: 7, nS: 7, scallop: 0.25, sag: 0.06 }, L, BI.head);
  }
  return { body, wing };
}

function extrasVenom(L) {
  const rnd = rng(4);
  const body = new Part(), wing = new Part();
  // forward-curving brow horns and jaw tusks
  for (const s of [1, -1]) {
    let s0 = body.count;
    horn(body, [[s * 0.42, 6.75, 1.15], [s * 0.7, 6.5, 1.6], [s * 0.95, 6.9, 2.05], [s * 0.95, 7.8, 2.0]], { r0: 0.16, tipR: 0.008, rings: L.r(18), seg: L.seg, flare: 0.5, c0: 0.5, c1: 1, ridges: 4, ridgeAmp: 0.07, ref: [0, 0, 1] });
    skinRigid(body, s0, body.count, BI.head);
    s0 = body.count;
    horn(body, [[s * 0.55, 6.2, 1.0], [s * 1.05, 5.9, 1.2], [s * 1.5, 5.3, 1.0], [s * 1.7, 4.5, 0.5]], { r0: 0.1, tipR: 0.007, rings: L.r(12), seg: L.seg, flare: 0.4, c0: 0.5, c1: 1, ref: [0, 0, 1] });
    skinRigid(body, s0, body.count, BI.head);
    // lower jaw tusks curving up past the snout
    s0 = body.count;
    horn(body, [[s * 0.2, 8.0, 0.0], [s * 0.34, 8.1, -0.18], [s * 0.42, 8.2, 0.2], [s * 0.34, 8.15, 0.85]], { r0: 0.085, tipR: 0.007, rings: L.r(12), seg: L.seg, flare: 0.3, c0: 0.5, c1: 1, ref: [1, 0, 0] });
    skinRigid(body, s0, body.count, BI.jaw);
    // long curved fangs in the upper jaw
    s0 = body.count;
    horn(body, [[s * 0.2, 7.85, 0.42], [s * 0.24, 7.88, 0.12], [s * 0.26, 7.82, -0.3], [s * 0.24, 7.72, -0.72]], { r0: 0.075, tipR: 0.006, rings: L.r(9), seg: L.seg, c0: 0.55, c1: 1, ref: [1, 0, 0] });
    skinRigid(body, s0, body.count, BI.head);
  }
  // hooked thorns along the back
  spineRow(body, 5.0, -9.0, 0.7, (y) => (y > 1.5 ? 0.7 : y > -3 ? lerp(0.7, 0.55, sstep(1.5, -3, y)) : lerp(0.55, 0.15, sstep(-3, -9, y))), { sweep: 0.2, curve: 0.9, lean: 0, taper: 1.0 }, L, rnd);
  stinger(body, L);
  // cobra hood: ribs fanning out behind the head with a membrane between them
  for (const s of [1, -1]) {
    const root = [s * 0.4, 5.55, 0.55];
    const tips = [[s * 1.0, 4.5, 2.2], [s * 1.9, 4.45, 1.6], [s * 2.35, 4.7, 0.7], [s * 2.25, 5.0, -0.2], [s * 1.5, 5.4, -0.85]];
    fan(body, wing, root, tips, { rib: 0.06, nT: 7, nS: 7, scallop: 0.1, sag: 0.1 }, L, BI.neck4);
  }
  // the hood's top: a bridge between the two ribs nearest the spine
  {
    const a = [0.5, 5.4, 1.05], b = [-0.5, 5.4, 1.05];
    const top = [[1.0, 4.5, 2.2], [-1.0, 4.5, 2.2]];
    const b0 = wing.count, nS = 6, nT = 6;
    for (let j = 0; j <= nT; j++) {
      const t = j / nT;
      const e = mix(top[0], top[1], t), r = mix(a, b, t);
      for (let i = 0; i <= nS; i++) {
        const sg = i / nS, p = madd(r, sub(e, r), sg * (1 - 0.1 * Math.sin(Math.PI * t)));
        wing.vert(p[0], p[1], p[2], p[0] * 0.2 + 0.5, p[1] * 0.2 + 0.5, clamp(sg * 1.3, 0, 1), 1, 0, 0);
      }
    }
    for (let j = 0; j < nT; j++) for (let i = 0; i < nS; i++) {
      const v0 = b0 + j * (nS + 1) + i;
      wing.tri(v0, v0 + 1, v0 + nS + 1);
      wing.tri(v0 + 1, v0 + nS + 2, v0 + nS + 1);
    }
    skinRigid(wing, b0, wing.count, BI.neck4);
  }
  return { body, wing };
}

export function buildExtras() {
  const out = {};
  const fns = { ember: extrasEmber, frost: extrasFrost, storm: extrasStorm, venom: extrasVenom };
  for (const [breed, fn] of Object.entries(fns)) {
    const hi = fn(lod(1));
    hi.body.normals(0);
    if (hi.wing) hi.wing.normals(0);
    const lo = fn(lod(0.4));
    lo.body.normals(0);
    out[breed] = { body: hi.body, bodyLod: lo.body, wing: hi.wing && hi.wing.count ? hi.wing : null };
  }
  return out;
}
