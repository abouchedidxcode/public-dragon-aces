// The Citadel: a colossal Gothic fortress on a rocky massif at the centre of the map.
//
// This file is the single source of truth for the castle. It holds
//   * the layout (towers, spires, curtain walls, viaducts, flying buttresses, chains, banners, braziers, shrines),
//   * the massif the castle stands on (terrain()),
//   * the colliders (cylinders for towers, boxes for walls, arch walls with holes, beams for buttresses and a
//     spiral test for the ramps) behind hit(), which world.solidAt() uses,
//   * the helpers the bots use to fly around and through it (avoid(), pickGate(), gateAim()).
// The client builds its meshes from the same spec (client/js/render/castle-geo.js), so what you see is what you
// crash into. Everything is a pure function of constants: no randomness, no state beyond caches.
//
// Local frame: x east, z south (the gate faces +z), y up with 0 at the courtyard floor. World y = CASTLE.y0 + y.

export const CASTLE = {
  x: 0,
  z: 0,
  y0: 640, // courtyard floor, world metres (the keep's finial reaches about 1440)
  radius: 540, // everything solid lies inside this radius (the bounding cylinder of the broad phase)
  top: 800, // highest point above the floor (the keep's finial reaches about 798)
  plateau: 345, // radius of the levelled massif top
  clear: 1000, // other landmarks and spawns keep this far from the centre
};

const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// ------------------------------------------------------------------------------------------------ the massif
// Terrain height with the rocky massif blended in. `raw` is the ordinary terrain height at (x, z): the map's castle
// plateau (flat, about 170 m, out to 600 m, see world.js) and the moat beyond it. The massif is a rock pillar that
// stands on that plateau: flat at y0 out to roughly CASTLE.plateau (wobbling with the angle), a 55 m drop to the
// outer bailey's terrace, then a sheer, craggy cliff (about 63 degrees) that meets the plateau at about 670 m. The
// result is the smooth maximum of the two, so the pillar grows out of the plateau instead of sitting on it.
export function terrain(x, z, raw, noise) {
  const dx = x - CASTLE.x, dz = z - CASTLE.z;
  const d2 = dx * dx + dz * dz;
  if (d2 > 900 * 900) return raw;
  const r = Math.sqrt(d2);
  const ang = Math.atan2(dz, dx);
  const wob = noise.fbm(Math.cos(ang) * 1.3 + 7.1, Math.sin(ang) * 1.3 - 3.7, 3);
  const R0 = CASTLE.plateau + 22 * wob;
  const crag = noise.ridged(x * 0.0055 + 3.3, z * 0.0055 - 8.1, 4);
  const crag2 = noise.fbm(x * 0.021, z * 0.021, 3);
  let m;
  const t = r - R0;
  if (t <= 0) {
    // plateau: dead flat, so the courtyard is level
    m = CASTLE.y0;
  } else if (t < 30) {
    m = CASTLE.y0 - 55 * smooth(0, 30, t); // a first cliff, 55 m, down to the outer bailey's terrace
  } else if (t < 118) {
    m = CASTLE.y0 - 55 + 2.5 * crag2; // the terrace the outer curtain wall stands on
  } else {
    // the great cliff: steep, with ridged crags standing out of it, then a talus foot where it meets the plateau
    const u = t - 118;
    const cliff = Math.min(u, 200) * 2.0 + Math.max(0, u - 200) * 0.9;
    const bulge = (crag - 0.35) * 60 * smooth(0, 120, u) * (1 - smooth(120, 330, u));
    m = CASTLE.y0 - 55 - cliff + bulge + crag2 * 14 * smooth(0, 60, u);
  }
  // the road: a causeway cut down from the gate to the barbican on the terrace (it ends at the cliff beyond the
  // barbican: the outer gate opens onto air, a gate for dragons)
  if (z > 250 && z < 462) {
    const rw = 1 - smooth(34, 66, Math.abs(x - CASTLE.x));
    if (rw > 0) m = lerp(m, CASTLE.y0 - 55 * smooth(305, 392, z), rw);
  }
  // smooth maximum with the plateau and the moat country (k = 30 m)
  const k = 30;
  const hh = Math.max(k - Math.abs(raw - m), 0) / k;
  return Math.max(raw, m) + hh * hh * k * 0.25;
}

// ------------------------------------------------------------------------------------------------ arch profiles
// A pointed arch (rise >= half width) or a segmental arch (rise < half width), as the half width of the opening at
// height v above the springing line. Returns -1 above the crown.
export function archHalfWidth(a, rise, type, v) {
  if (v < 0) return a;
  if (v > rise) return -1;
  if (type === 'seg') {
    const R = (a * a + rise * rise) / (2 * rise);
    const cy = rise - R;
    const q = R * R - (v - cy) * (v - cy);
    return q > 0 ? Math.sqrt(q) : 0;
  }
  const cx = (rise * rise - a * a) / (2 * a);
  const R = a + cx;
  const q = R * R - v * v;
  return Math.max(0, (q > 0 ? Math.sqrt(q) : 0) - cx);
}

// Outline of an opening, left foot to right foot: [u, v] pairs, v measured from the floor of the opening.
export function archOutline(a, spring, rise, type, n = 10) {
  const pts = [[-a, 0]];
  if (spring > 0) pts.push([-a, spring]);
  for (let i = 1; i < n; i++) {
    const v = (rise * i) / n;
    pts.push([-archHalfWidth(a, rise, type, v), spring + v]);
  }
  pts.push([0, spring + rise]);
  for (let i = n - 1; i >= 1; i--) {
    const v = (rise * i) / n;
    pts.push([archHalfWidth(a, rise, type, v), spring + v]);
  }
  if (spring > 0) pts.push([a, spring]);
  pts.push([a, 0]);
  return pts;
}

// ------------------------------------------------------------------------------------------------ the layout
// Tower stages: ['shaft', height, topRadius, material, opts], ['gallery', outerRadius, opts],
// ['roof', height, topRadius, opts]. Radii follow on from the stage below; opts.r0 starts a stage at a different
// radius (a set-back ledge).
function makeTower(id, x, z, y0, n, r0, stages, extra = {}) {
  const segs = [];
  let y = y0, r = r0, afterGallery = false;
  for (const st of stages) {
    const kind = st[0];
    if (kind === 'shaft') {
      const [, h, r1, mat, o = {}] = st;
      const rs = o.r0 != null ? o.r0 : r;
      segs.push({ k: 'shaft', y0: y, y1: y + h, r0: rs, r1, mat, twist: (o.twist || 0) * (id === 'keep' ? 1 : 1.6), pil: o.pil || 0, win: o.win || null, belt: o.belt || 0, sides: o.sides || n, step: !afterGallery && rs < r - 0.01 ? r : 0 });
      y += h; r = r1; afterGallery = false;
    } else if (kind === 'gallery') {
      afterGallery = true;
      const [, rOut, o = {}] = st;
      const h = o.h || 14;
      segs.push({ k: 'gallery', y0: y, y1: y + h, r0: r, r1: rOut, mat: o.mat || 'ashlar', sides: o.sides || n, twist: 0, merlon: o.merlon !== false });
      y += h; // the shaft above starts at its own r0
    } else if (kind === 'roof') {
      const [, h, r1, o = {}] = st;
      const rs = o.r0 != null ? o.r0 : r;
      segs.push({ k: 'roof', y0: y, y1: y + h, r0: rs, r1, mat: 'slate', twist: (o.twist || 0) * (id === 'keep' ? 1 : 1.6), rib: o.rib !== false, dormers: o.dormers || 0, crockets: o.crockets || 0, sides: o.sides || n });
      y += h; r = r1;
    }
  }
  return { id, x, z, y0, n, segs, top: y, ...extra };
}

