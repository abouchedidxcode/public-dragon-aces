// Citadel worker: builds the castle's geometry (three detail levels) and its light volume (sun, occlusion, rain
// exposure in a 3D texture) and returns typed arrays, so none of this touches the main thread's frame time.
//   { type: 'build', sun: [x, y, z] }  ->  { type: 'volume', data, nx, ny, nz }
//                                           { type: 'group', lod, id, pos, nrm, uv, dat, idx, bounds }  (many)
//                                           { type: 'inst', ... }  then { type: 'done', ms }
import { createWorld } from '../../shared/world.js';
import { WORLD } from '../../shared/constants.js';
import { CASTLE } from '../../shared/castle.js';
import { MeshBuilder } from './render/castle-geo.js';
import { buildCastle, buildFloor, chainLinks } from './render/castle-geo-struct.js';
import { Voxels, buildLightVolume, probe } from './render/castle-bake.js';

function pack(mb) {
  const n = mb.n;
  const pos = mb.pos.slice(0, n * 3);
  const nrm = new Int8Array(n * 3);
  for (let i = 0; i < n * 3; i++) nrm[i] = Math.round(Math.max(-1, Math.min(1, mb.nrm[i])) * 127);
  const uv = mb.uv.slice(0, n * 2);
  const dat = mb.dat.slice(0, n * 4);
  const idx = n > 65535 ? mb.idx.slice(0, mb.ni) : Uint16Array.from(mb.idx.subarray(0, mb.ni));
  let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const bounds = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2];
  return { pos, nrm, uv, dat, idx, bounds, tris: mb.ni / 3 };
}

function transfer(o) {
  return [o.pos.buffer, o.nrm.buffer, o.uv.buffer, o.dat.buffer, o.idx.buffer];
}

onmessage = (e) => {
  const m = e.data;
  if (m.type !== 'build') return;
  const t0 = performance.now();
  const sun = m.sun;
  const world = createWorld(WORLD.seed);
  const vox = new Voxels(world);
  postMessage({ type: 'progress', what: 'voxels', ms: performance.now() - t0 });
  {
    const v = buildLightVolume(vox, sun);
    postMessage({ type: 'volume', ...v }, [v.data.buffer]);
    postMessage({ type: 'progress', what: 'volume', ms: performance.now() - t0 });
  }
  const out = [1, 1, 1];
  const stats = { tris: [0, 0, 0], verts: [0, 0, 0] };
  let ctx0 = null;
  for (const lod of [2, 1, 0]) {
    const { groups, ctx } = buildCastle(lod);
    if (lod === 0) ctx0 = ctx;
    const far = lod === 2 ? new MeshBuilder() : null;
    for (const [id, mb] of groups) {
      stats.tris[lod] += mb.ni / 3;
      stats.verts[lod] += mb.n;
      const p = pack(mb);
      postMessage({ type: 'group', lod, id, ...p }, transfer(p));
      if (far) {
        // the far silhouette is the level-2 groups merged into one draw call
        far.grow(mb.n, mb.ni);
        const base = far.n;
        far.pos.set(mb.pos.subarray(0, mb.n * 3), base * 3);
        far.nrm.set(mb.nrm.subarray(0, mb.n * 3), base * 3);
        far.uv.set(mb.uv.subarray(0, mb.n * 2), base * 2);
        far.dat.set(mb.dat.subarray(0, mb.n * 4), base * 4);
        for (let i = 0; i < mb.ni; i++) far.idx[far.ni + i] = mb.idx[i] + base;
        far.n += mb.n;
        far.ni += mb.ni;
      }
    }
    if (far) {
      const p = pack(far);
      postMessage({ type: 'group', lod: 3, id: 'far', ...p }, transfer(p));
    }
    postMessage({ type: 'progress', what: 'lod' + lod, ms: performance.now() - t0 });
  }
  // courtyard floor
  {
    const mb = new MeshBuilder();
    buildFloor(mb);
    const p = pack(mb);
    postMessage({ type: 'group', lod: -1, id: 'floor', ...p }, transfer(p));
  }
  // instances: windows and banners carry their own probed sun and occlusion; the stone parts read the volume
  const bakeList = (list, stride, nrm) => {
    const n = (list.length / stride) | 0;
    const bake = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const x = list[i * stride], y = list[i * stride + 1], z = list[i * stride + 2];
      const [nx, ny, nz] = nrm(list, i * stride);
      probe(vox, x, y + 1, z, nx, ny, nz, sun, out);
      bake[i * 4] = Math.round(out[0] * 255);
      bake[i * 4 + 1] = Math.round(out[1] * 255);
      bake[i * 4 + 2] = Math.round(out[2] * 255);
      bake[i * 4 + 3] = 255;
    }
    return bake;
  };
  const flat = (arrs, stride) => {
    const f = new Float32Array(arrs.length * stride);
    arrs.forEach((a, i) => f.set(a, i * stride));
    return f;
  };
  const merlons = flat(ctx0.merlons, 7);
  const windows = flat(ctx0.windows, 8);
  const banners = flat(ctx0.banners, 8);
  const braziers = flat(ctx0.braziers, 4);
  const gargoyles = flat(ctx0.gargoyles, 7);
  const chains = ctx0.chains.map((c) => chainLinks(c));
  const nLinks = chains.reduce((a, c) => a + c.length / 8, 0);
  const links = new Float32Array(nLinks * 8);
  let o = 0;
  for (const c of chains) { links.set(c, o); o += c.length; }
  const inst = {
    type: 'inst',
    merlons,
    windows, windowBake: bakeList(windows, 8, (l, i) => [Math.cos(l[i + 3]), 0, Math.sin(l[i + 3])]),
    banners, bannerBake: bakeList(banners, 8, (l, i) => [Math.cos(l[i + 3]), 0, Math.sin(l[i + 3])]),
    braziers,
    gargoyles,
    links,
  };
  const tr = [];
  for (const k of ['merlons', 'windows', 'windowBake', 'banners', 'bannerBake', 'braziers', 'gargoyles', 'links']) tr.push(inst[k].buffer);
  postMessage(inst, tr);
  postMessage({ type: 'done', ms: performance.now() - t0, stats });
};
