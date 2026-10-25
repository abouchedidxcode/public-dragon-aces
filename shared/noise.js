// Seeded 2D simplex noise (Gustavson / Ashima formulation), deterministic across client, worker and server.
import { rng } from './math.js';

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const GRAD = new Float32Array([1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 0, 1, 0, -1]);

export function createNoise(seed) {
  const r = rng(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(512);
  const pm8 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255];
    pm8[i] = (perm[i] & 7) * 2;
  }

  // returns roughly [-1, 1]
  function simplex(xin, yin) {
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    let i1, j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = pm8[ii + perm[jj]];
      t0 *= t0;
      n += t0 * t0 * (GRAD[g] * x0 + GRAD[g + 1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = pm8[ii + i1 + perm[jj + j1]];
      t1 *= t1;
      n += t1 * t1 * (GRAD[g] * x1 + GRAD[g + 1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = pm8[ii + 1 + perm[jj + 1]];
      t2 *= t2;
      n += t2 * t2 * (GRAD[g] * x2 + GRAD[g + 1] * y2);
    }
    return 70 * n;
  }

  function fbm(x, y, octaves, lacunarity = 2.03, gain = 0.5) {
    let sum = 0, amp = 0.5, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * simplex(x, y);
      norm += amp;
      x = x * lacunarity + 17.3;
      y = y * lacunarity - 9.1;
      amp *= gain;
    }
    return sum / norm;
  }

  // ridged multifractal in [0, 1]: sharp crests, eroded-looking flanks
  function ridged(x, y, octaves) {
    let sum = 0, amp = 0.5, norm = 0, prev = 1;
    for (let o = 0; o < octaves; o++) {
      let n = 1 - Math.abs(simplex(x, y));
      n *= n;
      sum += n * amp * prev;
      norm += amp;
      prev = n;
      x = x * 2.07 + 31.7;
      y = y * 2.07 - 12.9;
      amp *= 0.5;
    }
    return sum / norm;
  }

  return { simplex, fbm, ridged };
}