let SPEC = null;

export function castleSpec() {
  if (SPEC) return SPEC;
  const towers = [];
  const walls = [];
  const bays = [];
  const buttresses = [];
  const chains = [];
  const banners = [];
  const braziers = [];

  // ---- the great keep: an octagonal tower in three set-back tiers under a twisting needle spire
  towers.push(makeTower('keep', 0, -20, -60, 8, 106, [
    ['shaft', 72, 98, 'dark', { sides: 8, belt: 1 }],
    ['shaft', 134, 76, 'ashlar', { r0: 88, pil: 8, belt: 3, win: { rows: 6, w: 8, h: 24, start: 12, end: 12, per: 1 } }],
    ['gallery', 98],
    ['shaft', 134, 58, 'ashlar', { r0: 66, twist: 0.5, pil: 8, belt: 2, win: { rows: 5, w: 6.8, h: 21, start: 12, end: 10, per: 1 } }],
    ['gallery', 78],
    ['shaft', 104, 44, 'rubble', { r0: 52, twist: 1.1, pil: 8, win: { rows: 3, w: 6, h: 17, start: 14, end: 12, per: 1 } }],
    ['roof', 112, 33, { twist: 2.6, dormers: 4, crockets: 1 }],
    ['roof', 120, 16, { twist: 3.6, crockets: 1 }],
    ['roof', 128, 0.8, { twist: 4.4, crockets: 1 }],
  ], {
    ramp: { y0: 322, y1: 700, turns: 4.5, phase: 0.5, dir: 1, width: 12 },
    keep: true,
  }));

  // ---- the great towers of the curtain wall
  towers.push(makeTower('ne', 170, -160, -70, 12, 41, [
    ['shaft', 210, 33, 'rubble', { pil: 12, belt: 2, win: { rows: 4, w: 4.5, h: 14, start: 40, end: 14, per: 1 } }],
    ['gallery', 45],
    ['shaft', 146, 24, 'ashlar', { r0: 29, twist: 0.6, pil: 12, belt: 2, win: { rows: 5, w: 4, h: 13, start: 12, end: 12, per: 1 } }],
    ['gallery', 37],
    ['shaft', 68, 18, 'ashlar', { r0: 22, twist: 0.4, win: { rows: 2, w: 3.6, h: 11, start: 10, end: 10, per: 1 } }],
    ['roof', 72, 9, { twist: 1.2, dormers: 4, crockets: 1 }],
    ['roof', 74, 0.6, { twist: 1.8, crockets: 1 }],
  ], { ramp: { y0: 164, y1: 296, turns: 2, phase: 2.2, dir: -1, width: 8 } }));

  towers.push(makeTower('nw', -190, -135, -70, 8, 35, [
    ['shaft', 190, 28, 'rubble', { pil: 8, belt: 2, win: { rows: 4, w: 4.5, h: 13, start: 36, end: 14, per: 1 } }],
    ['gallery', 41],
    ['shaft', 150, 20, 'ashlar', { r0: 24, twist: -0.5, pil: 8, belt: 2, win: { rows: 5, w: 4, h: 12, start: 12, end: 12, per: 1 } }],
    ['gallery', 31],
    ['shaft', 48, 15, 'ashlar', { r0: 17, twist: -0.3, win: { rows: 1, w: 3.4, h: 10, start: 12, end: 10, per: 1 } }],
    ['roof', 60, 8, { twist: -1, dormers: 3 }],
    ['roof', 70, 0.5, { twist: -1.6, crockets: 1 }],
  ], { ramp: { y0: 140, y1: 270, turns: 1.75, phase: 4.0, dir: 1, width: 7 } }));

  towers.push(makeTower('w', -240, 60, -70, 16, 46, [
    ['shaft', 220, 38, 'rubble', { pil: 8, belt: 3, sides: 16, win: { rows: 4, w: 5, h: 14, start: 40, end: 16, per: 1 } }],
    ['gallery', 53, { h: 15 }],
    ['shaft', 58, 30, 'ashlar', { r0: 34, win: { rows: 2, w: 4.2, h: 12, start: 10, end: 12, per: 1 }, belt: 1 }],
    ['roof', 84, 5, { dormers: 4, crockets: 1 }],
    ['roof', 40, 0.4, {}],
  ]));

  towers.push(makeTower('e', 240, 35, -70, 8, 33, [
    ['shaft', 240, 26, 'ashlar', { pil: 8, belt: 3, win: { rows: 5, w: 4.2, h: 15, start: 36, end: 14, per: 1 } }],
    ['gallery', 39],
    ['shaft', 70, 22, 'ashlar', { r0: 24, pil: 8, win: { rows: 1, w: 8, h: 24, start: 16, end: 12, per: 1 } }],
    ['roof', 80, 8, { twist: 0.9, dormers: 4, crockets: 1 }],
    ['roof', 74, 0.5, { twist: 1.4, crockets: 1 }],
  ]));

  towers.push(makeTower('se', 175, 195, -70, 12, 38, [
    ['shaft', 200, 30, 'rubble', { pil: 12, belt: 2, win: { rows: 3, w: 4.4, h: 13, start: 38, end: 14, per: 1 } }],
    ['gallery', 44],
    ['shaft', 58, 24, 'ashlar', { r0: 27, win: { rows: 2, w: 3.8, h: 11, start: 10, end: 10, per: 1 } }],
    ['roof', 66, 4, { dormers: 3, crockets: 1 }],
    ['roof', 38, 0.4, {}],
  ]));

  towers.push(makeTower('sw', -165, 205, -70, 12, 38, [
    ['shaft', 225, 30, 'rubble', { pil: 12, belt: 2, win: { rows: 3, w: 4.4, h: 13, start: 38, end: 14, per: 1 } }],
    ['gallery', 44],
    ['shaft', 70, 24, 'ashlar', { r0: 27, twist: 0.3, win: { rows: 2, w: 3.8, h: 11, start: 10, end: 10, per: 1 } }],
    ['roof', 70, 4, { twist: 0.8, dormers: 3, crockets: 1 }],
    ['roof', 44, 0.4, { twist: 1.0 }],
  ]));

  // ---- the gatehouse towers
  for (const sx of [-1, 1]) {
    towers.push(makeTower(sx < 0 ? 'g1' : 'g2', sx * 84, 270, -70, 12, 32, [
      ['shaft', 205, 26, 'ashlar', { pil: 12, belt: 3, win: { rows: 3, w: 4.6, h: 14, start: 40, end: 14, per: 1 } }],
      ['gallery', 37],
      ['shaft', 56, 20, 'ashlar', { r0: 22, win: { rows: 2, w: 3.8, h: 11, start: 10, end: 10, per: 1 } }],
      ['roof', 70, 3, { twist: sx * 0.7, dormers: 4, crockets: 1 }],
      ['roof', 40, 0.4, {}],
    ]));
  }

  // ---- the curtain wall and its smaller towers
  const V = { g2: [84, 270], se: [175, 195], e: [240, 35], ne: [170, -160], nw: [-190, -135], w: [-240, 60], sw: [-165, 205], g1: [-84, 270] };
  const wallRuns = [['g2', 'se'], ['se', 'e'], ['e', 'ne'], ['ne', 'nw'], ['nw', 'w'], ['w', 'sw'], ['sw', 'g1']];
  const WALL_H = 70, WALL_T = 17;
  const wallTower = (id, x, z) => towers.push(makeTower(id, x, z, -70, 8, 17, [
    ['shaft', 112, 14, 'rubble', { belt: 1, win: { rows: 2, w: 3, h: 9, start: 76, end: 8, per: 1 } }],
    ['gallery', 19, { h: 11 }],
    ['roof', 36, 0.5, { dormers: 0, crockets: 0 }],
  ]));
  // ports: pointed arches through the curtain wall (the postern and three sally ports), 40-44 m wide
  const PORTS = { 'ne-nw': ['postern', 66, 22, 22, 30], 'se-e': ['port-e', 60, 20, 20, 28], 'nw-w': ['port-nw', 60, 20, 20, 28], 'w-sw': ['port-w', 60, 20, 20, 28] };
  for (const [a, b] of wallRuns) {
    const [ax, az] = V[a], [bx, bz] = V[b];
    const len = Math.hypot(bx - ax, bz - az);
    const ux = (bx - ax) / len, uz = (bz - az) / len;
    const at = (s) => [ax + ux * s, az + uz * s];
    const port = PORTS[a + '-' + b];
    if (port) {
      const [pid, pw, pa, psp, pr] = port;
      const sp = len * 0.5;
      const [p0x, p0z] = at(sp - pw / 2), [p1x, p1z] = at(sp + pw / 2);
      walls.push({ x1: ax, z1: az, x2: p0x, z2: p0z, y0: -70, y1: WALL_H, t: WALL_T });
      walls.push({ x1: p1x, z1: p1z, x2: bx, z2: bz, y0: -70, y1: WALL_H, t: WALL_T });
      const [cx, cz] = at(sp);
      bays.push({ id: pid, x: cx, z: cz, yaw: Math.atan2(uz, ux), len: pw, thick: WALL_T + 8, y0: -70, y1: WALL_H + 24, open: { a: pa, spring: psp, rise: pr, type: 'pointed', floor: 0 }, mould: 3, parapet: true, gable: true });
      const ts = a === 'ne' ? [sp - 64, sp + 64, len * 0.18, len * 0.82] : [len * 0.2, len * 0.8];
      for (const t of ts) {
        const [tx, tz] = at(t);
        wallTower('wt-' + a + b + Math.round(t), tx, tz);
      }
    } else {
      walls.push({ x1: ax, z1: az, x2: bx, z2: bz, y0: -70, y1: WALL_H, t: WALL_T });
      if (len > 140) wallTower('wt-' + a + b, (ax + bx) / 2, (az + bz) / 2);
    }
  }

  // ---- the gate: a 56 m wide, 76 m high pointed tunnel, 70 m long, between the two gate towers
  bays.push({ id: 'gate', x: 0, z: 270, yaw: 0, len: 104, thick: 70, y0: -70, y1: 124, open: { a: 28, spring: 34, rise: 42, type: 'pointed', floor: 0 }, mould: 4, parapet: true, gable: true, portcullis: true });

  // the triumphal arch: a free-standing arch wall behind the gate, in line with the tunnel and the courtyard shrine
  bays.push({ id: 'tri', x: 0, z: 205, yaw: 0, len: 118, thick: 26, y0: -70, y1: 126, open: { a: 36, spring: 44, rise: 56, type: 'pointed', floor: 0 }, mould: 4, parapet: true, gable: true });

  // ---- viaducts: stacks of arch walls (bays) that tie the keep to the great towers
  const viaduct = (id, ax, az, bx, bz, tiers, thick, ends) => {
    const len = Math.hypot(bx - ax, bz - az);
    const ux = (bx - ax) / len, uz = (bz - az) / len;
    const s0 = ends[0], s1 = len - ends[1];
    const span = s1 - s0;
    const nb = Math.max(1, Math.round(span / 72));
    const bw = span / nb;
    for (let t = 0; t < tiers.length; t++) {
      const [yb, yt, ap, rise, type] = tiers[t];
      for (let i = 0; i < nb; i++) {
        const s = s0 + bw * (i + 0.5);
        const pier = Math.min(12, bw * 0.16);
        bays.push({
          id: `${id}-${t}-${i}`, x: ax + ux * s, z: az + uz * s, yaw: Math.atan2(uz, ux) + Math.PI / 2 * 0, len: bw, thick,
          y0: yb, y1: yt, open: { a: Math.min(ap, bw / 2 - pier / 2), spring: 0, rise, type: type || 'pointed', floor: yb }, mould: t === tiers.length - 1 ? 1 : 2,
          parapet: t === tiers.length - 1, deck: t === tiers.length - 1, tier: t,
        });
      }
    }
  };
  // A: keep to the north-east spire, two tiers under a high deck
  viaduct('va', 0, -20, 170, -160, [[0, 118, 31, 88, 'pointed'], [118, 206, 30, 56, 'pointed']], 15, [84, 31]);
  // B: keep to the north-west spire, one tall tier
  viaduct('vb', 0, -20, -190, -135, [[0, 128, 30, 100, 'pointed']], 15, [90, 28]);
  // C: keep to the east bell tower, two tiers
  viaduct('vc', 0, -20, 240, 35, [[0, 120, 33, 90, 'pointed'], [120, 214, 30, 62, 'pointed']], 15, [86, 25]);
  // F: keep to the south-west tower, one tier
  viaduct('vf', 0, -20, -165, 205, [[0, 112, 32, 92, 'pointed']], 15, [90, 31]);
  // D and H: the sky bridges, single long segmental arches high between spires
  const skyBridge = (id, ax, az, bx, bz, yb, yt, ends, thick, rise) => {
    const len = Math.hypot(bx - ax, bz - az);
    const ux = (bx - ax) / len, uz = (bz - az) / len;
    const s0 = ends[0], s1 = len - ends[1];
    bays.push({ id, x: ax + ux * (s0 + s1) / 2, z: az + uz * (s0 + s1) / 2, yaw: Math.atan2(uz, ux), len: s1 - s0, thick, y0: yb, y1: yt, open: { a: (s1 - s0) / 2 - 6, spring: 0, rise, type: 'seg', floor: yb }, mould: 2, parapet: true, deck: true, sky: true });
  };
  skyBridge('vd', 170, -160, 240, 35, 238, 304, [25, 28], 13, 40);
  skyBridge('vh', -190, -135, -240, 60, 196, 252, [20, 40], 12, 34);

  // ---- flying buttresses around the keep: each rises from a pier to the second tier; every other pier is a tall
  // twisting satellite spire, so the keep stands in a cluster of five
  const SAT = { 1: 262, 3: 232, 5: 300, 7: 246 }; // shaft heights of the satellites
  for (let k = 0; k < 8; k++) {
    const a = (k + 0.5) * (TAU / 8);
    const c = Math.cos(a), s2 = Math.sin(a);
    const rTop = 60, yTop = 262, rPier = 118, yPier = 100;
    buttresses.push({
      id: 'fb' + k,
      a: [c * rTop, yTop, -20 + s2 * rTop],
      b: [c * rPier, yPier, -20 + s2 * rPier],
      w: 8, t: 9, bow: 42,
    });
    if (SAT[k]) {
      const h1 = SAT[k];
      towers.push(makeTower('sat' + k, c * rPier, -20 + s2 * rPier, -70, 8, 30, [
        ['shaft', h1, 25, 'ashlar', { pil: 8, belt: 3, win: { rows: 5, w: 4.5, h: 14, start: 40, end: 14, per: 1 } }],
        ['gallery', 37],
        ['shaft', 96, 18, 'ashlar', { r0: 21, twist: 0.7, pil: 8, belt: 1, win: { rows: 2, w: 3.8, h: 12, start: 12, end: 10, per: 1 } }],
        ['roof', 80, 9, { twist: 1.4, dormers: 4, crockets: 1 }],
        ['roof', 90, 0.5, { twist: 2.0, crockets: 1 }],
      ]));
    } else {
      towers.push(makeTower('pier' + k, c * rPier, -20 + s2 * rPier, -70, 4, 12, [
        ['shaft', 205, 8, 'ashlar', { belt: 1, sides: 4 }],
        ['roof', 46, 0.5, { crockets: 1, rib: false }],
      ], { yaw: a + Math.PI / 4 }));
    }
  }

  // ---- the outer bailey: a lower curtain wall on the terrace under the cliff, with a barbican on the gate's axis
  const OR = 440, OY0 = -85, OY1 = 18;
  const ov = [];
  for (let k = 0; k < 16; k++) {
    const a = (k + 0.5) * (TAU / 16);
    ov.push([Math.cos(a) * OR, Math.sin(a) * OR]);
  }
  for (let k = 0; k < 16; k++) {
    const [ax, az] = ov[k], [bx, bz] = ov[(k + 1) % 16];
    if (k === 3) continue; // the barbican stands between the two southern towers
    walls.push({ x1: ax, z1: az, x2: bx, z2: bz, y0: OY0, y1: OY1, t: 15 });
  }
  for (let k = 0; k < 16; k++) {
    const [x, z] = ov[k];
    if (k === 3 || k === 4) {
      towers.push(makeTower(k === 3 ? 'bg2' : 'bg1', x, z, OY0, 12, 27, [
        ['shaft', 190, 22, 'ashlar', { pil: 12, belt: 3, win: { rows: 3, w: 4.4, h: 13, start: 40, end: 14, per: 1 } }],
        ['gallery', 33],
        ['shaft', 50, 17, 'ashlar', { r0: 19, win: { rows: 1, w: 3.6, h: 11, start: 10, end: 10, per: 1 } }],
        ['roof', 64, 3, { twist: k === 3 ? 0.9 : -0.9, dormers: 3, crockets: 1 }],
        ['roof', 36, 0.4, {}],
      ]));
    } else {
      towers.push(makeTower('wt-o' + k, x, z, OY0, 8, 17, [
        ['shaft', 150, 14, 'rubble', { belt: 2, win: { rows: 2, w: 3, h: 9, start: 100, end: 10, per: 1 } }],
        ['gallery', 20, { h: 12 }],
        ['roof', 44, 0.5, { dormers: 0, crockets: 0 }],
      ]));
    }
  }
  bays.push({ id: 'obarb', x: 0, z: 432, yaw: 0, len: 112, thick: 44, y0: OY0, y1: 28, open: { a: 26, spring: 30, rise: 34, type: 'pointed', floor: -55 }, mould: 3, parapet: true, gable: true, portcullis: true, paved: true });

  // ---- chains between the spires
  const topPt = (id, y, off = 0) => {
    const t = towers.find((q) => q.id === id);
    return [t.x, y, t.z, off];
  };
  chains.push({ a: [170, 408, -160], b: [-190, 372, -135], sag: 70, link: 3.4 });
  chains.push({ a: [170, 366, -160], b: [36, 520, -30], sag: 50, link: 3.2 });
  chains.push({ a: [-190, 330, -135], b: [-36, 560, -30], sag: 56, link: 3.2 });
  chains.push({ a: [240, 330, 35], b: [170, 440, -160], sag: 36, link: 3.0 });
  chains.push({ a: [-240, 280, 60], b: [-190, 392, -135], sag: 26, link: 2.8 });
  chains.push({ a: [175, 262, 195], b: [240, 300, 35], sag: 28, link: 2.8 });
  chains.push({ a: [0, 118, 268], b: [-84, 224, 270], sag: 12, link: 2.6 });

  // ---- banners (hung from galleries, facing outward) and braziers
  const bannerAt = (id, y, ang, w, h, mat = 0) => banners.push({ tower: id, y, ang, w, h, mat });
  for (let k = 0; k < 4; k++) bannerAt('keep', 144, (k + 0.5) * (TAU / 4), 14, 70, k % 2);
  for (let k = 0; k < 3; k++) bannerAt('keep', 292, k * (TAU / 3) + 0.4, 10, 54, 1);
  bannerAt('g1', 138, Math.PI / 2, 9, 54, 0);
  bannerAt('g2', 138, Math.PI / 2, 9, 54, 0);
  bannerAt('g1', 138, -Math.PI / 2 + 0.3, 7, 40, 1);
  bannerAt('g2', 138, -Math.PI / 2 - 0.3, 7, 40, 1);
  bannerAt('e', 168, 0, 8, 52, 0);
  bannerAt('e', 168, Math.PI, 8, 52, 0);
  bannerAt('ne', 146, Math.PI / 3, 8, 48, 1);
  bannerAt('ne', 148, Math.PI * 1.1, 8, 48, 1);
  bannerAt('w', 150, Math.PI, 10, 56, 0);
  bannerAt('nw', 120, -Math.PI / 2, 8, 46, 1);
  bannerAt('se', 130, 0.4, 8, 40, 0);
  bannerAt('sw', 130, Math.PI - 0.4, 8, 40, 0);

  const brazierAt = (id, y, ang, rOff = 0) => braziers.push({ tower: id, y, ang, rOff });
  for (let k = 0; k < 4; k++) brazierAt('keep', 153, k * (TAU / 4), 0);
  for (let k = 0; k < 4; k++) brazierAt('keep', 300, k * (TAU / 4) + 0.7, 0);
  for (const id of ['g1', 'g2']) for (let k = 0; k < 3; k++) brazierAt(id, 153, k * (TAU / 3) + 0.5, 0);
  for (const id of ['ne', 'nw', 'e', 'se', 'sw', 'w']) {
    const t = towers.find((q) => q.id === id);
    const g = t.segs.find((s) => s.k === 'gallery');
    for (let k = 0; k < 2; k++) brazierAt(id, g.y1 + 0.2, k * Math.PI + 0.3, 0);
  }

  // rock needles standing on the massif's flanks, leaving the gate's approach (south) clear
  const needles = [];
  for (let i = 0; i < 12; i++) {
    const a = ((i + 0.5) / 12) * TAU + 0.3 * Math.sin(i * 2.7);
    const toSouth = Math.atan2(Math.sin(a - Math.PI / 2), Math.cos(a - Math.PI / 2));
    if (Math.abs(toSouth) < 0.4) continue;
    const d = 512 + 22 * Math.sin(i * 5.1 + 1.3);
    needles.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, r: 16 + 9 * (0.5 + 0.5 * Math.sin(i * 3.3)), top: 70 + 90 * (0.5 + 0.5 * Math.sin(i * 1.9 + 0.5)), seed: 1000 + i * 37 });
  }

  // the ceremonial avenue from the triumphal arch to the keep's stair: stone pedestals with great fire bowls
  const avenue = [];
  for (const z of [92, 122, 152, 182]) for (const x of [-30, 30]) avenue.push([x, z]);

  const shrines = [
    [0, 44, 142], // the courtyard, in line with the gate tunnel
    [205, 338, -62], // above the high sky bridge between the spires
  ];

  SPEC = { towers, walls, bays, buttresses, chains, banners, braziers, avenue, needles, shrines, WALL_H, WALL_T };
  return SPEC;
}

