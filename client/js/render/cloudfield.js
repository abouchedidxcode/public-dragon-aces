// The cloud field: where the clouds are, shared by the renderer (raymarched in clouds.js) and by gameplay
// (Clouds.density(): hiding from radar, whiteout). Two cumulus layers are described by a tiling 2D weather map:
// for each layer the map stores the cloud *thickness* above a gently wavy flat base. A cloud column's macro density
// is a vertical profile (flat base, domed top) of height-in-column, so the CPU and the shader evaluate exactly the
// same macro shape; the shader then erodes it with 3D noise for the puffy detail.
import { rng } from '../../../shared/math.js';
import { WORLD } from '../../../shared/constants.js';

export const CF = {
  tile: 16384, // m: the weather map repeats every `tile` metres (the arena is 4.4 km across; 16 km never shows a repeat)
  res: 1024, // texels per side (16 m / texel)
  // A: towering cumulus layer (tops out around the 1.7 km ceiling), B: low banks that drift between the mountains
  layers: [
    { base: 1050, wobble: 170, maxThick: 640 },
    { base: 520, wobble: 110, maxThick: 300 },
  ],
  // clouds are drawn smaller than they were over the 8 km arena, with proportionally more of them per km2
  scale: 0.7,
};

// uniform object shared with every shader that reads the weather map (filled in by Clouds)
export const CLOUD_TEX = { value: null };

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// tileable value noise on a lattice of `n` cells (used for base-height wobble and coverage patches)
function makeNoise(seed, n) {
  const r = rng(seed);
  const g = new Float32Array(n * n);
  for (let i = 0; i < g.length; i++) g[i] = r();
  return (u, v) => {
    const fx = (((u % 1) + 1) % 1) * n, fy = (((v % 1) + 1) % 1) * n;
    const i = Math.floor(fx), j = Math.floor(fy);
    const tx = fx - i, ty = fy - j;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const at = (a, b) => g[(b % n) * n + (a % n)];
    return (at(i, j) * (1 - sx) + at(i + 1, j) * sx) * (1 - sy) + (at(i, j + 1) * (1 - sx) + at(i + 1, j + 1) * sx) * sy;
  };
}

