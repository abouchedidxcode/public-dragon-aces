// Where things grow. A pure function of the shared world (heights, canyon centre lines) plus a few noise
// fields, evaluated in the terrain worker for two jobs:
//   * a coarse raster (forest density, stream distance, conifer share) the terrain shader uses for the canopy
//     tint, forest floor and streams, and
//   * exact tree / shrub / palm / rock instances for one 800 m block at a time (see vegetation.js).
// Nothing here is used for gameplay, so it never has to match between machines, but it is deterministic anyway.
import { smoothstep, lerp, clamp, rng } from '../../../shared/math.js';
import { CASTLE } from '../../../shared/castle.js';

export const SPECIES = ['fir', 'pine', 'oak', 'birch', 'palm', 'shrub'];
export const BLOCK = 800;
const SPACING = 8; // jittered grid for trees
const ROCK_SPACING = 12;
const STRIDE = 8;

export function createFlora(world) {
  const { fbm, simplex } = world.noise;

  // everything that varies slowly over the map
  function climate(x, z) {
    return {
      patch: fbm(x * 0.0021 + 11.3, z * 0.0021 - 4.1, 3), // meadows vs forest
      glade: fbm(x * 0.009 - 7.7, z * 0.009 + 2.2, 2), // small clearings
      a: fbm(x * 0.0035 + 7.0, z * 0.0035 + 1.0, 2), // species patches
      b: fbm(x * 0.006 - 3.0, z * 0.006 + 9.0, 2),
      tree: 610 + 130 * fbm(x * 0.0016 + 3.0, z * 0.0016 - 1.0, 2), // tree line altitude (the ring tops out near 1 km)
    };
  }

  // ruin platforms stay clear of trees: 0 on the platform, 1 beyond a ring of rubble
  const sites = world.sites || [];
  const castle = world.castleSite;
  function siteClear(x, z) {
    let c = 1;
    // the castle massif and its skirt: bare rock, no trees
    if (castle) {
      const dc = Math.hypot(x - castle.x, z - castle.z);
      if (dc < castle.radius * 1.9) c = Math.min(c, smoothstep(castle.radius * 1.05, castle.radius * 1.55, dc));
    }
    for (const st of sites) {
      const d2 = (x - st.x) ** 2 + (z - st.z) ** 2;
      if (d2 < (st.r * 2.2) ** 2) c = Math.min(c, smoothstep(st.r * 0.9, st.r * 1.7, Math.sqrt(d2)));
    }
    // the citadel's massif: bare rock, no trees on the plateau or its cliffs
    const cr2 = (x - CASTLE.x) ** 2 + (z - CASTLE.z) ** 2;
    if (cr2 < (CASTLE.plateau + 190) ** 2) c = Math.min(c, smoothstep(CASTLE.plateau + 30, CASTLE.plateau + 190, Math.sqrt(cr2)));
    return c;
  }

  // forest density 0..1 at a point (h = ground height, ny = ground normal y)
  function forestDensity(h, ny, k, riparian) {
    const s = 1 - ny;
    let d = smoothstep(1.8, 9, h);
    d *= 1 - smoothstep(k.tree - 260, k.tree, h);
    d *= 1 - smoothstep(0.26, 0.46, s + 0.05 * k.glade);
    let meadow = smoothstep(-0.28, 0.08, k.patch) * (1 - 0.8 * smoothstep(0.42, 0.6, k.glade));
    meadow = Math.max(meadow, riparian * 0.9);
    return d * meadow;
  }

  // share of conifers among trees (0 broadleaf lowland .. 1 conifer highland)
  const conifer = (h, k) => clamp(smoothstep(110, 430, h + k.a * 260) + 0.4 * smoothstep(0.0, 0.35, k.a), 0, 1);

  function streamAt(x, z, h) {
    if (h > 420 || h < 8) return { c: 1, cut: 0 };
    return world.canyonAt(x, z);
  }

  // ------------------------------------------------------------------ coarse raster for the terrain shader
  // heights: Float32Array(n*n) of world.height on the global grid; returns RGBA8: forest, stream, conifer, rock
  function raster(heights, n, half) {
    const cell = (half * 2) / (n - 1);
    const out = new Uint8Array(n * n * 4);
    for (let j = 1; j < n - 1; j++) {
      const z = -half + j * cell;
      for (let i = 1; i < n - 1; i++) {
        const k0 = (j * n + i) * 4;
        const h = heights[j * n + i];
        out[k0 + 1] = 255;
        if (h < 2 || h > 1250) continue;
        const x = -half + i * cell;
        const gx = (heights[j * n + i + 1] - heights[j * n + i - 1]) / (2 * cell);
        const gz = (heights[(j + 1) * n + i] - heights[(j - 1) * n + i]) / (2 * cell);
        const ny = 1 / Math.hypot(1, gx, gz);
        const k = climate(x, z);
        const st = streamAt(x, z, h);
        const ripar = (1 - smoothstep(0.012, 0.05, st.c)) * st.cut;
        const d = forestDensity(h, ny, k, ripar) * siteClear(x, z);
        out[k0] = Math.round(clamp(d, 0, 1) * 255);
        out[k0 + 1] = st.cut > 0.5 ? Math.round(clamp(st.c / 0.04, 0, 1) * 255) : 255;
        out[k0 + 2] = Math.round(clamp(conifer(h, k), 0, 1) * 255);
        // rockiness: steep faces and high ground
        const s = 1 - ny;
        out[k0 + 3] = Math.round(clamp(smoothstep(0.12, 0.45, s) + smoothstep(400, 800, h) * 0.6, 0, 1) * 255);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ one block of instances
  function block(bx0, bz0) {
    const lists = SPECIES.map(() => []);
    const rocks = [];
    const n = BLOCK / SPACING;
    const E = 2.5;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const ci = Math.floor(bx0 / SPACING) + i, cj = Math.floor(bz0 / SPACING) + j;
        const r = rng(Math.imul(ci, 374761393) ^ Math.imul(cj, 668265263) ^ 0x9e3779b9);
        const x = bx0 + (i + 0.1 + 0.8 * r()) * SPACING;
        const z = bz0 + (j + 0.1 + 0.8 * r()) * SPACING;
        const h = world.height(x, z);
        const rr = [r(), r(), r(), r(), r(), r()];
        if (h < 1.2 || h > 1250) continue;
        const gx = (world.height(x + E, z) - h) / E, gz = (world.height(x, z + E) - h) / E;
        const ny = 1 / Math.hypot(1, gx, gz);
        const k = climate(x, z);
        const st = streamAt(x, z, h);
        const inStream = st.cut > 0.9 && st.c < 0.0042;
        const ripar = (1 - smoothstep(0.012, 0.05, st.c)) * st.cut;
        const clear = siteClear(x, z);
        const dens = forestDensity(h, ny, k, ripar) * clear;
        const s = 1 - ny;
        if (!inStream) {
          // palms on the beaches and low shores
          const palmD = smoothstep(1.8, 3.2, h) * (1 - smoothstep(8, 15, h)) * (1 - smoothstep(0.1, 0.22, s)) * (0.3 + 0.7 * smoothstep(-0.2, 0.3, k.patch + 0.3));
          if (rr[0] < palmD * 0.8 * clear) {
            lists[4].push([x, h, z, 0.75 + 0.6 * rr[1], rr[2] * 6.2832, rr[3], rr[4], rr[5]]);
          } else if (rr[0] < Math.min(1, dens * 1.2)) {
            const cf = conifer(h, k);
            let sp;
            if (rr[1] < cf) sp = 0.7 * smoothstep(0.0, 0.45, k.b) > rr[2] ? 1 : 0; // pine : fir
            else sp = smoothstep(0.05, 0.4, -k.b) * 0.8 + (h > 380 ? 0.25 : 0) > rr[2] ? 3 : 2; // birch : oak
            // stunted toward the tree line, a bit smaller on thin soil
            const age = lerp(1, 0.5, smoothstep(k.tree - 320, k.tree, h)) * lerp(0.82, 1, smoothstep(0.05, 0.22, 0.4 - s));
            const base = sp === 0 ? 1 : sp === 1 ? 0.95 : sp === 2 ? 1.0 : 0.9;
            const sc = base * age * (0.7 + 0.8 * Math.pow(rr[3], 0.85));
            lists[sp].push([x, h, z, sc, rr[4] * 6.2832, rr[5], clamp(0.5 * rr[2] + 0.5 * (0.5 + k.b), 0, 1), rr[1]]);
          }
        }
        // shrubs: under the trees, in meadows and scrub, never on sand or cliffs
        if (!inStream && h > 3 && s < 0.38 && clear > 0.6) {
          const sd = (0.1 + 0.25 * dens + 0.12 * (1 - smoothstep(-0.3, 0.1, k.patch))) * (1 - smoothstep(700, 1000, h));
          if (rr[3] < sd * 0.7 && rr[0] > dens * 0.5) lists[5].push([x, h, z, 0.7 + 0.9 * rr[1], rr[2] * 6.2832, rr[4], rr[5], rr[0]]);
        }
      }
    }
    // rocks on a slightly coarser grid
    const rn = BLOCK / ROCK_SPACING;
    for (let j = 0; j < rn; j++) {
      for (let i = 0; i < rn; i++) {
        const ci = Math.floor(bx0 / ROCK_SPACING) + i, cj = Math.floor(bz0 / ROCK_SPACING) + j;
        const r = rng(Math.imul(ci, 668265263) ^ Math.imul(cj, 374761393) ^ 0x51ed270b);
        const x = bx0 + (i + 0.1 + 0.8 * r()) * ROCK_SPACING;
        const z = bz0 + (j + 0.1 + 0.8 * r()) * ROCK_SPACING;
        const q0 = r(), q1 = r(), q2 = r(), q3 = r(), q4 = r();
        if (q0 > 0.5) continue;
        const h = world.height(x, z);
        if (h < 0.5 || h > 1350) continue;
        const gx = (world.height(x + E, z) - h) / E, gz = (world.height(x, z + E) - h) / E;
        const ny = 1 / Math.hypot(1, gx, gz);
        const s = 1 - ny;
        const k = climate(x, z);
        const st = streamAt(x, z, h);
        const nearStream = (1 - smoothstep(0.004, 0.02, st.c)) * st.cut;
        // more rocks on steep ground, on high ground, around streams and on the water's edge
        const dens = 0.04 + 0.6 * smoothstep(0.1, 0.4, s) + 0.25 * smoothstep(500, 1000, h) + 0.5 * nearStream + 0.15 * (1 - smoothstep(2, 6, h)) * smoothstep(0.5, 1.5, h);
        if (q1 > dens * siteClear(x, z)) continue;
        const forest = forestDensity(h, ny, k, 0);
        if (forest > 0.5 && q2 < 0.6 && s < 0.25) continue; // fewer boulders under dense trees
        const big = Math.pow(q3, 3);
        const size = 0.6 + big * (3.5 + 5 * smoothstep(0.2, 0.5, s));
        rocks.push([x, h, z, size, q4 * 6.2832, Math.floor(q2 * 4.99), -gx, -gz]);
      }
    }
    return pack(bx0, bz0, lists, rocks);
  }

  return { block, raster, climate, forestDensity, streamAt };
}

// ---------------------------------------------------------------------------------------------------------------
// packing: per species an L0 list grouped in 100 m cells, an L1 list grouped in 400 m quadrants (rank sorted),
// and an L2 list (rank < 0.62). Instance layout (8 floats): x y z scale | yaw rank tint aspect

function pack(bx0, bz0, lists, rocks) {
  const species = lists.map((list, si) => {
    if (!list.length) return null;
    const cells = new Map();
    const quads = [[], [], [], []];
    const far = [];
    for (const t of list) {
      const cx = clamp(Math.floor((t[0] - bx0) / 100), 0, 7), cz = clamp(Math.floor((t[2] - bz0) / 100), 0, 7);
      const ci = cz * 8 + cx;
      if (!cells.has(ci)) cells.set(ci, []);
      cells.get(ci).push(t);
      quads[(cz >> 2) * 2 + (cx >> 2)].push(t);
      if (si < 4 && t[5] < 0.62) far.push(t);
    }
    const l0off = new Int32Array(65);
    const l0y = new Float32Array(128);
    const l0 = [];
    for (let c = 0; c < 64; c++) {
      l0off[c] = l0.length;
      let lo = Infinity, hi = -Infinity;
      for (const t of cells.get(c) || []) {
        l0.push(t);
        if (t[1] < lo) lo = t[1];
        if (t[1] > hi) hi = t[1];
      }
      l0y[c * 2] = lo;
      l0y[c * 2 + 1] = hi;
    }
    l0off[64] = l0.length;
    const byRank = (a, b) => a[5] - b[5];
    const l1off = new Int32Array(5);
    const l1y = new Float32Array(8);
    const l1 = [];
    for (let q = 0; q < 4; q++) {
      l1off[q] = l1.length;
      let lo = Infinity, hi = -Infinity;
      for (const t of quads[q]) {
        if (t[1] < lo) lo = t[1];
        if (t[1] > hi) hi = t[1];
      }
      l1y[q * 2] = lo;
      l1y[q * 2 + 1] = hi;
      if (si === 5) continue; // shrubs only render up close
      for (const t of quads[q].sort(byRank)) l1.push(t);
    }
    l1off[4] = l1.length;
    far.sort(byRank);
    return { l0: flat(l0), l0off, l0y, l1: flat(l1), l1off, l1y, l2: flat(far) };
  });
  // rocks grouped in 200 m cells (4 x 4)
  const rc = Array.from({ length: 16 }, () => []);
  for (const t of rocks) rc[clamp(Math.floor((t[2] - bz0) / 200), 0, 3) * 4 + clamp(Math.floor((t[0] - bx0) / 200), 0, 3)].push(t);
  const rockOff = new Int32Array(17);
  const flatRocks = [];
  for (let c = 0; c < 16; c++) {
    rockOff[c] = flatRocks.length;
    for (const t of rc[c]) flatRocks.push(t);
  }
  rockOff[16] = flatRocks.length;
  let ymin = Infinity, ymax = -Infinity;
  for (const l of lists) for (const t of l) { if (t[1] < ymin) ymin = t[1]; if (t[1] > ymax) ymax = t[1]; }
  for (const t of rocks) { if (t[1] < ymin) ymin = t[1]; if (t[1] > ymax) ymax = t[1]; }
  return { bx0, bz0, species, rocks: flat(flatRocks), rockOff, ymin, ymax };
}

function flat(list) {
  const a = new Float32Array(list.length * STRIDE);
  for (let i = 0; i < list.length; i++) a.set(list[i], i * STRIDE);
  return a;
}

export function blockBuffers(b) {
  const bufs = [b.rocks.buffer, b.rockOff.buffer];
  for (const s of b.species) if (s) bufs.push(s.l0.buffer, s.l0off.buffer, s.l0y.buffer, s.l1.buffer, s.l1off.buffer, s.l1y.buffer, s.l2.buffer);
  return bufs;
}