// radius of a tower's envelope (circumscribed radius) at height y (local), 0 above its top
export function towerRadiusAt(t, y) {
  for (const s of t.segs) {
    if (y < s.y0 - 1e-6 || y > s.y1 + 1e-6) continue;
    if (s.k === 'gallery') {
      const f = (y - s.y0) / (s.y1 - s.y0);
      return f < 0.5 ? lerp(s.r0, s.r1, f * 2) : s.r1;
    }
    return lerp(s.r0, s.r1, (y - s.y0) / (s.y1 - s.y0));
  }
  return 0;
}

// ------------------------------------------------------------------------------------------------ colliders
// All colliders live in world coordinates. kinds: 0 tapered cylinder, 1 box (optionally with an arch hole),
// 2 beam, 3 spiral ramp.
let COL = null;

function addBounds(c, x0, x1, y0, y1, z0, z1) {
  c.bx0 = x0; c.bx1 = x1; c.by0 = y0; c.by1 = y1; c.bz0 = z0; c.bz1 = z1;
  return c;
}

function compile() {
  if (COL) return COL;
  const S = castleSpec();
  const Y0 = CASTLE.y0;
  const list = [];
  const cyl = (id, x, z, y0, y1, r0, r1) => {
    const rm = Math.max(r0, r1);
    list.push(addBounds({ k: 0, id, x, z, y0, y1, r0, r1 }, x - rm, x + rm, y0, y1, z - rm, z + rm));
  };
  const box = (c, hw) => {
    // oriented box: u along yaw, w across; bounds from the rotated corners
    const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
    const ex = Math.abs(cs) * c.hu + Math.abs(sn) * c.hw, ez = Math.abs(sn) * c.hu + Math.abs(cs) * c.hw;
    c.cs = cs; c.sn = sn;
    list.push(addBounds(c, c.x - ex, c.x + ex, c.y0, c.y1, c.z - ez, c.z + ez));
  };
  const beam = (id, a, b, hw, hh) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const L2 = dx * dx + dy * dy + dz * dz;
    const L = Math.sqrt(L2);
    const hl = Math.hypot(dx, dz) || 1;
    const sx = -dz / hl, sz = dx / hl; // horizontal, perpendicular to the beam
    const c = { k: 2, id, ax: a[0], ay: a[1], az: a[2], dx, dy, dz, L, L2, sx, sz, hw, hh };
    // vertical axis perpendicular to the beam: cross(side, dir), side = (sx, 0, sz)
    const ux = dx / L, uy = dy / L, uz = dz / L;
    c.vx = -sz * uy; c.vy = sz * ux - sx * uz; c.vz = sx * uy;
    const m = Math.max(hw, hh);
    list.push(addBounds(c, Math.min(a[0], b[0]) - m, Math.max(a[0], b[0]) + m, Math.min(a[1], b[1]) - m, Math.max(a[1], b[1]) + m, Math.min(a[2], b[2]) - m, Math.max(a[2], b[2]) + m));
  };

  for (const t of S.towers) {
    const x = CASTLE.x + t.x, z = CASTLE.z + t.z;
    for (const s of t.segs) {
      // polygon shafts: use the mean of inscribed and circumscribed radius
      const f = s.k === 'roof' ? 0.97 : Math.cos(Math.PI / (s.sides || 8)) * 0.5 + 0.5;
      if (s.k === 'gallery') {
        const ym = s.y0 + (s.y1 - s.y0) * 0.5;
        cyl(t.id, x, z, Y0 + s.y0, Y0 + ym, s.r0 * f, s.r1 * f);
        cyl(t.id, x, z, Y0 + ym, Y0 + s.y1 + 4, s.r1 * f, s.r1 * f);
      } else {
        cyl(t.id, x, z, Y0 + s.y0, Y0 + s.y1, s.r0 * f, s.r1 * f);
      }
      if (s.step) cyl(t.id, x, z, Y0 + s.y0 - 3, Y0 + s.y0 + 1, s.step * f, s.step * f);
    }
    if (t.ramp) {
      const r = t.ramp;
      const c = { k: 3, id: t.id + '-ramp', x, z, y0: Y0 + r.y0, y1: Y0 + r.y1, turns: r.turns, phase: r.phase, dir: r.dir, width: r.width, tower: t };
      const rmax = towerRadiusAt(t, r.y0) + r.width + 2;
      list.push(addBounds(c, x - rmax, x + rmax, c.y0 - 6, c.y1 + 6, z - rmax, z + rmax));
    }
  }
  for (const w of S.walls) {
    const x1 = CASTLE.x + w.x1, z1 = CASTLE.z + w.z1, x2 = CASTLE.x + w.x2, z2 = CASTLE.z + w.z2;
    const len = Math.hypot(x2 - x1, z2 - z1);
    const c = { k: 1, id: 'wall', x: (x1 + x2) / 2, z: (z1 + z2) / 2, yaw: Math.atan2(z2 - z1, x2 - x1), hu: len / 2, hw: w.t / 2, y0: Y0 + w.y0, y1: Y0 + w.y1 + 6, open: null };
    box(c);
  }
  for (const b of S.bays) {
    const c = { k: 1, id: b.id, x: CASTLE.x + b.x, z: CASTLE.z + b.z, yaw: b.yaw, hu: b.len / 2, hw: b.thick / 2, y0: Y0 + b.y0, y1: Y0 + b.y1 + (b.parapet ? 6 : 0), open: null };
    if (b.open) c.open = { a: b.open.a, rise: b.open.rise, spring: b.open.spring, type: b.open.type, floor: Y0 + b.open.floor };
    // the apex of the hole in world height
    if (c.open) c.open.apex = c.open.floor + c.open.spring + c.open.rise;
    box(c);
  }
  for (const nd of S.needles) cyl('needle', CASTLE.x + nd.x, CASTLE.z + nd.z, Y0 - 150, Y0 + nd.top, nd.r * 0.95, nd.r * 0.4);
  for (const [ax, az] of S.avenue) cyl('pedestal', CASTLE.x + ax, CASTLE.z + az, Y0, Y0 + 12.5, 3.3, 3.3);
  for (const f of S.buttresses) {
    const n = 7;
    const pts = buttressPath(f, n);
    for (let i = 0; i < n; i++) {
      const a = [CASTLE.x + pts[i][0], Y0 + pts[i][1], CASTLE.z + pts[i][2]];
      const b = [CASTLE.x + pts[i + 1][0], Y0 + pts[i + 1][1], CASTLE.z + pts[i + 1][2]];
      beam(f.id, a, b, f.w * 0.5 + 0.5, f.t * 0.5 + 0.5);
    }
  }

  // broad-phase grid
  const CELL = 48;
  const gx0 = CASTLE.x - CASTLE.radius - 60, gz0 = CASTLE.z - CASTLE.radius - 60;
  const gn = Math.ceil((CASTLE.radius * 2 + 120) / CELL);
  const cells = Array.from({ length: gn * gn }, () => []);
  list.forEach((c, i) => {
    const i0 = Math.max(0, Math.floor((c.bx0 - gx0) / CELL)), i1 = Math.min(gn - 1, Math.floor((c.bx1 - gx0) / CELL));
    const j0 = Math.max(0, Math.floor((c.bz0 - gz0) / CELL)), j1 = Math.min(gn - 1, Math.floor((c.bz1 - gz0) / CELL));
    for (let j = j0; j <= j1; j++) for (let k = i0; k <= i1; k++) cells[j * gn + k].push(i);
  });
  COL = { list, cells, gx0, gz0, gn, CELL, stamp: new Int32Array(list.length), tick: 0, topY: Y0 + CASTLE.top, botY: Y0 - 80 };
  return COL;
}