// Builds the weather map: Float32Array(res*res*4) = thickness A, thickness B, base offset A, base offset B.
export function buildWeather(seed = WORLD.seed + 5) {
  const { tile, res, layers } = CF;
  const K = CF.scale;
  const data = new Float32Array(res * res * 4);
  const texel = tile / res;
  const wob = [makeNoise(seed + 1, 4), makeNoise(seed + 2, 4)];
  const patch = [makeNoise(seed + 3, 6), makeNoise(seed + 4, 5)];
  // base offsets (smooth, tiling)
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const k = (j * res + i) * 4;
      for (let l = 0; l < 2; l++) data[k + 2 + l] = (wob[l](i / res, j / res) * 2 - 1) * layers[l].wobble;
    }
  }
  const r = rng(seed);
  const randn = () => { let u = 0; for (let i = 0; i < 4; i++) u += r(); return (u - 2) * 1.73; }; // ~N(0, 1)
  const addLobe = (l, cx, cz, rx, rz, rot, H, dome = 0.5) => {
    const reach = Math.max(rx, rz) * 1.02;
    const i0 = Math.floor((cx - reach) / texel), i1 = Math.ceil((cx + reach) / texel);
    const j0 = Math.floor((cz - reach) / texel), j1 = Math.ceil((cz + reach) / texel);
    const c = Math.cos(rot), s = Math.sin(rot);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dx = i * texel - cx, dz = j * texel - cz;
        const x = (dx * c + dz * s) / rx, z = (-dx * s + dz * c) / rz;
        const q = x * x + z * z;
        if (q >= 1) continue;
        const t = H * (dome === 0.5 ? Math.sqrt(1 - q) : Math.pow(1 - q, dome));
        const ii = ((i % res) + res) % res, jj = ((j % res) + res) % res;
        const k = (jj * res + ii) * 4 + l;
        // smooth union: p-norm blend so touching lobes merge into one cauliflower
        const cur = data[k];
        data[k] = cur <= 0 ? t : Math.cbrt(cur * cur * cur + t * t * t);
      }
    }
  };
  // a cloud: a main lobe plus a ring of smaller ones, so the outline is never an ellipse
  const cloud = (l, cx, cz, R, H, flat) => {
    const ex = 0.7 + r() * 0.6;
    const rot = r() * Math.PI;
    const rx = R * ex, rz = R / ex;
    const dome = flat ? 0.38 : 0.5;
    addLobe(l, cx, cz, rx, rz, rot, H * (flat ? 0.5 : 0.55), dome);
    const n = Math.round(4 + R / 90 * (flat ? 0.8 : 1.3));
    const c = Math.cos(rot), s = Math.sin(rot);
    for (let i = 0; i < n; i++) {
      const th = r() * Math.PI * 2, rr = Math.sqrt(r()) * 0.72;
      const ox = Math.cos(th) * rr * rx, oz = Math.sin(th) * rr * rz;
      const lr = R * (0.32 + r() * 0.34);
      const hh = H * (flat ? 0.4 + r() * 0.5 : 0.5 + r() * 0.55) * (1 - rr * 0.45);
      addLobe(l, cx + ox * c - oz * s, cz + ox * s + oz * c, lr * ex, lr / ex, r() * Math.PI, hh, dome);
    }
  };
  // a whole cluster lifts or sinks its base a little, so groups sit at different heights
  const lift = (l, cx, cz, rad, amount) => {
    const i0 = Math.floor((cx - rad) / texel), i1 = Math.ceil((cx + rad) / texel);
    const j0 = Math.floor((cz - rad) / texel), j1 = Math.ceil((cz + rad) / texel);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const q = ((i * texel - cx) ** 2 + (j * texel - cz) ** 2) / (rad * rad);
        if (q >= 1) continue;
        const ii = ((i % res) + res) % res, jj = ((j % res) + res) % res;
        data[(jj * res + ii) * 4 + 2 + l] += amount * (1 - q) * (1 - q);
      }
    }
  };
  // Clusters, not a grid: dense groups of mixed cumulus with a big merged core, long flat banks, sparse fair-weather
  // scatter, and open sky between them. Heights, thickness and base all vary per cluster.
  const clusters = [31, 15];
  for (let l = 0; l < 2; l++) {
    const maxT = layers[l].maxThick;
    const low = l === 1;
    for (let c = 0; c < clusters[l]; c++) {
      const cx = (r() - 0.5) * tile, cz = (r() - 0.5) * tile;
      const roll = r();
      const tall = 0.5 + r() * 0.95; // how towering this cluster is
      const lf = (r() - 0.5) * (low ? 120 : 190);
      if (roll < 0.2) {
        // bank: a long, merged, flat-topped band
        const len = (3000 + r() * 4200) * K, ang = r() * Math.PI, ca = Math.cos(ang), sa = Math.sin(ang);
        const n = 14 + Math.floor(r() * 14);
        lift(l, cx, cz, len * 0.7, lf);
        for (let i = 0; i < n; i++) {
          const t = (i / (n - 1) - 0.5) * len + randn() * 120, lat = randn() * len * 0.07;
          const R = ((low ? 380 : 300) + r() * (low ? 420 : 380)) * K;
          const H = Math.min(maxT, (low ? 180 + r() * 260 : 190 + r() * 330 * tall));
          cloud(l, cx + t * ca - lat * sa, cz + t * sa + lat * ca, R, H, true);
        }
      } else if (roll < 0.8) {
        // group: a few big towers around a core, smaller satellites and flat-bottomed fillers
        const Rc = (1100 + r() * 2300) * K;
        const n = 6 + Math.floor(r() * 11);
        lift(l, cx, cz, Rc * 1.4, lf);
        for (let i = 0; i < n; i++) {
          const d = Math.abs(randn()) * Rc * 0.42;
          const th = r() * Math.PI * 2;
          const near = 1 - Math.min(1, d / Rc);
          const size = ((low ? 330 : 190) * (0.7 + r()) + r() * r() * (low ? 600 : 760) * (0.4 + near)) * K;
          const H = Math.min(maxT * 0.97, size * (low ? 0.6 + r() * 0.5 : (0.7 + r() * 0.9) * tall * (0.6 + near * 0.8)));
          cloud(l, cx + Math.cos(th) * d, cz + Math.sin(th) * d, size, H, low || r() < 0.18);
        }
      } else {
        // sparse fair-weather scatter
        const Rc = (1400 + r() * 1800) * K;
        const n = 2 + Math.floor(r() * 4);
        for (let i = 0; i < n; i++) {
          const d = Math.sqrt(r()) * Rc, th = r() * Math.PI * 2;
          const size = ((low ? 280 : 150) + r() * (low ? 300 : 220)) * K;
          cloud(l, cx + Math.cos(th) * d, cz + Math.sin(th) * d, size, Math.min(maxT, size * (0.5 + r() * 0.5)), low);
        }
      }
    }
  }
  for (let i = 0; i < res * res; i++) {
    data[i * 4] = Math.min(layers[0].maxThick, data[i * 4]);
    data[i * 4 + 1] = Math.min(layers[1].maxThick, data[i * 4 + 1]);
  }
  return data;
}

