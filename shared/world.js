// The map: a compact, dense battle island. Everything is a pure function of WORLD.seed so the client (rendering),
// the terrain worker (meshing) and the server (bots, crash checks) agree exactly.
//
//   r < 600 m      CASTLE PLATEAU. A flat rocky massif (castleSite) for the castle; its jagged skirt falls to the moat
//   ~930-1150 m    THE MOAT: a ring canyon (~250 m wide, floor ~60 m) circling the plateau, a race track under cliffs
//   1150-1900 m    THE RING: jagged mountains up to ~1 km, cut by six radial passes. Three passes end in sea inlets
//                  (fjords) with a waterfall pouring over the head wall; the other three run down to beaches
//   1900-2300 m    coast, sea stacks, a sea arch; satellite islands out to ~3 km are backdrop scenery
//   sky            a dozen floating islands between 980 m out and the edge of the battle area (WORLD.radius, 1650 m),
//                  a rock ring on two of them, and stone gates grown across the dry passes
//   The battle area ends inside the ring (WORLD.radius): the outer ring, the coast and the satellites are its frame.
//
// Sections are kept apart on purpose: terrain, landmarks, solids (solidAt / hitLandmark), spawning.
import { WORLD, SPAWN } from './constants.js';
import { createNoise } from './noise.js';
import { rng, smoothstep, lerp } from './math.js';
import * as castle from './castle.js';

const TAU = Math.PI * 2;
const wrapPi = (a) => a - TAU * Math.round(a / TAU);