// the centre line of a flying buttress: a bowed arc from the pier (b) up to the tower (a)
export function buttressPath(f, n) {
  const pts = [];
  // plan: straight line; elevation: a quarter-ish arc that bows upward, concave toward the sky
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = lerp(f.b[0], f.a[0], t), z = lerp(f.b[2], f.a[2], t);
    // starts steep at the pier top, flattens, then meets the tower almost level: y = lerp + bow * sin-shaped lift
    const y = lerp(f.b[1], f.a[1], Math.pow(t, 0.62)) + f.bow * 0.35 * Math.sin(t * Math.PI) * (1 - t);
    pts.push([x, y, z]);
  }
  return pts;
}

function boxHit(c, px, py, pz, pad) {
  if (py < c.y0 - pad || py > c.y1 + pad) return false;
  const dx = px - c.x, dz = pz - c.z;
  const u = dx * c.cs + dz * c.sn, w = -dx * c.sn + dz * c.cs;
  const au = Math.abs(u), aw = Math.abs(w);
  if (au > c.hu + pad || aw > c.hw + pad) return false;
  const o = c.open;
  if (o) {
    // inside the opening (shrunk by the pad)? then it is air
    const v = py - (o.floor + o.spring);
    if (py < o.apex - pad) {
      if (v <= 0) {
        if (au < o.a - pad) return false;
      } else {
        const hw = archHalfWidth(o.a, o.rise, o.type, v);
        if (hw > 0 && au < hw - pad) return false;
      }
    }
  }
  return true;
}