// macro density profile of a column (same formula as the GLSL below)
export function layerMacro(y, base, thick) {
  const h = (y - base) / Math.max(thick, 1);
  if (h <= 0 || h >= 1) return 0;
  const bottom = smooth(0, 0.1, h);
  const top = 1 - smooth(0.6, 1, h);
  return bottom * top * smooth(10, 240, thick);
}

export const MACRO_GLSL = /* glsl */ `
const float CF_TILE = ${CF.tile.toFixed(1)};
const vec2 CF_BASE = vec2(${CF.layers[0].base.toFixed(1)}, ${CF.layers[1].base.toFixed(1)});
float cfLayerMacro(float y, float base, float thick) {
  float h = (y - base) / max(thick, 1.0);
  if (h <= 0.0 || h >= 1.0) return 0.0;
  return smoothstep(0.0, 0.1, h) * (1.0 - smoothstep(0.6, 1.0, h)) * smoothstep(10.0, 240.0, thick);
}`;

// CPU sampler of the weather map with the same bilinear filtering the GPU does
export class WeatherField {
  constructor(data) {
    this.data = data;
    this.res = CF.res;
    this.wx = 0;
    this.wz = 0; // wind offset (m): the whole field drifts
  }

  // -> out = [thickA, thickB, baseOffA, baseOffB]
  column(x, z, out) {
    const { res, data } = this;
    const fx = (((x - this.wx) / CF.tile) % 1 + 1) % 1 * res - 0.5, fz = (((z - this.wz) / CF.tile) % 1 + 1) % 1 * res - 0.5;
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const i0 = (i + res) % res, i1 = (i + 1 + res) % res, j0 = (j + res) % res, j1 = (j + 1 + res) % res;
    const a = (j0 * res + i0) * 4, b = (j0 * res + i1) * 4, c = (j1 * res + i0) * 4, d = (j1 * res + i1) * 4;
    for (let k = 0; k < 4; k++) {
      out[k] = (data[a + k] * (1 - tx) + data[b + k] * tx) * (1 - tz) + (data[c + k] * (1 - tx) + data[d + k] * tx) * tz;
    }
    return out;
  }

  // 0..1 how deep inside a cloud the point is (macro profile, ramped so that thin edges read as clear air)
  density(x, y, z) {
    const o = this._o || (this._o = [0, 0, 0, 0]);
    this.column(x, z, o);
    const m = Math.max(
      layerMacro(y, CF.layers[0].base + o[2], o[0]),
      layerMacro(y, CF.layers[1].base + o[3], o[1]),
    );
    return smooth(0.3, 0.7, m);
  }
}