export function createWorld(seed = WORLD.seed) {
  const { simplex, fbm, ridged } = createNoise(seed);
  const noiseApi = { simplex, fbm, ridged };
  const r = rng(seed * 7 + 3);

  // =============================================================================================== castle site
  // The castle (shared/castle.js) sits on this plateau. Inside `radius` the ground is exactly `height` m; it rises
  // from the moat in a rocky skirt `skirt` m wide. Nothing else (forest, sky islands, landmarks) is placed within
  // `clear` m of the centre.
  const castleSite = { x: 0, z: 0, radius: 600, height: 170, skirt: 260, clear: 920 };
  // 1 on the plateau, 0 beyond its skirt. The skirt edge is ragged but never pulls the flat top in.
  function plateauAt(x, z) {
    const d = Math.hypot(x - castleSite.x, z - castleSite.z) - castleSite.radius;
    if (d <= 0) return 1;
    if (d >= castleSite.skirt * 1.5) return 0;
    const rag = (0.5 + 0.5 * fbm(x * 0.006 + 3.3, z * 0.006 - 8.1, 3)) * 110 * smoothstep(0, 70, d);
    return 1 - smoothstep(0, castleSite.skirt, d + rag);
  }

  // =============================================================================================== radial features
  // The moat's centre line (radius by angle), the six passes and the three inlets. All lateral distances are metres.
  const moatR = (th) => 1040 + 55 * Math.sin(2 * th + 0.7) + 35 * Math.sin(5 * th + 2.1);
  const PASS_N = 6;
  const passes = [];
  for (let k = 0; k < PASS_N; k++) {
    const a = (k + 0.18 * Math.sin(k * 2.3 + 1)) * (TAU / PASS_N) + 0.3;
    // even passes end in a fjord whose head wall sits at `head`; odd ones run dry down to a beach
    passes.push({ k, a, half: 78 + 14 * Math.sin(k * 1.9), ph: k * 1.9, wob: 60 + 25 * Math.cos(k * 2.7), inlet: k % 2 === 0, head: 1440 + 50 * Math.sin(k * 1.7), crest: 150 + 40 * Math.sin(k * 2.1 + 0.5) });
  }
  // lateral offset (m) of a pass centre line at radius rr
  const passOff = (p, rr) => p.wob * Math.sin(rr * 0.0046 + p.ph) * smoothstep(1000, 1250, rr);
  const passAngle = (p, rr) => p.a + passOff(p, rr) / rr;
  // floor height of a pass at radius rr: from the moat up to a saddle, then down to the coast
  const passFloor = (p, rr) => 66 + (p.crest - 66) * smoothstep(1030, 1360, rr) - (p.crest - 36) * smoothstep(1500, 1950, rr);
  const INLET_W = 175;
  const INLET_FLOOR = -48;

  // =============================================================================================== land mask
  // satellite islands around the main massif: scenery beyond (and just inside) the battle radius
  const islands = [];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU + (r() - 0.5) * 0.5 + 0.2;
    const d = 2350 + r() * 600;
    islands.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, r: 230 + r() * 210, h: 0.6 + r() * 0.5, peak: 180 + r() * 360 });
  }

  function landMask(x, z) {
    const wx = x + 380 * fbm(x * 0.0004 + 5.2, z * 0.0004 + 1.3, 4);
    const wz = z + 380 * fbm(x * 0.0004 - 3.1, z * 0.0004 + 7.7, 4);
    let m = 1 - smoothstep(0.6, 1.0, Math.hypot(wx / 1.06, wz / 0.95) / 2330);
    for (const is of islands) {
      const d = Math.hypot(wx - is.x, wz - is.z) / is.r;
      if (d < 1.2) m = Math.max(m, (1 - smoothstep(0.3, 1.0, d)) * is.h);
    }
    return { m, wx, wz };
  }

  // terrain height in metres (sea level 0) before the landmark platforms are levelled in
  function heightRaw(x, z) {
    const { m, wx, wz } = landMask(x, z);
    const rr = Math.hypot(x, z);
    const th = Math.atan2(z, x);
    const hills = fbm(x * 0.0017, z * 0.0017, 4);
    let h = m * (30 + 85 * (hills * 0.5 + 0.5)) - (1 - m) * 160;

    // the mountain ring: jagged ridged peaks between 1.1 and 2 km out, and a peak on every satellite island
    const band = smoothstep(940, 1200, rr) * (1 - smoothstep(1800, 2150, rr));
    const mm = smoothstep(0.28, 0.85, m) * band * (0.62 + 0.38 * smoothstep(-0.4, 0.5, fbm(x * 0.0006 + 9.4, z * 0.0006 - 4.2, 2)));
    if (mm > 0.001) {
      // big ridges (wavelength ~1.2 km) with a layer of crags on top: steep and jagged, but peaks are broad enough to
      // see, fly round and fight over (the first draft, all fine ridges, was 32% sheer cliff)
      const rg = ridged(wx * 0.00085, wz * 0.00085, 4);
      h += mm * Math.pow(rg, 0.9) * 1080;
      h += mm * 120 * (ridged(wx * 0.0028 + 7.7, wz * 0.0028 - 3.1, 3) - 0.35);
      h += mm * 24 * fbm(x * 0.009, z * 0.009, 3);
    }
    if (rr > 2100) {
      let pk = 0;
      for (const is of islands) {
        const d = Math.hypot(wx - is.x, wz - is.z) / is.r;
        if (d < 0.85) pk = Math.max(pk, Math.pow(1 - smoothstep(0, 0.85, d), 1.6) * is.peak * (0.5 + 0.7 * ridged(wx * 0.003, wz * 0.003, 4)));
      }
      h += pk * smoothstep(0.35, 0.8, m);
    }

    // winding gorges through the ring (the same family of cuts the old map had, finer and steeper)
    const c2 = Math.abs(simplex(wx * 0.00062 + 20.5, wz * 0.00062 - 8.3));
    const cut2 = (1 - smoothstep(0.016, 0.075, c2)) * smoothstep(0.35, 0.65, m) * smoothstep(1050, 1300, rr) * (1 - smoothstep(1800, 2050, rr));
    if (cut2 > 0) h = lerp(h, Math.min(h, 120 + 90 * fbm(x * 0.002, z * 0.002, 2)), cut2);

    // the moat: a flat-floored ring canyon round the castle massif
    const dm = Math.abs(rr - moatR(th));
    if (dm < 230) {
      const floor = 60 + 20 * fbm(x * 0.0028, z * 0.0028, 3);
      h = lerp(h, floor, (1 - smoothstep(75, 230, dm)) * smoothstep(0.3, 0.6, m));
    }

    // six passes through the ring; three become sea inlets that end in a waterfall
    if (rr > 960 && rr < 2500) {
      for (let k = 0; k < PASS_N; k++) {
        const p = passes[k];
        const dth = Math.abs(wrapPi(th - passAngle(p, rr)));
        const lat = rr * dth;
        if (lat > p.half * 3.2 && lat > INLET_W * 1.5) continue;
        if (dth > 1.2) continue;
        const cut = (1 - smoothstep(p.half * 0.38, p.half * 1.7, lat)) * smoothstep(960, 1040, rr);
        if (cut > 0 && (rr < 2050 || !p.inlet)) h = lerp(h, Math.min(h, passFloor(p, rr)), cut);
        if (p.inlet && rr > p.head - 30) {
          // the fjord flares toward the sea and its head is rounded, with ragged walls
          const lw = lat + 38 * simplex(x * 0.0045 + p.k * 3.1, z * 0.0045);
          const W = INLET_W * (1 + Math.max(0, rr - p.head) * 0.00045);
          const sea = (1 - smoothstep(W * 0.5, W * 1.25, lw)) * smoothstep(p.head - 24, p.head + 26, rr - (lw * lw) / 900);
          if (sea > 0) h = lerp(h, Math.min(h, INLET_FLOOR), sea);
        }
      }
    }

    // the castle massif: a flat top with a ragged, craggy skirt
    const w = plateauAt(x, z);
    if (w > 0) {
      h = lerp(h, castleSite.height, w);
      if (w < 1) h += w * (1 - w) * 4 * 70 * (ridged(x * 0.0042, z * 0.0042, 3) - 0.42);
    }

    // beaches: flatten the band just above sea level
    if (h > -6 && h < 14) h = lerp(h, 4 + (h - 4) * 0.35, 0.6);

    // far ocean floor
    const far = smoothstep(WORLD.terrainHalf * 0.75, WORLD.terrainHalf, Math.max(Math.abs(x), Math.abs(z)));
    return lerp(h, -220, far);
  }

  // Distance-like measure to the nearest canyon / river centre line (c, 0 on the line) and how deeply the land is
  // cut here (cut 0..1). One unit of c is about 2.2 km; the renderer paints streams and vegetation from them.
  function canyonAt(x, z) {
    const { m, wx, wz } = landMask(x, z);
    const rr = Math.hypot(x, z);
    const th = Math.atan2(z, x);
    let c = 1, cut = 0;
    const take = (cc, cu) => { if (cu > 0.05 && cc < c) { c = cc; cut = cu; } else if (cu > cut && c >= 1) cut = cu; };
    // the moat
    const dm = Math.abs(rr - moatR(th));
    if (dm < 230) take(dm / 2200, (1 - smoothstep(75, 230, dm)) * smoothstep(0.3, 0.6, m));
    // passes
    if (rr > 960 && rr < 2100) {
      for (let k = 0; k < PASS_N; k++) {
        const p = passes[k];
        const dth = Math.abs(wrapPi(th - passAngle(p, rr)));
        const lat = rr * dth;
        if (lat > p.half * 3.2 || (p.inlet && rr > p.head - 10)) continue;
        take(lat / 2200, (1 - smoothstep(p.half * 0.38, p.half * 1.7, lat)) * smoothstep(960, 1040, rr));
      }
    }
    // gorges
    const c2 = Math.abs(simplex(wx * 0.00062 + 20.5, wz * 0.00062 - 8.3));
    take(c2, (1 - smoothstep(0.016, 0.075, c2)) * smoothstep(0.35, 0.65, m) * smoothstep(1050, 1300, rr) * (1 - smoothstep(1800, 2050, rr)));
    return { c, cut, m };
  }

  // =============================================================================================== landmarks
  // ruined forts, temples and watchtowers on levelled platforms, sea stacks along the coasts and in the fjords.
  // Chosen deterministically from the raw height; the renderer builds meshes from `pieces` / `stacks` and the
  // cylinders in `colliders` make the tall ones solid for dragons.
  const sites = [];
  const stacks = [];
  function height(x, z) {
    let h = heightRaw(x, z);
    for (let i = 0; i < sites.length; i++) {
      const s = sites[i];
      const dx = x - s.x, dz = z - s.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < s.flat2) h = lerp(h, s.y, 1 - smoothstep(s.r, s.r * 1.7, Math.sqrt(d2)));
    }
    return castle.terrain(x, z, h, noiseApi); // the citadel's rocky massif at the centre of the map
  }

  const PIECE_COLLIDERS = {
    // kind: (variant) => [x, z, radius, height] relative to the piece (before scale / rotation)
    tower: (v) => [[0, 0, 5.0, v ? 15 : 24]],
    pillar: (v) => [[0, 0, 1.05, v ? 4.5 : 10]],
    arch: () => [[-5.6, 0, 2.1, 14], [5.6, 0, 2.1, 14]],
    skull: () => [[11, 0, 7, 14]],
  };
  const SITE_PLANS = {
    fort: () => {
      const p = [];
      for (const [x, z] of [[-20, -20], [20, -20], [-20, 20], [20, 20]]) p.push({ k: 'tower', x, z, yaw: 0, s: 1, v: x * z > 0 ? 0 : 1 });
      for (let side = 0; side < 4; side++) {
        const a = (side * Math.PI) / 2;
        for (const o of [-12.5, 0, 12.5]) {
          const lx = o, lz = 20;
          const x = lx * Math.cos(a) - lz * Math.sin(a), z = lx * Math.sin(a) + lz * Math.cos(a);
          if (side === 0 && o === 0) p.push({ k: 'arch', x, z, yaw: a, s: 1, v: 0 });
          else p.push({ k: 'wall', x, z, yaw: a, s: 1, v: (side + (o > 0 ? 1 : 0) + (o < 0 ? 2 : 0)) % 3 });
        }
      }
      p.push({ k: 'tower', x: 2, z: -4, yaw: 0.6, s: 1.45, v: 0 });
      for (const [x, z, v] of [[-8, 8, 1], [10, 6, 0], [-9, -9, 1]]) p.push({ k: 'pillar', x, z, yaw: 0, s: 1, v });
      return p;
    },
    temple: () => {
      const p = [{ k: 'steps', x: 0, z: 0, yaw: 0, s: 1, v: 0 }, { k: 'altar', x: 0, z: 0, yaw: 0, s: 1, v: 0 }];
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        p.push({ k: 'pillar', x: Math.cos(a) * 17, z: Math.sin(a) * 17, yaw: i, s: 1, v: i % 3 === 1 ? 1 : 0 });
      }
      p.push({ k: 'arch', x: -27, z: 0, yaw: Math.PI / 2, s: 1.15, v: 0 });
      p.push({ k: 'tower', x: 26, z: -14, yaw: 1, s: 0.9, v: 1 });
      p.push({ k: 'tower', x: 26, z: 14, yaw: 2, s: 0.9, v: 0 });
      for (const [x, z, a] of [[-33, -9, 0.3], [-33, 9, 1.1], [18, -30, 2]]) p.push({ k: 'wall', x, z, yaw: a, s: 1, v: 2 });
      return p;
    },
    // the bleached skeleton of a colossal dragon, lying along local x
    bones: () => {
      const p = [
        { k: 'spine', x: -26, z: 0, yaw: 0, s: 1, v: 0 },
        { k: 'spine', x: 0, z: 0, yaw: 0, s: 1, v: 0 },
        { k: 'tail', x: -26, z: 0, yaw: Math.PI, s: 1.1, v: 0 },
        { k: 'skull', x: 27, z: 1.5, yaw: 0.12, s: 1, v: 0 },
      ];
      const sc = [0.75, 0.9, 1.05, 1.15, 1.15, 1.05, 0.9, 0.75];
      for (let i = 0; i < 8; i++) {
        p.push({ k: 'rib', x: -22 + i * 5, z: 0, yaw: 0, s: sc[i], v: i % 2 });
        if (i !== 2 && i !== 6) p.push({ k: 'rib', x: -22 + i * 5, z: 0, yaw: Math.PI, s: sc[i], v: (i + 1) % 2 });
      }
      return p;
    },
    tower: () => {
      const p = [{ k: 'tower', x: 0, z: 0, yaw: 0, s: 1.25, v: 0 }];
      for (const [x, z, a, v] of [[10, 4, 0.4, 1], [-9, 8, 2.2, 2], [4, -11, 4, 0]]) p.push({ k: 'wall', x, z, yaw: a, s: 0.8, v });
      p.push({ k: 'pillar', x: -7, z: -6, yaw: 0, s: 1, v: 1 });
      return p;
    },
  };

  const arches = [];
  const waterfalls = [];

  (function placeLandmarks() {
    const lr = rng(seed * 31 + 17);
    // candidate platforms on a coarse grid: gentle ground, clear of the castle and of canyon cuts
    const cand = [];
    const R4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let z = -2900; z <= 2900; z += 70) {
      for (let x = -2900; x <= 2900; x += 70) {
        const rr = Math.hypot(x, z);
        if (rr < castleSite.clear + 60 || rr > 3000) continue;
        const h = heightRaw(x, z);
        if (h < 14 || h > 800) continue;
        if (rr < castle.CASTLE.clear + 200) continue; // the citadel owns the middle of the map
        let lo = h, hi = h, sum = h;
        for (const [dx, dz] of R4) {
          const q = heightRaw(x + dx * 55, z + dz * 55);
          lo = Math.min(lo, q); hi = Math.max(hi, q); sum += q;
        }
        if (hi - lo > 130) continue;
        cand.push({ x, z, h, rr, y: sum / 5, rough: hi - lo });
      }
    }
    // kind, ground height range, radius range from the castle, platform radius
    const wants = [
      ['fort', 30, 130, 930, 1250, 46], // the moat
      ['temple', 14, 90, 1700, 2150, 56], // beach
      ['tower', 240, 620, 1200, 1750, 26], // mountain flank
      ['bones', 40, 200, 1250, 1900, 54], // pass floor
      ['temple', 250, 560, 1250, 1700, 56], // hanging terrace
      ['fort', 100, 260, 1450, 2000, 46], // beyond the saddle
      ['tower', 30, 130, 950, 1300, 26], // moat
      ['tower', 14, 140, 2300, 3000, 26], // backdrop lighthouse on a satellite
      ['temple', 14, 120, 2250, 3000, 56], // backdrop
      ['tower', 330, 760, 1300, 1800, 26],
    ];
    for (const [kind, lo, hi, rlo, rhi, rad] of wants) {
      const ranked = [];
      for (const c of cand) {
        if (c.h < lo || c.h > hi || c.rr < rlo || c.rr > rhi) continue;
        if (sites.some((q) => Math.hypot(q.x - c.x, q.z - c.z) < 470)) continue;
        ranked.push([c.rough + (c.rough > 60 ? 200 : 0) + lr() * 14, c]); // gentle ground first
      }
      ranked.sort((a, b) => a[0] - b[0]);
      let best = null;
      for (const [, c] of ranked) {
        if (canyonAt(c.x, c.z).cut > 0.12) continue;
        best = c;
        break;
      }
      if (!best) continue;
      const yaw = Math.round(lr() * 24) * (Math.PI / 12);
      const site = { kind, x: best.x, z: best.z, y: Math.round(best.y), yaw, r: rad, flat2: (rad * 1.7) ** 2, pieces: SITE_PLANS[kind](), colliders: [] };
      const cs = Math.cos(yaw), sn = Math.sin(yaw);
      for (const pc of site.pieces) {
        const gx = best.x + pc.x * cs - pc.z * sn, gz = best.z + pc.x * sn + pc.z * cs;
        pc.wx = gx; pc.wz = gz; pc.wyaw = yaw + pc.yaw;
        const f = PIECE_COLLIDERS[pc.k];
        if (!f) continue;
        const pcs = Math.cos(pc.wyaw), psn = Math.sin(pc.wyaw);
        for (const [ox, oz, rr, hh] of f(pc.v)) {
          site.colliders.push({ x: gx + (ox * pcs - oz * psn) * pc.s, z: gz + (ox * psn + oz * pcs) * pc.s, r: rr * pc.s, y0: site.y - 10, y1: site.y + hh * pc.s });
        }
      }
      sites.push(site);
    }

    // --- sea stacks: rays out from the main island and every satellite (the last coast crossing, then a bit out
    // to sea), then a slalom of them down the middle of each fjord
    const addStack = (x, z, r0, top, minGap = 120) => {
      if (stacks.some((q) => Math.hypot(q.x - x, q.z - z) < minGap)) return null;
      const s = { x, z, r: r0, top, seed: Math.floor(lr() * 1e9) };
      stacks.push(s);
      return s;
    };
    const sources = [{ x: 0, z: 0, R: 2500, step: 40, n: 36 }, ...islands.map((is) => ({ x: is.x, z: is.z, R: is.r * 2.2, step: 40, n: 8 }))];
    for (const src of sources) {
      for (let k = 0; k < src.n && stacks.length < 30; k++) {
        const a = ((k + lr()) / src.n) * TAU;
        const dx = Math.cos(a), dz = Math.sin(a);
        let coast = -1;
        for (let d = src.step; d < src.R; d += src.step) {
          if (heightRaw(src.x + dx * d, src.z + dz * d) > 3) coast = d;
        }
        if (coast < 0) continue;
        const d = coast + 60 + lr() * 150;
        const x = Math.round(src.x + dx * d), z = Math.round(src.z + dz * d);
        const h = heightRaw(x, z);
        if (h > -4 || h < -45 || Math.hypot(x, z) > 2900) continue; // scenery out to the satellite islands
        const r0 = 7 + lr() * 9, top = 26 + lr() * 52;
        if (!addStack(x, z, r0, top, 130)) continue;
        if (lr() < 0.3) {
          const r1 = 6 + lr() * 6;
          const gap = r0 + r1 + 34 + lr() * 14;
          const x2 = Math.round(x - dz * gap), z2 = Math.round(z + dx * gap);
          const h2 = heightRaw(x2, z2);
          if (h2 < -3 && h2 > -50) stacks.push({ x: x2, z: z2, r: r1, top: 24 + lr() * 40, seed: Math.floor(lr() * 1e9) });
        }
      }
    }
    // rock spires in the moat: thin needles to weave through (land stacks: no sea foam at their feet)
    for (let tries = 0, n = 0; tries < 500 && n < 9; tries++) {
      const th = lr() * TAU, rr = moatR(th) + (lr() - 0.5) * 200;
      const x = Math.round(Math.cos(th) * rr), z = Math.round(Math.sin(th) * rr);
      const h = heightRaw(x, z);
      if (Math.hypot(x, z) < castleSite.clear + 70 || h < 20 || h > 140 || sites.some((q) => Math.hypot(q.x - x, q.z - z) < q.r * 1.7 + 30)) continue;
      const s = addStack(x, z, 9 + lr() * 7, h + 55 + lr() * 90, 170);
      if (s) { s.land = true; n++; }
    }
    for (const p of passes) {
      if (!p.inlet) continue;
      // fjord slalom: stacks alternate left and right of the centre line, thin enough to weave through
      for (let i = 0; i < 4; i++) {
        const rr = p.head + 130 + i * 150 + lr() * 40;
        const th = passAngle(p, rr) + ((i % 2 ? 1 : -1) * (24 + lr() * 30)) / rr;
        const x = Math.round(Math.cos(th) * rr), z = Math.round(Math.sin(th) * rr);
        if (heightRaw(x, z) < -20) addStack(x, z, 8 + lr() * 6, 34 + lr() * 46, 90);
      }
      // the waterfall: the pass river pouring over the head wall into the fjord
      const th = passAngle(p, p.head);
      const th2 = passAngle(p, p.head + 20);
      const x = Math.cos(th) * (p.head - 12), z = Math.sin(th) * (p.head - 12);
      const fx = Math.cos(th2) * (p.head + 20) - Math.cos(th) * (p.head - 12), fz = Math.sin(th2) * (p.head + 20) - Math.sin(th) * (p.head - 12);
      const fl = Math.hypot(fx, fz);
      waterfalls.push({ x, z, y: Math.round(passFloor(p, p.head - 12)), drop: Math.round(passFloor(p, p.head - 12)), width: 26, dx: fx / fl, dz: fz / fl, pass: p.k, seed: Math.floor(lr() * 1e9) });
    }
  })();

  // =============================================================================================== sky islands
  // Floating islands (sky rocks): colliders are two spheres each. A dozen of them between 980 m out and the arena's edge, in a
  // spread of sizes and heights (low ones tuck into the valleys, high ones sit under the cloud banks).
  const sky = [];
  (function placeSky() {
    const sr = rng(seed * 13 + 5);
    const radii = [160, 128, 110, 96, 84, 74, 66, 58, 52, 46, 42, 38];
    for (const rad of radii) {
      for (let tries = 0; tries < 300; tries++) {
        const a = sr() * TAU;
        // between the moat and the edge of the battle area (the whole island, not just its centre, stays inside)
        const d = 980 + Math.sqrt(sr()) * (WORLD.radius - 70 - rad - 980);
        const x = Math.cos(a) * d, z = Math.sin(a) * d;
        const low = sr() < 0.35;
        let y = low ? 240 + sr() * 260 : 520 + sr() * 640;
        // the underside hangs 1.4 r down: keep it off the ground
        let ground = -Infinity;
        for (const [ox, oz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) ground = Math.max(ground, heightRaw(x + ox * rad, z + oz * rad));
        y = Math.max(y, ground + rad * 1.5 + 30);
        if (y + rad * 0.3 > WORLD.ceiling - 250) continue;
        if (sky.some((s) => Math.hypot(s.x - x, s.z - z, (s.y - y) * 0.6) < s.r + rad + 190)) continue;
        sky.push({ x, y, z, r: rad, seed: Math.floor(sr() * 1e9), spin: sr() * TAU });
        break;
      }
    }
  })();

  // =============================================================================================== rock arches
  // Natural stone rings to fly through. A ring is a torus (centre, axis yaw, hole radius R, tube radius t) that the
  // renderer meshes and archAt() collides with: a gate across each dry pass, one on a sea stack, one on each of the
  // two biggest sky islands. `axis` is the horizontal direction you fly through.
  (function placeArches() {
    const ar = rng(seed * 17 + 9);
    // stone gates across the dry passes, bottom buried in the pass floor
    for (const p of passes) {
      if (p.inlet) continue;
      const rr = 1330 + 30 * Math.sin(p.k);
      const th = passAngle(p, rr);
      const x = Math.cos(th) * rr, z = Math.sin(th) * rr;
      const tth = passAngle(p, rr + 25);
      const yaw = Math.atan2(Math.sin(tth) * (rr + 25) - Math.sin(th) * rr, Math.cos(tth) * (rr + 25) - Math.cos(th) * rr);
      const R = 50, t = 13;
      arches.push({ x, y: Math.round(passFloor(p, rr) + R * 0.78), z, yaw, R, t, seed: Math.floor(ar() * 1e9), kind: 'gate' });
    }
    // a sea arch: a ring grown on a stack just off the coast, between two fjords
    {
      const a0 = passes[1].a, a1 = passes[2].a;
      const mid = a0 + ((a1 - a0) % TAU) * 0.5;
      let best = null;
      for (let d = 1700; d < 2400; d += 25) {
        const x = Math.cos(mid) * d, z = Math.sin(mid) * d;
        if (heightRaw(x, z) < -14 && heightRaw(x + 30, z) < -14 && heightRaw(x, z + 30) < -14) { best = [x, z]; break; }
      }
      if (best) {
        const R = 46, t = 12, top = 52;
        const x = Math.round(best[0]), z = Math.round(best[1]);
        stacks.push({ x, z, r: 15, top, seed: Math.floor(ar() * 1e9), arch: true });
        arches.push({ x, y: top + R + t - 6, z, yaw: mid + Math.PI / 2 + 0.3, R, t, seed: Math.floor(ar() * 1e9), kind: 'sea' });
      }
    }
    // rings on the two biggest sky islands, on the side away from the waterfall
    const big = sky.filter((s) => s.r >= 100).sort((a, b) => b.r - a.r).slice(0, 2);
    for (const s of big) {
      const ang = s.spin + Math.PI;
      const R = Math.round(s.r * 0.36), t = Math.round(R * 0.28);
      const rho = s.r * 0.62;
      s.ring = { a: ang, rho, R, t };
      arches.push({
        x: s.x + Math.cos(ang) * rho, y: Math.round(s.y + s.r * 0.3 + R + t - 8), z: s.z + Math.sin(ang) * rho,
        yaw: ang + Math.PI / 2, R, t, seed: Math.floor(ar() * 1e9), kind: 'sky',
      });
    }
  })();

  // =============================================================================================== queries
  function normal(x, z, e = 4) {
    const hx = height(x + e, z) - height(x - e, z);
    const hz = height(x, z + e) - height(x, z - e);
    const nx = -hx, ny = 2 * e, nz = -hz;
    const l = Math.hypot(nx, ny, nz);
    return [nx / l, ny / l, nz / l];
  }

  // ground or sea surface, whichever is higher
  const floorAt = (x, z) => Math.max(height(x, z), WORLD.sea);

  // Floating island shape: a sphere cut flat at the top (+0.3 r) over a narrower lower lobe; the visual mesh
  // (client/js/render/islands.js) follows the same profile. Returns the island p (padded) is inside, or null.
  function skyRockRadius(s, dy) {
    if (dy > s.r * 0.3) return -1;
    const a = s.r * s.r - dy * dy;
    const lo = dy + s.r * 0.75;
    const b = (s.r * 0.62) ** 2 - lo * lo;
    return Math.sqrt(Math.max(a, b, 0)) || (a > 0 || b > 0 ? 0 : -1);
  }
  function hitSkyRock(p, pad = 0) {
    for (const s of sky) {
      const dx = p[0] - s.x, dz = p[2] - s.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > (s.r + pad) ** 2) continue;
      const dy = p[1] - s.y;
      if (dy > s.r * 0.3 + pad || dy < -s.r * 1.4 - pad) continue;
      const rr = Math.max(skyRockRadius(s, Math.min(dy, s.r * 0.3)), skyRockRadius(s, dy - Math.sign(dy) * Math.min(pad, Math.abs(dy))));
      if (rr >= 0 && Math.sqrt(d2) < rr + pad) return s;
    }
    return null;
  }

  // A rock ring is solid within `t` of its centre circle. The tube is meshed lumpy (never thinner than 0.85 t), so collide a bit inside it.
  function hitArch(p, pad = 0) {
    for (let i = 0; i < arches.length; i++) {
      const a = arches[i];
      const reach = a.R + a.t + pad;
      const dx = p[0] - a.x, dy = p[1] - a.y, dz = p[2] - a.z;
      if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
      const ax = Math.cos(a.yaw), az = Math.sin(a.yaw);
      const u = dx * ax + dz * az; // along the flight axis
      const v = -dx * az + dz * ax; // across (horizontal, in the ring plane)
      const rho = Math.hypot(v, dy);
      if (Math.hypot(rho - a.R, u) < a.t * 0.8 + pad) return a;
    }
    return null;
  }

  // ---- solids: everything a dragon or fireball can hit. New solids (e.g. the castle) hook in here. ----
  // Did a dragon at p collide with anything solid?
  function solidAt(p, pad = 0) {
    if (p[1] - pad < floorAt(p[0], p[2])) return true;
    if (hitSkyRock(p, pad)) return true;
    return !!hitLandmark(p, pad) || !!castle.hit(p, pad);
  }

  // tall solid props: ruin towers, pillars and gates (cylinders), sea stacks and rock rings. Returns the thing hit
  // (it has x and z, so bots can steer round it) or null.
  function hitLandmark(p, pad = 0) {
    for (let i = 0; i < stacks.length; i++) {
      const s = stacks[i];
      const dx = p[0] - s.x, dz = p[2] - s.z, rr = s.r * 0.9 + pad;
      if (dx * dx + dz * dz < rr * rr && p[1] < s.top + pad) return s;
    }
    for (let i = 0; i < sites.length; i++) {
      const s = sites[i];
      const dx = p[0] - s.x, dz = p[2] - s.z;
      if (dx * dx + dz * dz > s.r * s.r * 4 || p[1] > s.y + 60) continue;
      for (const c of s.colliders) {
        const ex = p[0] - c.x, ez = p[2] - c.z, rr = c.r + pad;
        if (ex * ex + ez * ez < rr * rr && p[1] < c.y1 + pad && p[1] > c.y0 - pad) return c;
      }
    }
    return hitArch(p, pad);
  }

  // =============================================================================================== spawning
  // Candidates lie on a ring round the castle. With other dragons alive, the best one is about SPAWN.near metres
  // from the closest of them (a fight within a minute's boost, never on top of anyone); alone, it is simply spread out.
  // Lowest altitude from which a dragon at (x, z) can fly straight toward the castle without meeting the ground:
  // the highest terrain within 700 m of the way in (and a little to either side), plus a margin to climb in.
  function clearAltitude(x, z, margin = 130) {
    const l = Math.hypot(x, z) || 1;
    const dx = -x / l, dz = -z / l;
    let top = floorAt(x, z);
    for (const d of [90, 180, 300, 450, 600, 750]) {
      for (const side of [-1, 0, 1]) top = Math.max(top, floorAt(x + dx * d - dz * side * 110, z + dz * d + dx * side * 110));
    }
    return top + margin;
  }

  function spawnPoint(rand, avoid = []) {
    let best = null, bestScore = -Infinity;
    const [n0, n1] = SPAWN.near;
    for (let i = 0; i < 14; i++) {
      const a = rand() * TAU;
      const d = WORLD.radius * (SPAWN.ringMin + rand() * (SPAWN.ringMax - SPAWN.ringMin));
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      const y = Math.min(Math.max(clearAltitude(x, z) + rand() * 260, SPAWN.minAlt + rand() * 500), SPAWN.maxAlt);
      if (castle.near(x, z, castle.CASTLE.radius + 500)) continue; // never spawn at the citadel
      let score = rand() * 60;
      if (avoid.length) {
        let nearest = Infinity;
        for (const q of avoid) nearest = Math.min(nearest, Math.hypot(q[0] - x, q[1] - y, q[2] - z));
        score -= nearest < SPAWN.clear ? 3000 + (SPAWN.clear - nearest) * 4 : nearest < n0 ? n0 - nearest : nearest > n1 ? (nearest - n1) * 0.8 : 0;
      }
      if (solidAt([x, y, z], 80)) score -= 5000;
      if (score > bestScore) { bestScore = score; best = [x, y, z]; }
    }
    return best || [WORLD.radius * 0.8, 900, 0];
  }

  // healing shrines: one over each sky island, then the citadel's (courtyard and high sky bridge)
  const shrines = sky.map((s) => [s.x, s.y + s.r * 0.3 + 16, s.z]);
  for (const q of castle.castleSpec().shrines) shrines.push([castle.CASTLE.x + q[0], castle.CASTLE.y0 + q[1], castle.CASTLE.z + q[2]]);

  return {
    seed, height, heightRaw, normal, canyonAt, floorAt, sites, stacks, hitLandmark, hitSkyRock, hitArch, skyRockRadius, shrines, solidAt, spawnPoint, clearAltitude,
    islands, sky, castle, arches, waterfalls, passes, castleSite, plateauAt, moatR, passAngle, passFloor, noise: { simplex, fbm, ridged },
  };
}