function beamHit(c, px, py, pz, pad) {
  const ax = px - c.ax, ay = py - c.ay, az = pz - c.az;
  let t = (ax * c.dx + ay * c.dy + az * c.dz) / c.L2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax - c.dx * t, ey = ay - c.dy * t, ez = az - c.dz * t;
  const lat = ex * c.sx + ez * c.sz;
  if (lat > c.hw + pad || lat < -c.hw - pad) return false;
  const vert = ex * c.vx + ey * c.vy + ez * c.vz;
  return vert <= c.hh + pad && vert >= -c.hh - pad;
}

function rampHit(c, px, py, pz, pad) {
  if (py < c.y0 - 4 - pad || py > c.y1 + 6 + pad) return false;
  const dx = px - c.x, dz = pz - c.z;
  const r = Math.sqrt(dx * dx + dz * dz);
  const rin = towerRadiusAt(c.tower, Math.min(Math.max(py - CASTLE.y0, c.y0 - CASTLE.y0), c.y1 - CASTLE.y0)) * 0.95;
  if (r < rin - pad || r > rin + c.width + pad) return false;
  const pitch = (c.y1 - c.y0) / c.turns;
  let s = (Math.atan2(dz, dx) - c.phase) * c.dir;
  s = ((s % TAU) + TAU) % TAU / TAU;
  let j = Math.round((py - c.y0) / pitch - s);
  const jmax = Math.ceil(c.turns) - 1;
  j = j < 0 ? 0 : j > jmax ? jmax : j;
  const yr = c.y0 + pitch * (s + j);
  if (yr > c.y1 + 1) return false;
  const top = r > rin + c.width - 2.5 ? 5.5 : 1.5;
  return py >= yr - 4.5 - pad && py <= yr + top + pad;
}

