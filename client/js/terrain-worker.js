// Terrain worker: evaluates the shared height function off the main thread.
//   { type: 'global', n, sun }      -> { type: 'global', data: Float32Array(n*n*4) }  RGBA = height, shadow height, AO, 0
//   { type: 'chunk', key, x0, z0, size, res } -> { type: 'chunk', key, pos, nrm, minY, maxY }
//   { type: 'flora', key, x0, z0 }  -> { type: 'flora', key, block }   trees / shrubs / palms / rocks for one 800 m block
// (global also returns `mask`, RGBA8: forest, stream, conifer share, rockiness; see render/flora-model.js)
import { createWorld } from '../../shared/world.js';
import { WORLD } from '../../shared/constants.js';
import { createFlora, blockBuffers } from './render/flora-model.js';
import { CASTLE, topAt } from '../../shared/castle.js';

const world = createWorld(WORLD.seed);
const flora = createFlora(world);
const SKIRT = 40;

function globalData(n, sun) {
  const half = WORLD.terrainHalf;
  const cell = (half * 2) / (n - 1);
  const h = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const z = -half + j * cell;
    for (let i = 0; i < n; i++) h[j * n + i] = world.height(-half + i * cell, z);
  }
  // the sun-shadow march sees the Citadel's towers as part of the land (a 600 m spire throws a long shadow)
  const hs = h.slice();
  {
    const r = CASTLE.radius + 20;
    const i0 = Math.max(0, Math.floor((CASTLE.x - r + half) / cell)), i1 = Math.min(n - 1, Math.ceil((CASTLE.x + r + half) / cell));
    const j0 = Math.max(0, Math.floor((CASTLE.z - r + half) / cell)), j1 = Math.min(n - 1, Math.ceil((CASTLE.z + r + half) / cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const top = topAt(-half + i * cell, -half + j * cell, 5);
        if (top > hs[j * n + i]) hs[j * n + i] = top;
      }
    }
  }
  const at = (x, z) => {
    // bilinear lookup in the grid (world coords)
    const fx = (x + half) / cell, fz = (z + half) / cell;
    const i = Math.max(0, Math.min(n - 2, Math.floor(fx))), j = Math.max(0, Math.min(n - 2, Math.floor(fz)));
    const tx = Math.min(1, Math.max(0, fx - i)), tz = Math.min(1, Math.max(0, fz - j));
    const a = hs[j * n + i], b = hs[j * n + i + 1], c = hs[(j + 1) * n + i], d = hs[(j + 1) * n + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  };
  // shadow height: a point is sunlit if it is above the highest sun ray that grazes the terrain toward the sun
  const hl = Math.hypot(sun[0], sun[2]);
  const dx = sun[0] / hl, dz = sun[2] / hl, rise = sun[1] / hl;
  const out = new Float32Array(n * n * 4);
  const step = cell * 1.5;
  for (let j = 0; j < n; j++) {
    const z = -half + j * cell;
    for (let i = 0; i < n; i++) {
      const x = -half + i * cell;
      const h0 = h[j * n + i];
      let sh = -1000;
      for (let s = step; s < 3000; s += step * (1 + s / 2000)) {
        const px = x + dx * s, pz = z + dz * s;
        if (Math.abs(px) > half || Math.abs(pz) > half) break;
        const v = at(px, pz) - s * rise;
        if (v > sh) sh = v;
        if (1150 - s * rise < sh) break; // nothing further along can rise above the current ray
      }
      const k = (j * n + i) * 4;
      out[k] = h0;
      out[k + 1] = sh;
    }
  }
  // ambient occlusion from local concavity (height below the average of a ring around the point)
  const R = [2, 5, 10];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const h0 = h[j * n + i];
      let occ = 0;
      for (const r of R) {
        let sum = 0;
        for (const [a, b] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
          const ii = Math.max(0, Math.min(n - 1, i + a)), jj = Math.max(0, Math.min(n - 1, j + b));
          sum += Math.max(0, h[jj * n + ii] - h0) / (r * cell * (a && b ? 1.414 : 1));
        }
        occ += sum / 8;
      }
      out[(j * n + i) * 4 + 2] = Math.max(0.35, 1 - occ * 0.55);
    }
  }
  return { out, h };
}

function chunk(x0, z0, size, res) {
  const vn = res + 1;
  const count = vn * vn + vn * 4;
  const pos = new Float32Array(count * 3);
  const nrm = new Float32Array(count * 3);
  const cell = size / res;
  // sample a 1-cell border so normals are continuous across chunks
  const bn = vn + 2;
  const hb = new Float32Array(bn * bn);
  for (let j = 0; j < bn; j++) for (let i = 0; i < bn; i++) hb[j * bn + i] = world.height(x0 + (i - 1) * cell, z0 + (j - 1) * cell);
  let minY = Infinity, maxY = -Infinity;
  for (let j = 0; j < vn; j++) {
    for (let i = 0; i < vn; i++) {
      const k = j * vn + i;
      const y = hb[(j + 1) * bn + i + 1];
      pos[k * 3] = x0 + i * cell;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = z0 + j * cell;
      const hx = hb[(j + 1) * bn + i + 2] - hb[(j + 1) * bn + i];
      const hz = hb[(j + 2) * bn + i + 1] - hb[j * bn + i + 1];
      const nx = -hx, ny = 2 * cell, nz = -hz;
      const l = Math.hypot(nx, ny, nz);
      nrm[k * 3] = nx / l;
      nrm[k * 3 + 1] = ny / l;
      nrm[k * 3 + 2] = nz / l;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  // skirts: copies of the four edges pushed down, hiding cracks between LODs
  let k = vn * vn;
  const edge = (i, j) => {
    const s = j * vn + i;
    pos[k * 3] = pos[s * 3];
    pos[k * 3 + 1] = pos[s * 3 + 1] - SKIRT;
    pos[k * 3 + 2] = pos[s * 3 + 2];
    nrm[k * 3] = nrm[s * 3];
    nrm[k * 3 + 1] = nrm[s * 3 + 1];
    nrm[k * 3 + 2] = nrm[s * 3 + 2];
    k++;
  };
  for (let i = 0; i < vn; i++) edge(i, 0);
  for (let i = 0; i < vn; i++) edge(i, res);
  for (let j = 0; j < vn; j++) edge(0, j);
  for (let j = 0; j < vn; j++) edge(res, j);
  return { pos, nrm, minY: minY - SKIRT, maxY };
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'global') {
    const { out: data, h } = globalData(m.n, m.sun);
    const mask = flora.raster(h, m.n, WORLD.terrainHalf);
    self.postMessage({ type: 'global', data, mask }, [data.buffer, mask.buffer]);
  } else if (m.type === 'flora') {
    const block = flora.block(m.x0, m.z0);
    self.postMessage({ type: 'flora', key: m.key, block }, blockBuffers(block));
  } else if (m.type === 'chunk') {
    const c = chunk(m.x0, m.z0, m.size, m.res);
    self.postMessage({ type: 'chunk', key: m.key, ...c }, [c.pos.buffer, c.nrm.buffer]);
  }
};