// Is the point (padded by `pad` metres) inside any solid part of the castle? Returns the collider or null.
export function hit(p, pad = 0) {
  const px = p[0], py = p[1], pz = p[2];
  const dx = px - CASTLE.x, dz = pz - CASTLE.z;
  const R = CASTLE.radius + pad;
  if (dx * dx + dz * dz > R * R) return null;
  const C = COL || compile();
  if (py > C.topY + pad || py < C.botY - pad) return null;
  const { cells, gx0, gz0, gn, CELL, list, stamp } = C;
  const i0 = Math.max(0, Math.floor((px - pad - gx0) / CELL)), i1 = Math.min(gn - 1, Math.floor((px + pad - gx0) / CELL));
  const j0 = Math.max(0, Math.floor((pz - pad - gz0) / CELL)), j1 = Math.min(gn - 1, Math.floor((pz + pad - gz0) / CELL));
  const tk = ++C.tick;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const cell = cells[j * gn + i];
      for (let n = 0; n < cell.length; n++) {
        const idx = cell[n];
        if (stamp[idx] === tk) continue;
        stamp[idx] = tk;
        const c = list[idx];
        if (px < c.bx0 - pad || px > c.bx1 + pad || pz < c.bz0 - pad || pz > c.bz1 + pad || py < c.by0 - pad || py > c.by1 + pad) continue;
        switch (c.k) {
          case 0: {
            if (py < c.y0 - pad || py > c.y1 + pad) break;
            const t = c.y1 > c.y0 ? clamp01((py - c.y0) / (c.y1 - c.y0)) : 0;
            const rr = lerp(c.r0, c.r1, t) + pad;
            const ex = px - c.x, ez = pz - c.z;
            if (ex * ex + ez * ez < rr * rr) return c;
            break;
          }
          case 1:
            if (boxHit(c, px, py, pz, pad)) return c;
            break;
          case 2:
            if (beamHit(c, px, py, pz, pad)) return c;
            break;
          case 3:
            if (rampHit(c, px, py, pz, pad)) return c;
            break;
        }
      }
    }
  }
  return null;
}

// World height of the highest solid thing above (x, z) (the massif's own terrain is not counted), or -Infinity.
// Used to let the castle shade the ground: the terrain worker folds it into its sun-shadow ray march.
export function topAt(x, z, pad = 4) {
  const dx = x - CASTLE.x, dz = z - CASTLE.z;
  if (dx * dx + dz * dz > (CASTLE.radius + pad) ** 2) return -Infinity;
  const p = [x, 0, z];
  for (let y = CASTLE.y0 + CASTLE.top; y > CASTLE.y0 - 20; y -= 5) {
    p[1] = y;
    if (hit(p, pad)) return y;
  }
  return -Infinity;
}

// within `r` metres (horizontally) of the castle's centre line, any height below its top
export function near(x, z, r) {
  const dx = x - CASTLE.x, dz = z - CASTLE.z;
  return dx * dx + dz * dz < r * r;
}

// the highest solid point above (x, z), for shadow baking: samples the colliders' bounding data cheaply
export function colliders() {
  return (COL || compile()).list;
}

// ------------------------------------------------------------------------------------------------ routes through the castle
// Openings a dragon can thread: the gate, the postern and the viaduct arches. Each has a centre (world), the unit
// direction of the passage (horizontal), half width and half height of the usable opening, and its length.
let GATES = null;
export function gates() {
  if (GATES) return GATES;
  const S = castleSpec();
  GATES = [];
  for (const b of S.bays) {
    if (!b.open) continue;
    const o = b.open;
    const cs = Math.cos(b.yaw), sn = Math.sin(b.yaw);
    // the passage runs across the bay (perpendicular to u)
    const dir = [-sn, cs];
    const hh = (o.spring + o.rise) * 0.5;
    if (o.rise < 20 || o.a < 18 || o.type === 'seg') continue; // too narrow, or just open air under a bridge
    const g = {
      id: b.id,
      // the best line is low: a pointed arch is widest near its springing
      p: [CASTLE.x + b.x, CASTLE.y0 + o.floor + o.spring + o.rise * 0.3, CASTLE.z + b.z],
      dir,
      hw: o.a,
      hh: hh,
      len: b.thick,
      tier: b.tier || 0,
      big: o.a >= 26 && hh >= 36, // the sally ports are for flying through by hand; bots only commit to the big arches
    };
    // how far the axis stays clear on each side of the opening (up to 420 m); a route needs 95 m either side to count
    // at all, and a pursued bot only commits to a side with room to line up (pickGate)
    g.clear = [0, 0];
    for (let side = 0; side < 2; side++) {
      const sg = side ? 1 : -1;
      let t = g.len / 2;
      for (; t < g.len / 2 + 420; t += 10) {
        if (hit([g.p[0] + g.dir[0] * sg * t, g.p[1], g.p[2] + g.dir[1] * sg * t], 12)) break;
      }
      g.clear[side] = t - g.len / 2;
    }
    let inner = true;
    for (let t = -g.len / 2; t <= g.len / 2 && inner; t += 6) if (hit([g.p[0] + g.dir[0] * t, g.p[1], g.p[2] + g.dir[1] * t], 10)) inner = false;
    if (inner && g.clear[0] >= 95 && g.clear[1] >= 95) GATES.push(g);
  }
  return GATES;
}

// Pick a passage a pursued dragon at p flying along vel can reach: well ahead, roughly aligned with the way it is
// going. Returns { gate, sign } or null. `salt` (0..1) varies the choice between bots.
export function pickGate(p, vel, salt = 0) {
  const sp = Math.hypot(vel[0], vel[1], vel[2]) || 1;
  const dxc = p[0] - CASTLE.x, dzc = p[2] - CASTLE.z;
  if (dxc * dxc + dzc * dzc > (CASTLE.radius + 1000) ** 2) return null;
  let best = null, bestScore = -1;
  for (const g of gates()) {
    if (!g.big) continue;
    const tx = g.p[0] - p[0], ty = g.p[1] - p[1], tz = g.p[2] - p[2];
    const dh = Math.hypot(tx, tz) || 1;
    const d = Math.hypot(dh, ty);
    if (d < 170 || d > 950) continue;
    const along = (tx * vel[0] + ty * vel[1] + tz * vel[2]) / (d * sp); // is it where we are heading?
    if (along < 0.5) continue;
    const proj = tx * g.dir[0] + tz * g.dir[1];
    const sign = proj > 0 ? 1 : -1; // we enter from the side we are on
    const axial = Math.abs(proj) / dh; // 1 = lined up with the passage
    if (axial < 0.55) continue;
    // the approach side must be clear far enough to line up (the bot comes from -sign * dir)
    if (g.clear[sign > 0 ? 0 : 1] < Math.min(380, d * 0.7 + 60)) continue;
    if (Math.abs(ty) > dh * 0.42 + 60) continue; // too steep a dive or climb
    // a straight look at the near mouth of the passage (no stone in between at a pad that matters)
    const ex = g.p[0] - g.dir[0] * sign * (g.len / 2 + 25), ey = g.p[1], ez = g.p[2] - g.dir[1] * sign * (g.len / 2 + 25);
    const steps = Math.ceil(Math.hypot(ex - p[0], ey - p[1], ez - p[2]) / 28);
    let seen = true;
    for (let k = 1; k < steps && seen; k++) {
      const f = k / steps;
      _q[0] = p[0] + (ex - p[0]) * f; _q[1] = p[1] + (ey - p[1]) * f; _q[2] = p[2] + (ez - p[2]) * f;
      if (hit(_q, 12)) seen = false;
    }
    if (!seen) continue;
    const score = along * 0.6 + axial * 0.6 + (g.hw / 40) * 0.2 + salt * 0.2 - d / 3000;
    if (score > bestScore) { bestScore = score; best = { gate: g, sign }; }
  }
  return best;
}

// Direction to steer for a run through gate g from the `sign` side: pure pursuit on the passage's axis.
// how far off the opening's line the dragon is: [lateral, vertical] metres
export function gateOffset(g, p, out) {
  out[0] = (p[0] - g.p[0]) * -g.dir[1] + (p[2] - g.p[2]) * g.dir[0];
  out[1] = p[1] - g.p[1];
  return out;
}

export function gateAim(g, sign, p, out) {
  const tdx = g.dir[0] * sign, tdz = g.dir[1] * sign; // travel direction
  const togo = (g.p[0] - p[0]) * tdx + (g.p[2] - p[2]) * tdz; // distance to the opening's centre along the axis
  const lead = Math.max(90, Math.min(260, Math.abs(togo) * 0.5 + 70));
  out[0] = g.p[0] + tdx * (lead - togo) - p[0];
  out[1] = g.p[1] - p[1];
  out[2] = g.p[2] + tdz * (lead - togo) - p[2];
  const l = Math.hypot(out[0], out[1], out[2]) || 1;
  out[0] /= l; out[1] /= l; out[2] /= l;
  return togo;
}

// ------------------------------------------------------------------------------------------------ bot steering
// Probe the flight path every 28 m out to 3.3 s ahead (spires are thinner than a probe spacing at speed, so the
// samples must be dense); if it is blocked, pick the direction closest to what the bot wants that stays clear.
// Writes the direction into `out` and returns urgency 0..1 (0 = nothing in the way).
const YAWS = [0, 0.26, -0.26, 0.52, -0.52, 0.8, -0.8, 1.1, -1.1, 1.5, -1.5, 2.1, -2.1];
const PITCHES = [0, 0.3, -0.3, 0.6, -0.55, 0.9];
const _q = [0, 0, 0], _d = [0, 0, 0], _best = [0, 0, 0];

// distance along d to the first solid sample, or -1
function blockedAt(p, d, reach, pad) {
  for (let t = 28; t <= reach; t += 28) {
    _q[0] = p[0] + d[0] * t; _q[1] = p[1] + d[1] * t; _q[2] = p[2] + d[2] * t;
    if (hit(_q, pad)) return t;
  }
  return -1;
}

// `memo` ({ dir: [x,y,z], until }) is the bot's own scrap of memory: once it has picked a way round it sticks to it
// for a moment, otherwise it dithers left and right in front of a spire until too late.
export function avoid(p, vel, desired, out, pad = 16, memo = null, now = 0) {
  const sp = Math.max(70, Math.hypot(vel[0], vel[1], vel[2]));
  const reach = Math.min(520, sp * 4.2);
  const dxc = p[0] - CASTLE.x, dzc = p[2] - CASTLE.z;
  const R = CASTLE.radius + reach + pad;
  if (dxc * dxc + dzc * dzc > R * R) return 0;
  const hl = Math.hypot(vel[0], vel[1], vel[2]) || 1;
  const h0 = [vel[0] / hl, vel[1] / hl, vel[2] / hl];
  let hb = blockedAt(p, h0, reach, pad);
  // also look the way the bot wants to go: otherwise it turns back toward the stone as soon as its heading clears
  const db = blockedAt(p, desired, reach, pad);
  if (hb < 0 && db < 0) {
    if (memo) memo.until = 0;
    return 0;
  }
  if (hb < 0) hb = db;
  const urgency = Math.min(1, 1.2 - (hb / sp) * 0.34);
  // keep the way round it chose a moment ago while that is still clear
  if (memo && memo.until > now && blockedAt(p, memo.dir, reach, pad + 4) < 0) {
    out[0] = memo.dir[0]; out[1] = memo.dir[1]; out[2] = memo.dir[2];
    return urgency;
  }
  const psi = Math.atan2(h0[2], h0[0]);
  const phi = Math.asin(Math.max(-1, Math.min(1, h0[1])));
  let bestCost = Infinity, bestT = hb, found = false;
  const cpad = pad + 8; // a margin, so the way round is not a graze
  for (let pi = 0; pi < PITCHES.length; pi++) {
    const ph = Math.max(-1.1, Math.min(1.1, phi + PITCHES[pi]));
    const cp = Math.cos(ph), sp2 = Math.sin(ph);
    for (let yi = 0; yi < YAWS.length; yi++) {
      const ps = psi + YAWS[yi];
      _d[0] = cp * Math.cos(ps); _d[1] = sp2; _d[2] = cp * Math.sin(ps);
      // cost: how far from what the bot wants, plus a little for turning away from its heading
      const cost = 1 - (_d[0] * desired[0] + _d[1] * desired[1] + _d[2] * desired[2]) + 0.18 * (1 - (_d[0] * h0[0] + _d[1] * h0[1] + _d[2] * h0[2])) + (pi ? 0.04 : 0);
      if (found && cost >= bestCost) continue;
      const t = blockedAt(p, _d, reach, cpad);
      if (t < 0) {
        if (cost < bestCost) { bestCost = cost; _best[0] = _d[0]; _best[1] = _d[1]; _best[2] = _d[2]; found = true; }
      } else if (!found && t > bestT) { bestT = t; _best[0] = _d[0]; _best[1] = _d[1]; _best[2] = _d[2]; }
    }
  }
  if (!found && bestT === hb) {
    // boxed in: pull straight up and away from the centre
    const l = Math.hypot(dxc, dzc) || 1;
    _best[0] = (dxc / l) * 0.5; _best[1] = 0.85; _best[2] = (dzc / l) * 0.5;
  }
  out[0] = _best[0]; out[1] = _best[1]; out[2] = _best[2];
  if (memo) {
    memo.dir = memo.dir || [0, 0, 0];
    memo.dir[0] = _best[0]; memo.dir[1] = _best[1]; memo.dir[2] = _best[2];
    memo.until = found ? now + 900 : 0;
  }
  return urgency;
}
